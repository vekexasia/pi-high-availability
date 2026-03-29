/**
 * Pure / near-pure core logic extracted from index.ts for testability.
 */

import {
  getCredentialNames,
  getDefaultCredentialName,
  isCredentialEntryKey,
  type ProviderCredentials,
} from "./credentialMeta";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ErrorAction = "stop" | "retry" | "next_provider" | "next_key_then_provider";

export interface HaGroupEntry {
  id: string;
  cooldownMs?: number;
}

export interface HaGroup {
  name: string;
  entries: HaGroupEntry[];
}

export interface HaConfig {
  groups: Record<string, HaGroup>;
  defaultGroup?: string;
  defaultCooldownMs?: number;
  credentials?: Record<string, Record<string, any>>;
  errorHandling?: {
    capacityErrorAction?: ErrorAction;
    quotaErrorAction?: ErrorAction;
    retryTimeoutMs?: number;
    maxRetriesPerTurn?: number;
  };
}

export interface ExhaustionEntry {
  exhaustedAt: number;
  cooldownMs: number;
}

// ─── Error Classification ────────────────────────────────────────────────────

export function classifyError(errorMsg: string): "capacity" | "quota" | null {
  if (!errorMsg) return null;
  const lower = errorMsg.toLowerCase();

  // Capacity patterns (checked first — higher priority)
  const isCapacity =
    lower.includes("no capacity") ||
    lower.includes("engine overloaded") ||
    lower.includes("overloaded_error") ||
    /\b503\b/.test(errorMsg) ||
    lower.includes("service temporarily unavailable") ||
    /\b(server|service)\s+(is\s+)?overloaded\b/.test(lower);

  if (isCapacity) return "capacity";

  // Quota patterns
  const isQuota =
    /\b429\b/.test(errorMsg) ||
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("usage limit") ||
    lower.includes("insufficient quota") ||
    lower.includes("resource_exhausted") ||
    lower.includes("too many requests");

  if (isQuota) return "quota";
  return null;
}

// ─── Exhaustion Tracking ─────────────────────────────────────────────────────

export function getCredentialExhaustionKey(providerId: string, name: string): string {
  return `cred:${providerId}:${name}`;
}

export function getEntryExhaustionKey(entryId: string): string {
  return `entry:${entryId}`;
}

export function isExhausted(
  exhausted: Map<string, ExhaustionEntry>,
  key: string,
  now: number = Date.now(),
): boolean {
  const entry = exhausted.get(key);
  return !!entry && now - entry.exhaustedAt < entry.cooldownMs;
}

export function markExhausted(
  exhausted: Map<string, ExhaustionEntry>,
  key: string,
  cooldownMs: number,
  now: number = Date.now(),
): void {
  exhausted.set(key, { exhaustedAt: now, cooldownMs });
}

export function countActiveExhausted(
  exhausted: Map<string, ExhaustionEntry>,
  now: number = Date.now(),
): number {
  let count = 0;
  for (const [key, entry] of exhausted) {
    if (now - entry.exhaustedAt < entry.cooldownMs) {
      count++;
    } else {
      exhausted.delete(key);
    }
  }
  return count;
}

// ─── Group Entry Resolution ──────────────────────────────────────────────────

export interface ModelRef {
  provider: string;
  id: string;
}

export function getCurrentGroupEntry(
  group: HaGroup,
  model?: ModelRef | null,
): { entry: HaGroupEntry | undefined; index: number } {
  if (!model) return { entry: undefined, index: -1 };
  const currentModelId = `${model.provider}/${model.id}`;
  const index = group.entries.findIndex(
    (e) => e.id === currentModelId || e.id === model.provider,
  );
  return { entry: index >= 0 ? group.entries[index] : undefined, index };
}

export function resolveGroupEntryModel(
  entryId: string,
  registry: { find: (provider: string, modelId: string) => any; getAll: () => ModelRef[] },
): ModelRef | undefined {
  const slashIndex = entryId.indexOf("/");
  if (slashIndex !== -1) {
    const provider = entryId.slice(0, slashIndex);
    const modelId = entryId.slice(slashIndex + 1);
    return registry.find(provider, modelId);
  }
  return registry.getAll().find((m) => m.provider === entryId);
}

// ─── Credential Picking ──────────────────────────────────────────────────────

export function pickCredentialForProvider(
  providerId: string,
  credentials: Record<string, Record<string, any>> | undefined,
  activeCredential: Map<string, string>,
  exhausted: Map<string, ExhaustionEntry>,
  now: number = Date.now(),
  entryId?: string,
): string | undefined {
  // If the group entry itself is exhausted, no credential can help
  if (entryId && isExhausted(exhausted, getEntryExhaustionKey(entryId), now)) {
    return undefined;
  }

  const stored = credentials?.[providerId];
  if (!stored) return undefined;

  const names = getCredentialNames(stored as ProviderCredentials);
  if (names.length === 0) return undefined;

  const active = activeCredential.get(providerId);
  const preferred = [active, getDefaultCredentialName(stored as ProviderCredentials), ...names].filter(
    (name, idx, arr): name is string => !!name && arr.indexOf(name) === idx,
  );

  return preferred.find(
    (name) => !isExhausted(exhausted, getCredentialExhaustionKey(providerId, name), now),
  );
}

// ─── Credential Matching (syncAuthToHa logic) ───────────────────────────────

export function credentialFingerprint(cred: Record<string, any>): string {
  const filtered: Record<string, any> = {};
  for (const [k, v] of Object.entries(cred)) {
    if (k !== "type" && k !== "__meta") {
      filtered[k] = v;
    }
  }
  return JSON.stringify(filtered, Object.keys(filtered).sort());
}

export function findMatchingCredentialName(
  stored: Record<string, any>,
  authCreds: Record<string, any>,
): string | null {
  // Phase 1: match on stable identity fields only (access tokens change on OAuth refresh)
  for (const [name, existing] of Object.entries(stored)) {
    if (!isCredentialEntryKey(name)) continue;
    if (typeof existing !== "object" || existing === null) continue;
    if (authCreds.refresh && existing.refresh === authCreds.refresh) return name;
    if (authCreds.key && existing.key === authCreds.key) return name;
  }
  // Phase 2: fallback full fingerprint match for unknown credential shapes
  const authFp = credentialFingerprint(authCreds);
  for (const [name, existing] of Object.entries(stored)) {
    if (!isCredentialEntryKey(name)) continue;
    if (typeof existing !== "object" || existing === null) continue;
    if (credentialFingerprint(existing) === authFp) return name;
  }
  return null;
}

export function determineNewCredentialName(existingNames: string[]): string {
  return existingNames.length === 0 ? "primary" : `backup-${existingNames.length}`;
}

export function determineCredentialType(creds: Record<string, any>): string | undefined {
  if (creds.refresh) return "oauth";
  if (creds.key) return "api_key";
  return undefined;
}
