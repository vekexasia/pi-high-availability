/**
 * High Availability Provider Extension for Pi
 */

import type { Model, TextContent } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import type { CustomEntry } from "@mariozechner/pi-coding-agent";
import { chmodSync, readFileSync, writeFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";
import lockfile from "proper-lockfile";
import {
  ensureCredentialMeta,
  getCredentialNames,
  getDefaultCredentialName,
  isCredentialEntryKey,
  isReservedCredentialName,
  normalizeCredentialProviders,
  setDefaultCredentialName,
  type ProviderCredentials,
} from "./credentialMeta";
import {
  classifyError,
  countActiveExhausted,
  determineCredentialType,
  determineNewCredentialName,
  findMatchingCredentialName,
  getCredentialExhaustionKey,
  getEntryExhaustionKey,
  getCurrentGroupEntry,
  isExhausted as isExhaustedCore,
  markExhausted as markExhaustedCore,
  mergeConfigFromDisk,
  pickCredentialForProvider as pickCredentialForProviderCore,
  resolveGroupEntryModel,
  type ErrorAction,
  type ExhaustionEntry,
  type HaConfig,
  type HaGroup,
  type HaGroupEntry,
} from "./ha-core";

/** Shape of ~/.pi/agent/auth.json — maps provider ID to credential data. */
type AuthJson = Record<string, Record<string, unknown>>;

/** Shape of the ha-state custom session entry data. */
interface HaStateData {
  activeGroup?: string;
  exhausted?: Record<string, ExhaustionEntry>;
  activeCredential?: Record<string, string>;
}

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "ha.json");
const AUTH_PATH = join(AGENT_DIR, "auth.json");

/** Lock options compatible with pi-agent-core's auth-storage locking. */
const LOCK_OPTS = {
  retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10000, randomize: true },
  stale: 30000,
  realpath: false,
};

async function ensureJsonFile(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, "{}", { encoding: "utf-8", mode: 0o600, flag: "wx" });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") throw err;
  }
}

/**
 * Atomic read-modify-write with file locking.
 * `fn` receives the current file content and returns an optional new content to write.
 */
async function withFileLock<T>(
  filePath: string,
  fn: (raw: string) => Promise<{ raw?: string; result: T }>,
): Promise<T> {
  await ensureJsonFile(filePath);
  const release = await lockfile.lock(filePath, LOCK_OPTS);
  try {
    const current = await readFile(filePath, "utf-8").catch(() => "{}");
    const { raw, result } = await fn(current);
    if (raw !== undefined) {
      await writeFile(filePath, raw, { encoding: "utf-8", mode: 0o600 });
    }
    return result;
  } finally {
    await release();
  }
}

// Module-level hook — assigned inside export default once `pi` is available,
// so switchCred() can call it without needing `pi` in its own scope.
let persistState: () => void = () => {};
let lastPersistedJson = "";

const state = {
  activeGroup: null as string | null,
  exhausted: new Map<string, ExhaustionEntry>(),
  isRetrying: false,
  activeCredential: new Map<string, string>(),
  retryTimeoutId: null as NodeJS.Timeout | null,
  lastStatusModel: null as { provider: string; id: string } | null,
  lastStatusUI: null as ExtensionUIContext | null,
  retriesThisTurn: 0,
};

function updateStatusBar(ctx?: ExtensionContext) {
  if (ctx?.ui) state.lastStatusUI = ctx.ui;
  if (ctx !== undefined) {
    state.lastStatusModel = ctx.model
      ? { provider: ctx.model.provider, id: ctx.model.id }
      : null;
  }

  const ui = state.lastStatusUI;
  if (!ui) return;

  const group = state.activeGroup || "none";
  const model = state.lastStatusModel ? `${state.lastStatusModel.provider}/${state.lastStatusModel.id}` : "?";
  const exhaustedCount = countActiveExhausted(state.exhausted);
  const exhaustedStr = exhaustedCount > 0 ? ` | ${exhaustedCount} exhausted` : "";
  ui.setStatus("ha", `HA: ${group} (${model})${exhaustedStr}`);
}

function getHaGroupUsageHint(ctx?: ExtensionContext): string {
  const currentModel = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : "<provider/model-id>";
  return [
    "Usage: /ha-group <name> <provider/model-id> [provider/model-id ...]",
    "Tip: run /model and copy the exact provider/model IDs you want in failover order.",
    `Example: /ha-group default ${currentModel} <fallback-provider/model-id>`,
  ].join("\n");
}

function getHaSetupHint(ctx?: ExtensionContext): string {
  return [
    "[HA] Setup:",
    "  1. /login once per provider/account you want HA to use",
    "  2. /model to inspect exact provider/model IDs",
    `  3. ${getHaGroupUsageHint(ctx).split("\n").at(-1)}`,
    "  4. /ha to inspect active group, credentials, and exhaustion state",
  ].join("\n");
}

let config: HaConfig | null = null;

async function loadAuthJson(): Promise<AuthJson> {
  try { return JSON.parse(await readFile(AUTH_PATH, "utf-8")) as AuthJson; }
  catch { return {}; }
}

function reloadConfigFromDisk(): void {
  try {
    const fresh = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as HaConfig;
    if (!config) {
      config = fresh;
      return;
    }
    config = mergeConfigFromDisk(config, fresh);
  } catch {
    // Silently ignore — stale config is better than crashing
  }
}

async function saveConfig(cfg: HaConfig): Promise<void> {
  normalizeCredentialProviders(cfg.credentials);
  config = cfg;
  await withFileLock(CONFIG_PATH, async (raw) => {
    // Merge credentials from disk so we don't clobber another instance's additions
    try {
      const disk = JSON.parse(raw) as HaConfig;
      if (disk.credentials && config!.credentials) {
        for (const [provider, diskCreds] of Object.entries(disk.credentials)) {
          if (!config!.credentials[provider]) {
            config!.credentials[provider] = structuredClone(diskCreds);
            continue;
          }
          const target = config!.credentials[provider];
          for (const [name, value] of Object.entries(diskCreds)) {
            if (name === "__meta") continue;
            if (!Object.prototype.hasOwnProperty.call(target, name)) {
              target[name] = structuredClone(value);
            }
          }
        }
      }
    } catch {
      // Disk parse failed — write our config as-is
    }
    return { raw: JSON.stringify(config, null, 2), result: undefined };
  });
}

function syncAuthToHa(auth: AuthJson, ctx?: ExtensionContext): boolean {
  if (!config) return false;
  if (!config.credentials) config.credentials = {};
  let changed = false;

  for (const [providerId, creds] of Object.entries(auth)) {
    if (!config.credentials[providerId]) config.credentials[providerId] = {};
    const stored = config.credentials[providerId];
    ensureCredentialMeta(stored);

    const foundName = findMatchingCredentialName(stored, creds);

    if (!foundName) {
      const existingNames = getCredentialNames(stored);
      const name = determineNewCredentialName(existingNames);
      const newCred = structuredClone(creds);
      const credType = determineCredentialType(creds);
      if (credType) newCred.type = credType;

      stored[name] = newCred;
      if (existingNames.length === 0) {
        setDefaultCredentialName(stored, name);
      }
      changed = true;

      const msg =
        existingNames.length === 0
          ? `[HA] Credential synced for ${providerId} as '${name}'.`
          : `[HA] New credential synced for ${providerId} as '${name}'. Use /ha-rename ${providerId} ${name} <name> to rename it.`;

      if (ctx?.ui) {
        ctx.ui.notify(msg, "info");
      } else {
        console.log(msg);
      }
      state.activeCredential.set(providerId, name);
    } else {
      ensureCredentialMeta(stored);
      state.activeCredential.set(providerId, foundName);
    }
  }
  return changed;
}

/**
 * Freshen the active ha.json credential entry with the latest tokens from auth.json.
 * Called on every turn_start so that pi's silently-refreshed OAuth tokens are never stale in ha.json.
 */
async function syncActiveCredentialFromAuth(): Promise<boolean> {
  if (!config?.credentials) return false;
  const auth = await loadAuthJson();
  let changed = false;

  for (const [providerId, currentAuth] of Object.entries(auth)) {
    const stored = config.credentials[providerId];
    if (!stored) continue;

    const activeName = state.activeCredential.get(providerId);
    if (!activeName || !stored[activeName]) continue;

    // Overwrite token fields with fresh data; preserve our metadata fields (type)
    const fresh = structuredClone(currentAuth);
    const existing = stored[activeName];
    const merged = { ...existing, ...fresh };
    if (existing.type) merged.type = existing.type;

    if (JSON.stringify(existing) !== JSON.stringify(merged)) {
      stored[activeName] = merged;
      changed = true;
    }
  }

  if (changed) await saveConfig(config!);
  return changed;
}

async function switchCred(providerId: string, name: string, ctx?: ExtensionContext): Promise<boolean> {
  const stored = config?.credentials?.[providerId];
  if (!stored || !Object.prototype.hasOwnProperty.call(stored, name) || !isCredentialEntryKey(name)) return false;

  // Strip HA-internal metadata before writing to auth.json
  // Keep `type` — authStorage.getApiKey() needs it to identify oauth vs api_key credentials
  const { __meta: _meta, ...credToSave } = structuredClone(stored[name]);

  await withFileLock(AUTH_PATH, async (raw) => {
    const auth = JSON.parse(raw) as AuthJson;
    auth[providerId] = credToSave;
    return { raw: JSON.stringify(auth, null, 2), result: undefined };
  });
  state.activeCredential.set(providerId, name);

  // Force pi to re-read auth.json into memory.
  if (ctx?.modelRegistry?.authStorage?.reload) {
    ctx.modelRegistry.authStorage.reload();
  } else if (ctx?.ui) {
    ctx.ui.notify(
      "[HA] Warning: pi's authStorage.reload() is unavailable — credential may not be active until pi restarts.",
      "warning"
    );
  }

  persistState();
  return true;
}

function updateActiveCredentialsFromAuth(auth: AuthJson) {
  if (!config?.credentials) return;

  for (const [providerId, currentAuth] of Object.entries(auth)) {
    const stored = config.credentials[providerId];
    if (!stored) continue;
    ensureCredentialMeta(stored);

    for (const [name, cred] of Object.entries(stored)) {
      if (!isCredentialEntryKey(name)) continue;

      if (currentAuth.key && currentAuth.key === cred.key) {
        state.activeCredential.set(providerId, name);
        break;
      }
      if (currentAuth.refresh && currentAuth.refresh === cred.refresh) {
        state.activeCredential.set(providerId, name);
        break;
      }
    }
  }
}

function isExhausted(key: string) {
  return isExhaustedCore(state.exhausted, key);
}

function markExhausted(key: string, cooldownMs: number) {
  markExhaustedCore(state.exhausted, key, cooldownMs);
}

function pickCredentialForProvider(providerId: string, entryId?: string) {
  return pickCredentialForProviderCore(
    providerId,
    config?.credentials,
    state.activeCredential,
    state.exhausted,
    Date.now(),
    entryId,
  );
}

export default function (pi: ExtensionAPI) {
  try {
    // Lock ha.json for the startup read-modify-write cycle
    const releaseConfig = lockfile.lockSync(CONFIG_PATH, { realpath: false, stale: 30000 });
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      try { chmodSync(CONFIG_PATH, 0o600); } catch {}
      normalizeCredentialProviders(config?.credentials);
      if (config?.defaultGroup) state.activeGroup = config.defaultGroup;

      let startupAuth: AuthJson = {};
      try { startupAuth = JSON.parse(readFileSync(AUTH_PATH, "utf-8")) as AuthJson; } catch {}

      if (syncAuthToHa(startupAuth)) {
        normalizeCredentialProviders(config!.credentials);
        writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
      }

      updateActiveCredentialsFromAuth(startupAuth);
    } finally {
      releaseConfig();
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      console.error(`[HA] Failed to load ha.json: ${err.message}`);
    }
  }

  // Serialise the three critical state fields into a custom session entry.
  persistState = () => {
    const serialized = {
      activeGroup: state.activeGroup,
      exhausted: Object.fromEntries(
        [...state.exhausted.entries()].map(([k, v]) => [k, v])
      ),
      activeCredential: Object.fromEntries(state.activeCredential),
    };
    const json = JSON.stringify(serialized);
    if (json === lastPersistedJson) return; // state unchanged — skip append
    lastPersistedJson = json;
    pi.appendEntry("ha-state", serialized);
  };

  pi.on("session_start", async (_event, ctx) => {
    // Restore persisted HA state from the most recent ha-state entry.
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === "ha-state" && entry.data) {
        const data = (entry as CustomEntry<HaStateData>).data as HaStateData;
        if (data.activeGroup) state.activeGroup = data.activeGroup;
        if (data.exhausted) {
          state.exhausted.clear();
          for (const [k, v] of Object.entries(data.exhausted)) {
            state.exhausted.set(k, v as ExhaustionEntry);
          }
        }
        if (data.activeCredential) {
          state.activeCredential.clear();
          for (const [k, v] of Object.entries(data.activeCredential)) {
            state.activeCredential.set(k, v as string);
          }
        }
        break; // Use the most recent entry only
      }
    }
    // Sync the dedup cache so the first persistState() after restore
    // doesn't append a duplicate when state hasn't actually changed.
    lastPersistedJson = JSON.stringify({
      activeGroup: state.activeGroup,
      exhausted: Object.fromEntries(
        [...state.exhausted.entries()].map(([k, v]) => [k, v])
      ),
      activeCredential: Object.fromEntries(state.activeCredential),
    });
    // NOTE: pi's SessionManager is append-only — entries cannot be removed.
    // ha-state entries will accumulate across persists. We only restore from
    // the most recent entry (searched in reverse above), so stale entries are
    // harmless but waste a small amount of session storage.
    // If SessionManager gains a removeEntry() API in the future, prune here.
    updateStatusBar(ctx);
  });

  // ─── /ha — print current status ────────────────────────────────────────────
  pi.registerCommand("ha", {
    description: "Show HA status (active group, credentials, exhaustion state)",
    handler: async (_, ctx) => {
      reloadConfigFromDisk();
      if (!config) {
        ctx.ui.notify(
          `${getHaSetupHint(ctx)}\n\nConfig file: ~/.pi/agent/ha.json`,
          "warning",
        );
        return;
      }
      const auth = await loadAuthJson();
      if (syncAuthToHa(auth, ctx)) await saveConfig(config);

      const lines: string[] = [];
      lines.push("⚠️  ha.json stores credentials in plaintext at ~/.pi/agent/ha.json — keep this file private (chmod 600).");
      lines.push(`Active Group: ${state.activeGroup || "none"}`);
      if (Object.keys(config.groups).length === 0) {
        lines.push(`\n${getHaSetupHint(ctx)}`);
      }

      // Groups
      if (Object.keys(config.groups).length > 0) {
        lines.push("\nGroups:");
        for (const [name, group] of Object.entries(config.groups)) {
          const isActive = name === state.activeGroup;
          const isDefault = name === config.defaultGroup;
          const markers = [isActive ? "active" : "", isDefault ? "default" : ""].filter(Boolean).join(", ");
          lines.push(
            `  ${isActive ? "●" : "○"} ${name} (${group.entries.length} models)${markers ? ` [${markers}]` : ""}`,
          );
          for (const entry of group.entries) {
            const exhausted = isExhausted(getEntryExhaustionKey(entry.id));
            if (exhausted) {
              const entryKey = getEntryExhaustionKey(entry.id);
              const entryData = state.exhausted.get(entryKey);
              const remainMs = entryData ? Math.max(0, entryData.cooldownMs - (Date.now() - entryData.exhaustedAt)) : 0;
              const remainMin = Math.ceil(remainMs / 60000);
              lines.push(`    - ${entry.id} ⛔ exhausted (recovers in ~${remainMin}m)`);
            } else {
              lines.push(`    - ${entry.id}`);
            }
          }
        }
      }

      // Credentials
      if (config.credentials && Object.keys(config.credentials).length > 0) {
        lines.push("\nCredentials:");
        for (const [provider, creds] of Object.entries(config.credentials)) {
          const names = getCredentialNames(creds);
          const active =
            state.activeCredential.get(provider) ||
            getDefaultCredentialName(creds) ||
            "none";
          lines.push(`  ${provider}: ${names.join(", ")} (active: ${active})`);
          for (const name of names) {
            const exhausted = isExhausted(getCredentialExhaustionKey(provider, name));
            if (exhausted) {
              const credKey = getCredentialExhaustionKey(provider, name);
              const credEntry = state.exhausted.get(credKey);
              const remainMs = credEntry ? Math.max(0, credEntry.cooldownMs - (Date.now() - credEntry.exhaustedAt)) : 0;
              const remainMin = Math.ceil(remainMs / 60000);
              lines.push(`    ⛔ ${name} exhausted (recovers in ~${remainMin}m)`);
            }
          }
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─── /ha-rename <provider> <old-name> <new-name> ────────────────────────────
  pi.registerCommand("ha-rename", {
    description: "Rename a credential: /ha-rename <provider> <old-name> <new-name>",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      if (parts.length !== 3 || !parts[0]) {
        ctx.ui.notify("Usage: /ha-rename <provider> <old-name> <new-name>", "warning");
        return;
      }
      const [provider, oldName, newName] = parts;

      if (!config?.credentials?.[provider]) {
        ctx.ui.notify(`[HA] Provider '${provider}' not found.`, "warning");
        return;
      }
      const stored = config.credentials[provider];

      if (!stored[oldName] || !isCredentialEntryKey(oldName)) {
        ctx.ui.notify(`[HA] Credential '${oldName}' not found for ${provider}.`, "warning");
        return;
      }

      if (isReservedCredentialName(newName)) {
        ctx.ui.notify(`[HA] '${newName}' is a reserved name.`, "warning");
        return;
      }

      if (getCredentialNames(stored).includes(newName)) {
        ctx.ui.notify(`[HA] Name '${newName}' already exists for ${provider}.`, "warning");
        return;
      }

      // Rebuild object preserving insertion order
      const newCreds: ProviderCredentials = {};
      for (const [k, v] of Object.entries(stored)) {
        newCreds[k === oldName ? newName : k] = v;
      }
      config.credentials[provider] = newCreds;

      // Update default name if the renamed one was default
      if (getDefaultCredentialName(stored) === oldName) {
        setDefaultCredentialName(newCreds, newName);
      } else {
        ensureCredentialMeta(newCreds);
      }

      // Update active tracking
      if (state.activeCredential.get(provider) === oldName) {
        state.activeCredential.set(provider, newName);
      }

      await saveConfig(config);
      ctx.ui.notify(`[HA] Renamed ${provider}: ${oldName} → ${newName}`, "info");
    },
  });

  // ─── /ha-group <name> <model-id1> [model-id2 ...] ──────────────────────────
  pi.registerCommand("ha-group", {
    description: "Create/update a group: /ha-group <name> <model-id1> [model-id2 ...]",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        ctx.ui.notify(getHaGroupUsageHint(ctx), "warning");
        return;
      }
      if (!config) {
        config = { groups: {}, credentials: {}, defaultCooldownMs: 3600000 };
      }
      const [name, ...modelIds] = parts;
      const entries: HaGroupEntry[] = modelIds.map((id) => ({ id }));
      config.groups[name] = { name, entries };

      // Validate model IDs and warn about unresolvable or ambiguous entries
      for (const id of modelIds) {
        if (!id.includes("/")) {
          ctx.ui.notify(
            `[HA] Warning: '${id}' is a bare provider name — use 'provider/model-id' format for deterministic failover`,
            "warning",
          );
        }
        const model = resolveGroupEntryModel(id, ctx.modelRegistry);
        if (!model) {
          ctx.ui.notify(`[HA] Warning: model '${id}' not found in registry. Use /model to copy the exact ID.`, "warning");
        }
      }

      // Set as active and default group
      state.activeGroup = name;
      config.defaultGroup = name;

      await saveConfig(config);
      persistState();
      updateStatusBar(ctx);
      ctx.ui.notify(
        `[HA] Group '${name}' set with ${entries.length} model(s): ${modelIds.join(", ")}`,
        "info",
      );
      if (!config.credentials || Object.keys(config.credentials).length === 0) {
        ctx.ui.notify(
          "[HA] No credentials synced yet. Run /login for each provider/account you want HA to use, then /ha to verify.",
          "warning",
        );
      }
    },
  });

  // ─── /ha-group-delete <name> ───────────────────────────────────────────────
  pi.registerCommand("ha-group-delete", {
    description: "Delete a group: /ha-group-delete <name>",
    handler: async (args, ctx) => {
      const name = (args || "").trim();
      if (!name) {
        ctx.ui.notify("Usage: /ha-group-delete <name>", "warning");
        return;
      }
      if (!config?.groups?.[name]) {
        ctx.ui.notify(`[HA] Group '${name}' not found.`, "warning");
        return;
      }
      if (state.activeGroup === name) {
        ctx.ui.notify(
          `[HA] Cannot delete the active group '${name}'. Switch to a different group first.`,
          "error",
        );
        return;
      }
      if (!await ctx.ui.confirm("Delete group", `Delete group '${name}'? This cannot be undone.`)) return;

      delete config.groups[name];
      if (config.defaultGroup === name) {
        config.defaultGroup = undefined;
      }
      await saveConfig(config);
      persistState();
      ctx.ui.notify(`[HA] Group '${name}' deleted.`, "info");
    },
  });

  // ─── /ha-activate <provider> <name> ────────────────────────────────────────
  pi.registerCommand("ha-activate", {
    description: "Activate a credential: /ha-activate <provider> <name>",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      if (parts.length !== 2 || !parts[0]) {
        ctx.ui.notify("Usage: /ha-activate <provider> <name>", "warning");
        return;
      }
      const [provider, name] = parts;
      if (!isCredentialEntryKey(name)) {
        ctx.ui.notify(`[HA] '${name}' is not a valid credential name.`, "warning");
        return;
      }
      if (await switchCred(provider, name, ctx)) {
        updateStatusBar(ctx);
        ctx.ui.notify(`[HA] Activated '${name}' for ${provider}`, "info");
      } else {
        ctx.ui.notify(`[HA] Credential '${name}' not found for provider '${provider}'.`, "warning");
      }
    },
  });

  // ─── /ha-clear [provider] [name|current] ─────────────────────────────────
  pi.registerCommand("ha-clear", {
    description: "Clear credentials: /ha-clear | /ha-clear <provider> | /ha-clear <provider> <name|current>",
    handler: async (args, ctx) => {
      if (!config?.credentials) {
        ctx.ui.notify("[HA] No credentials stored.", "warning");
        return;
      }
      const parts = (args || "").trim().split(/\s+/).filter(Boolean);

      // /ha-clear — clear ALL credentials for ALL providers
      if (parts.length === 0) {
        const providerCount = Object.keys(config.credentials).length;
        if (!await ctx.ui.confirm("Clear all HA credentials", `Delete all credentials for ${providerCount} provider(s)? This cannot be undone.`)) return;
        config.credentials = {};
        state.activeCredential.clear();
        state.exhausted.clear();
        await saveConfig(config);
        persistState();
        updateStatusBar(ctx);
        ctx.ui.notify(`[HA] Cleared all credentials (${providerCount} provider(s)).`, "info");
        return;
      }

      const provider = parts[0];
      if (!config.credentials[provider]) {
        ctx.ui.notify(`[HA] Provider '${provider}' not found.`, "warning");
        return;
      }

      // /ha-clear <provider> — clear all credentials for a provider
      if (parts.length === 1) {
        const names = getCredentialNames(config.credentials[provider]);
        if (!await ctx.ui.confirm("Clear provider credentials", `Delete all ${names.length} credential(s) for ${provider}?`)) return;
        delete config.credentials[provider];
        state.activeCredential.delete(provider);
        for (const n of names) {
          state.exhausted.delete(getCredentialExhaustionKey(provider, n));
        }
        await saveConfig(config);
        persistState();
        updateStatusBar(ctx);
        ctx.ui.notify(`[HA] Cleared all credentials for ${provider} (${names.length} key(s)).`, "info");
        return;
      }

      // /ha-clear <provider> current — clear the currently active credential
      // /ha-clear <provider> <name>  — clear a specific credential by name
      let name = parts[1];
      if (name === "current") {
        const activeName = state.activeCredential.get(provider);
        if (!activeName) {
          ctx.ui.notify(`[HA] No active credential for ${provider}.`, "warning");
          return;
        }
        name = activeName;
      }

      const stored = config.credentials[provider];
      if (!Object.prototype.hasOwnProperty.call(stored, name) || !isCredentialEntryKey(name)) {
        ctx.ui.notify(`[HA] Credential '${name}' not found for ${provider}.`, "warning");
        return;
      }

      if (!await ctx.ui.confirm("Clear credential", `Delete credential '${name}' for ${provider}?`)) return;

      const wasDefault = getDefaultCredentialName(stored) === name;
      delete stored[name];
      state.exhausted.delete(getCredentialExhaustionKey(provider, name));

      // Update active credential if we just deleted the active one
      if (state.activeCredential.get(provider) === name) {
        const remaining = getCredentialNames(stored);
        if (remaining.length > 0) {
          state.activeCredential.set(provider, remaining[0]);
        } else {
          state.activeCredential.delete(provider);
        }
      }

      // Update default if needed
      if (wasDefault) {
        setDefaultCredentialName(stored);
      } else {
        ensureCredentialMeta(stored);
      }

      // Clean up empty provider
      if (getCredentialNames(stored).length === 0) {
        delete config.credentials[provider];
      }

      await saveConfig(config);
      persistState();
      updateStatusBar(ctx);
      ctx.ui.notify(`[HA] Cleared credential '${name}' for ${provider}.`, "info");
    },
  });

  pi.on("turn_start", async (event, ctx) => {
    // Only reset retry counter if we're NOT in a retry cycle
    if (!state.isRetrying) {
      state.retriesThisTurn = 0;
    }
    state.isRetrying = false;       // Reset retry guard at turn boundary
    reloadConfigFromDisk();
    if (!state.activeGroup && config?.defaultGroup) {
      state.activeGroup = config.defaultGroup;
    }
    updateStatusBar(ctx);
    // Freshen stored tokens FIRST so the rotated refresh token is in memory,
    // then syncAuthToHa can match against it instead of creating a new backup.
    await syncActiveCredentialFromAuth();                    // Freshen active credential tokens in ha.json
    const auth = await loadAuthJson();
    if (syncAuthToHa(auth, ctx)) await saveConfig(config!); // Pick up any new credentials from auth.json
  });

  pi.on("turn_end", async (event, ctx) => {
    updateStatusBar(ctx);
    if (!config || !state.activeGroup || state.isRetrying) return;
    const msg = event.message;
    if (msg?.role !== "assistant") return;

    // Determine error type
    const errorMsg = msg.errorMessage || "";
    const errorType = classifyError(errorMsg);

    if (!errorType) {
      state.retriesThisTurn = 0;  // Reset on successful turn
      if (errorMsg) {
        ctx.ui.notify(`[HA] turn_end: non-HA error detected: ${errorMsg.slice(0, 80)}`, "info");
      }
      return;
    }

    const providerId = ctx.model?.provider;
    if (!providerId) return;

    const isAuthError = errorType === "auth";
    const isCapacityError = errorType === "capacity";
    const errorLabel = isAuthError ? "AUTH" : isCapacityError ? "CAPACITY" : "QUOTA";
    ctx.ui.notify(
      `[HA] turn_end: ${errorLabel} error from ${providerId}/${ctx.model?.id}: ${errorMsg.slice(0, 100)}`,
      "warning",
    );

    // Auth errors are treated like quota errors — exhaust + failover, never delete.
    // A failed OAuth refresh might be temporary (rate limited, network issue).

    const group = config.groups[state.activeGroup];
    if (!group) return;

    // Auth errors use the same failover strategy as quota errors
    const errorHandling = config.errorHandling || {};
    const action: ErrorAction = isCapacityError
      ? errorHandling.capacityErrorAction || "next_key_then_provider"
      : errorHandling.quotaErrorAction || "next_key_then_provider";

    const retryTimeoutMs = errorHandling.retryTimeoutMs || 300000;

    if (action === "stop") {
      ctx.ui.notify(`🛑 ${isCapacityError ? "Capacity" : "Quota"} error. Stopping as configured.`, "error");
      return;
    }

    const maxRetries = config.errorHandling?.maxRetriesPerTurn ?? 3;
    if (state.retriesThisTurn >= maxRetries) {
      ctx.ui.notify(
        `[HA] Circuit breaker: max retries (${maxRetries}) reached for this turn. Stopping.`,
        "error",
      );
      state.retriesThisTurn = 0;
      return;
    }
    state.retriesThisTurn++;

    if (action === "retry") {
      if (state.retryTimeoutId) clearTimeout(state.retryTimeoutId);
      const jitter = Math.floor(retryTimeoutMs * 0.1 * (Math.random() * 2 - 1)); // ±10%
      const actualDelay = retryTimeoutMs + jitter;
      ctx.ui.notify(
        `⏱️ ${isCapacityError ? "Capacity" : "Quota"} error. Retrying in ${Math.round(actualDelay / 1000)}s...`,
        "warning",
      );
      state.retryTimeoutId = setTimeout(() => { retryTurn(ctx); }, actualDelay);
      return;
    }

    const { entry: currentGroupEntry, index: currentEntryIdx } = getCurrentGroupEntry(group, ctx.model);
    const providerCooldown = currentGroupEntry?.cooldownMs || config.defaultCooldownMs || 3600000;

    // Mark current credential exhausted regardless of action
    const stored = config.credentials?.[providerId];
    if (stored) {
      const names = getCredentialNames(stored);
      const currentCred =
        state.activeCredential.get(providerId) || getDefaultCredentialName(stored) || names[0];
      if (currentCred) {
        markExhausted(getCredentialExhaustionKey(providerId, currentCred), providerCooldown);
      }

      // Try next key/account for the same provider (only when action is next_key_then_provider)
      if (action === "next_key_then_provider") {
        for (let i = 1; i <= names.length; i++) {
          const nextIdx = (names.indexOf(currentCred) + i) % names.length;
          const nextName = names[nextIdx];

          if (!isExhausted(getCredentialExhaustionKey(providerId, nextName))) {
            if (await switchCred(providerId, nextName, ctx)) {
              ctx.ui.notify(
                `[HA] Switching ${providerId} credential: ${currentCred} -> ${nextName}`,
                "warning",
              );
              updateStatusBar(ctx);
              persistState();
              retryTurn(ctx);
              return;
            }
          }
        }
        ctx.ui.notify(`[HA] All credentials for ${providerId} exhausted, trying next provider`, "warning");
      }
    }

    if (currentGroupEntry) {
      markExhausted(getEntryExhaustionKey(currentGroupEntry.id), providerCooldown);
    }

    {
      const entries = group.entries;
      ctx.ui.notify(`[HA] Scanning ${entries.length} group entries for fallback provider`, "info");

      for (let i = 1; i <= entries.length; i++) {
        const nextEntryIdx =
          currentEntryIdx >= 0
            ? (currentEntryIdx + i) % entries.length
            : (i - 1) % entries.length;
        const nextEntry = entries[nextEntryIdx];

        if (isExhausted(getEntryExhaustionKey(nextEntry.id))) {
          ctx.ui.notify(`[HA] Entry ${nextEntry.id} exhausted, skipping`, "info");
          continue;
        }

        let targetModel = resolveGroupEntryModel(nextEntry.id, ctx.modelRegistry);
        if (!targetModel) {
          // Model not in registry — may be unauthed. Try switching credentials first, then retry lookup.
          const probeProviderId = nextEntry.id.includes("/") ? nextEntry.id.slice(0, nextEntry.id.indexOf("/")) : nextEntry.id;
          const probeCredName = pickCredentialForProvider(probeProviderId, nextEntry.id);
          if (probeCredName) {
            await switchCred(probeProviderId, probeCredName, ctx);
            targetModel = resolveGroupEntryModel(nextEntry.id, ctx.modelRegistry);
          }
          if (!targetModel) {
            ctx.ui.notify(`[HA] Entry ${nextEntry.id}: model not found in registry (even after credential switch)`, "info");
            continue;
          }
        }

        if (targetModel.provider === ctx.model?.provider && targetModel.id === ctx.model?.id) {
          ctx.ui.notify(`[HA] Entry ${nextEntry.id}: same as current model, skipping`, "info");
          continue;
        }

        const nextProviderId = targetModel.provider;
        const nextCredName = pickCredentialForProvider(nextProviderId, nextEntry.id);
        const nextCooldown = nextEntry.cooldownMs || config.defaultCooldownMs || 3600000;

        if (config.credentials?.[nextProviderId] && !nextCredName) {
          ctx.ui.notify(`[HA] Entry ${nextEntry.id}: all credentials exhausted`, "info");
          markExhausted(getEntryExhaustionKey(nextEntry.id), nextCooldown);
          continue;
        }

        if (nextCredName && !await switchCred(nextProviderId, nextCredName, ctx)) {
          ctx.ui.notify(`[HA] Entry ${nextEntry.id}: credential switch failed`, "warning");
          markExhausted(getEntryExhaustionKey(nextEntry.id), nextCooldown);
          continue;
        }

        if (await pi.setModel(targetModel)) {
          ctx.ui.notify(
            `[HA] Failover: ${providerId} -> ${nextProviderId}/${targetModel.id} (cred: ${nextCredName || "default"})`,
            "warning",
          );
          updateStatusBar(ctx);
          persistState();
          retryTurn(ctx);
          return;
        }

        ctx.ui.notify(`[HA] Entry ${nextEntry.id}: setModel() failed`, "warning");
        markExhausted(getEntryExhaustionKey(nextEntry.id), nextCooldown);
      }
    }

    ctx.ui.notify(
      `[HA] ${errorLabel} error — all fallback options exhausted. No providers available.`,
      "error",
    );
    persistState();
    updateStatusBar(ctx);
  });

  function retryTurn(ctx: ExtensionContext) {
    state.isRetrying = true;
    try {
      const branch = ctx.sessionManager.getBranch();
      const lastUser = branch
        .slice()
        .reverse()
        .find((e): e is SessionMessageEntry =>
          e.type === "message" && (e as SessionMessageEntry).message.role === "user"
        );
      if (lastUser && lastUser.message.role === "user") {
        let content = lastUser.message.content;
        // Strip image blocks to avoid doubling token costs on retry
        if (Array.isArray(content)) {
          const textOnly = content.filter((b): b is TextContent => b.type === "text");
          if (textOnly.length < content.length) {
            if (textOnly.length > 0) {
              content = textOnly;
              ctx.ui.notify("[HA] Images stripped from retry to avoid doubling token costs.", "info");
            } else {
              ctx.ui.notify("[HA] Retrying image-only message — images cannot be stripped.", "warning");
            }
          }
        }
        pi.sendUserMessage(content, { deliverAs: "steer" });
      } else {
        ctx.ui.notify("[HA] No user message found to retry.", "warning");
        state.isRetrying = false;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`[HA] Retry failed: ${message}`, "error");
      state.isRetrying = false;
    }
  }
}
