/**
 * High Availability Provider Extension for Pi
 */

import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { chmodSync, readFileSync, writeFileSync } from "fs";
import { chmod, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import {
  ensureCredentialMeta,
  getCredentialNames,
  getDefaultCredentialName,
  isCredentialEntryKey,
  isReservedCredentialName,
  normalizeCredentialProviders,
  setDefaultCredentialName,
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
  pickCredentialForProvider as pickCredentialForProviderCore,
  resolveGroupEntryModel,
  type ErrorAction,
  type ExhaustionEntry,
  type HaConfig,
  type HaGroup,
  type HaGroupEntry,
} from "./ha-core";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "ha.json");
const AUTH_PATH = join(AGENT_DIR, "auth.json");

// Module-level hook — assigned inside export default once `pi` is available,
// so switchCred() can call it without needing `pi` in its own scope.
let persistState: () => void = () => {};

const state = {
  activeGroup: null as string | null,
  exhausted: new Map<string, ExhaustionEntry>(),
  isRetrying: false,
  activeCredential: new Map<string, string>(),
  retryTimeoutId: null as NodeJS.Timeout | null,
  lastStatusModel: null as { provider: string; id: string } | null,
  lastStatusUI: null as any,
  retriesThisTurn: 0,
};

function updateStatusBar(ctx?: any) {
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

let config: HaConfig | null = null;

async function loadAuthJson(): Promise<any> {
  try { return JSON.parse(await readFile(AUTH_PATH, "utf-8")); }
  catch { return {}; }
}

async function saveAuthJson(auth: any): Promise<void> {
  await writeFile(AUTH_PATH, JSON.stringify(auth, null, 2), "utf-8");
}

async function saveConfig(cfg: HaConfig): Promise<void> {
  normalizeCredentialProviders(cfg.credentials as any);
  config = cfg;
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600);
}

function syncAuthToHa(auth: any, ctx?: any): boolean {
  if (!config) return false;
  if (!config.credentials) config.credentials = {};
  let changed = false;

  for (const [providerId, creds] of Object.entries(auth)) {
    if (!config.credentials[providerId]) config.credentials[providerId] = {};
    const stored = config.credentials[providerId];
    ensureCredentialMeta(stored as any);

    const foundName = findMatchingCredentialName(stored, creds as any);

    if (!foundName) {
      const existingNames = getCredentialNames(stored as any);
      const name = determineNewCredentialName(existingNames);
      const newCred = structuredClone(creds);
      const credType = determineCredentialType(creds as any);
      if (credType) newCred.type = credType;

      stored[name] = newCred;
      if (existingNames.length === 0) {
        setDefaultCredentialName(stored as any, name);
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
      ensureCredentialMeta(stored as any);
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

async function switchCred(providerId: string, name: string, ctx?: any): Promise<boolean> {
  const stored = config?.credentials?.[providerId];
  if (!stored || !Object.prototype.hasOwnProperty.call(stored, name) || !isCredentialEntryKey(name)) return false;
  const auth = await loadAuthJson();

  // Strip HA-internal metadata before writing to auth.json
  const { type: _type, __meta: _meta, ...credToSave } = structuredClone(stored[name]);
  auth[providerId] = credToSave;
  await saveAuthJson(auth);
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

function updateActiveCredentialsFromAuth(auth: any) {
  if (!config?.credentials) return;

  for (const [providerId, currentAuth] of Object.entries(auth)) {
    const stored = config.credentials[providerId];
    if (!stored) continue;
    ensureCredentialMeta(stored as any);

    for (const [name, cred] of Object.entries(stored)) {
      if (!isCredentialEntryKey(name)) continue;

      if ((currentAuth as any).key && (currentAuth as any).key === (cred as any).key) {
        state.activeCredential.set(providerId, name);
        break;
      }
      if ((currentAuth as any).refresh && (currentAuth as any).refresh === (cred as any).refresh) {
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
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    try { chmodSync(CONFIG_PATH, 0o600); } catch {} // Tighten permissions on every startup
    normalizeCredentialProviders(config?.credentials as any);
    if (config?.defaultGroup) state.activeGroup = config.defaultGroup;

    // Inline sync read of auth.json (loadAuthJson is now async, can't use it here)
    let startupAuth: any = {};
    try { startupAuth = JSON.parse(readFileSync(AUTH_PATH, "utf-8")); } catch {}

    // syncAuthToHa now accepts auth param and returns changed boolean
    if (syncAuthToHa(startupAuth)) {
      normalizeCredentialProviders(config!.credentials as any);
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
      chmodSync(CONFIG_PATH, 0o600);
    }

    // updateActiveCredentialsFromAuth now accepts auth param
    updateActiveCredentialsFromAuth(startupAuth);
  } catch (e: any) {
    if (e.code !== "ENOENT") {
      console.error(`[HA] Failed to load ha.json: ${e.message}`);
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
    pi.appendEntry("ha-state", serialized);
  };

  pi.on("session_start", async (_event, ctx) => {
    // Restore persisted HA state from the most recent ha-state entry.
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as any;
      if (entry.type === "custom" && entry.customType === "ha-state" && entry.data) {
        const data = entry.data;
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
      if (!config) {
        ctx.ui.notify(
          "[HA] No configuration found. Create ~/.pi/agent/ha.json or use /ha-group.",
          "warning",
        );
        return;
      }
      const auth = await loadAuthJson();
      if (syncAuthToHa(auth, ctx)) await saveConfig(config);

      const lines: string[] = [];
      lines.push("⚠️  ha.json stores credentials in plaintext at ~/.pi/agent/ha.json — keep this file private (chmod 600).");
      lines.push(`Active Group: ${state.activeGroup || "none"}`);

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
            lines.push(`    - ${entry.id}${exhausted ? " ⛔ exhausted" : ""}`);
          }
        }
      }

      // Credentials
      if (config.credentials && Object.keys(config.credentials).length > 0) {
        lines.push("\nCredentials:");
        for (const [provider, creds] of Object.entries(config.credentials)) {
          const names = getCredentialNames(creds as any);
          const active =
            state.activeCredential.get(provider) ||
            getDefaultCredentialName(creds as any) ||
            "none";
          lines.push(`  ${provider}: ${names.join(", ")} (active: ${active})`);
          for (const name of names) {
            const exhausted = isExhausted(getCredentialExhaustionKey(provider, name));
            if (exhausted) lines.push(`    ⛔ ${name} exhausted`);
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

      if (getCredentialNames(stored as any).includes(newName)) {
        ctx.ui.notify(`[HA] Name '${newName}' already exists for ${provider}.`, "warning");
        return;
      }

      // Rebuild object preserving insertion order
      const newCreds: Record<string, any> = {};
      for (const [k, v] of Object.entries(stored)) {
        newCreds[k === oldName ? newName : k] = v;
      }
      config.credentials[provider] = newCreds;

      // Update default name if the renamed one was default
      if (getDefaultCredentialName(stored as any) === oldName) {
        setDefaultCredentialName(newCreds as any, newName);
      } else {
        ensureCredentialMeta(newCreds as any);
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
        ctx.ui.notify("Usage: /ha-group <name> <model-id1> [model-id2 ...]", "warning");
        return;
      }
      if (!config) {
        config = { groups: {}, credentials: {}, defaultCooldownMs: 3600000 };
      }
      const [name, ...modelIds] = parts;
      const entries: HaGroupEntry[] = modelIds.map((id) => ({ id }));
      config.groups[name] = { name, entries };

      // Validate model IDs and warn about unresolvable entries
      for (const id of modelIds) {
        const model = resolveGroupEntryModel(id, ctx.modelRegistry);
        if (!model) {
          ctx.ui.notify(`[HA] Warning: model '${id}' not found in registry`, "warning");
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
        const names = getCredentialNames(config.credentials[provider] as any);
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

      const wasDefault = getDefaultCredentialName(stored as any) === name;
      delete stored[name];
      state.exhausted.delete(getCredentialExhaustionKey(provider, name));

      // Update active credential if we just deleted the active one
      if (state.activeCredential.get(provider) === name) {
        const remaining = getCredentialNames(stored as any);
        if (remaining.length > 0) {
          state.activeCredential.set(provider, remaining[0]);
        } else {
          state.activeCredential.delete(provider);
        }
      }

      // Update default if needed
      if (wasDefault) {
        setDefaultCredentialName(stored as any);
      } else {
        ensureCredentialMeta(stored as any);
      }

      // Clean up empty provider
      if (getCredentialNames(stored as any).length === 0) {
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
    updateStatusBar(ctx);
    const auth = await loadAuthJson();
    if (syncAuthToHa(auth, ctx)) await saveConfig(config!); // Pick up any new credentials from auth.json
    await syncActiveCredentialFromAuth();                    // Freshen active credential tokens in ha.json
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

    const isCapacityError = errorType === "capacity";
    const errorLabel = isCapacityError ? "CAPACITY" : "QUOTA";
    ctx.ui.notify(
      `[HA] turn_end: ${errorLabel} error from ${ctx.model?.provider}/${ctx.model?.id}: ${errorMsg.slice(0, 100)}`,
      "warning",
    );

    const providerId = ctx.model?.provider;
    if (!providerId) return;

    const group = config.groups[state.activeGroup];
    if (!group) return;

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
      ctx.ui.notify(
        `⏱️ ${isCapacityError ? "Capacity" : "Quota"} error. Retrying in ${retryTimeoutMs}ms...`,
        "warning",
      );
      state.retryTimeoutId = setTimeout(() => { retryTurn(ctx); }, retryTimeoutMs);
      return;
    }

    const { entry: currentGroupEntry, index: currentEntryIdx } = getCurrentGroupEntry(group, ctx.model);
    const providerCooldown = currentGroupEntry?.cooldownMs || config.defaultCooldownMs || 3600000;

    // Mark current credential exhausted regardless of action
    const stored = config.credentials?.[providerId];
    if (stored) {
      const names = getCredentialNames(stored as any);
      const currentCred =
        state.activeCredential.get(providerId) || getDefaultCredentialName(stored as any) || names[0];
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

        const targetModel = resolveGroupEntryModel(nextEntry.id, ctx.modelRegistry);
        if (!targetModel) {
          ctx.ui.notify(`[HA] Entry ${nextEntry.id}: model not found in registry`, "info");
          continue;
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

  function retryTurn(ctx: any) {
    state.isRetrying = true;
    try {
      const branch = ctx.sessionManager.getBranch();
      const lastUser = branch
        .slice()
        .reverse()
        .find((e: any) => e.type === "message" && e.message.role === "user") as any;
      if (lastUser) {
        let content = lastUser.message.content;
        // Strip image blocks to avoid doubling token costs on retry
        if (Array.isArray(content)) {
          const textOnly = content.filter((b: any) => b.type === "text");
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
    } catch (err: any) {
      ctx.ui.notify(`[HA] Retry failed: ${err?.message || err}`, "error");
      state.isRetrying = false;
    }
  }
}
