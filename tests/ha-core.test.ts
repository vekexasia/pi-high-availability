import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyError,
  getCredentialExhaustionKey,
  getEntryExhaustionKey,
  isExhausted,
  markExhausted,
  countActiveExhausted,
  getCurrentGroupEntry,
  resolveGroupEntryModel,
  pickCredentialForProvider,
  findMatchingCredentialName,
  credentialFingerprint,
  determineNewCredentialName,
  determineCredentialType,
  type ExhaustionEntry,
  type HaGroup,
} from "../extensions/ha-core";

// ─── classifyError ───────────────────────────────────────────────────────────

describe("classifyError", () => {
  it("returns null for empty string", () => {
    expect(classifyError("")).toBeNull();
  });

  it("returns null for unrelated errors", () => {
    expect(classifyError("Connection refused")).toBeNull();
    expect(classifyError("Invalid API key")).toBeNull();
    expect(classifyError("Timeout after 30s")).toBeNull();
  });

  // Capacity errors
  it("detects 'no capacity'", () => {
    expect(classifyError("No capacity available")).toBe("capacity");
  });

  it("detects 'engine overloaded'", () => {
    expect(classifyError("Engine overloaded, please retry")).toBe("capacity");
  });

  it("detects 'server is overloaded' (case-insensitive)", () => {
    expect(classifyError("Server is OVERLOADED")).toBe("capacity");
  });

  it("detects HTTP 503", () => {
    expect(classifyError("HTTP 503 Service Unavailable")).toBe("capacity");
  });

  it("detects 'service temporarily unavailable'", () => {
    expect(classifyError("Service temporarily unavailable")).toBe("capacity");
  });

  it("detects 'server is overloaded' (with 'is')", () => {
    expect(classifyError("Server is overloaded")).toBe("capacity");
  });

  it("detects 'service overloaded'", () => {
    expect(classifyError("Service overloaded")).toBe("capacity");
  });

  it("detects 'no capacity' (lowercase variant)", () => {
    expect(classifyError("no capacity for this model")).toBe("capacity");
  });

  // Quota errors
  it("detects HTTP 429", () => {
    expect(classifyError("Error 429: Too Many Requests")).toBe("quota");
  });

  it("detects 'quota'", () => {
    expect(classifyError("You have exceeded your quota")).toBe("quota");
  });

  it("detects 'rate limit'", () => {
    expect(classifyError("Rate limit exceeded")).toBe("quota");
  });

  it("detects 'usage limit'", () => {
    expect(classifyError("Monthly usage limit reached")).toBe("quota");
  });

  it("detects 'insufficient quota'", () => {
    expect(classifyError("Insufficient quota for this request")).toBe("quota");
  });

  it("detects 'rate_limit'", () => {
    expect(classifyError("rate_limit_exceeded")).toBe("quota");
  });

  it("detects 'resource_exhausted'", () => {
    expect(classifyError("resource_exhausted")).toBe("quota");
  });

  it("detects 'too many requests'", () => {
    expect(classifyError("Too many requests")).toBe("quota");
  });

  // Priority: capacity wins when both match
  it("returns 'capacity' when both capacity and quota signals present", () => {
    expect(classifyError("429 engine overloaded")).toBe("capacity");
  });

  // Fixed false positives (issue #14)
  it("does not match '429' without word boundary (e.g. '4291')", () => {
    expect(classifyError("error code 4291")).toBeNull();
  });

  it("matches bare '429' even in non-HTTP context (accepted tradeoff)", () => {
    expect(classifyError("processed 429 items")).toBe("quota"); // bare 429 in error messages is almost always HTTP 429
  });

  it("detects '429' followed by lowercase word (e.g. 'from upstream')", () => {
    expect(classifyError("Received status code 429 from upstream")).toBe("quota");
  });

  it("detects '429' followed by 'from server'", () => {
    expect(classifyError("request failed with status 429 from server")).toBe("quota");
  });

  it("does not match bare 'overloaded' without server/service context", () => {
    expect(classifyError("function is overloaded with parameters")).toBeNull();
  });

  it("does not match bare 'capacity' (e.g. 'capacity planning')", () => {
    expect(classifyError("capacity planning for Q3")).toBeNull();
  });

  // Real-world provider error messages
  it("Anthropic: rate_limit_error", () => {
    expect(classifyError("rate_limit_error: Too many requests")).toBe("quota");
  });

  it("Anthropic: overloaded_error", () => {
    expect(classifyError("overloaded_error: Overloaded")).toBe("capacity");
  });

  it("Gemini: RESOURCE_EXHAUSTED", () => {
    expect(classifyError("RESOURCE_EXHAUSTED: Quota exceeded")).toBe("quota");
  });

  it("Gemini: quota_exceeded", () => {
    expect(classifyError("quota exceeded for the day")).toBe("quota");
  });

  it("OpenAI: rate_limit_exceeded", () => {
    expect(classifyError("Rate limit exceeded: You have exceeded your rate limit")).toBe("quota");
  });

  it("OpenAI: insufficient_quota", () => {
    expect(classifyError("You exceeded your current quota, please check your plan and billing details")).toBe("quota");
  });

  it("Moonshot: exceeded_current_quota_error", () => {
    expect(classifyError("exceeded_current_quota_error: Quota exhausted")).toBe("quota");
  });
});

// ─── Exhaustion Key Generation ───────────────────────────────────────────────

describe("getCredentialExhaustionKey", () => {
  it("generates correct key format", () => {
    expect(getCredentialExhaustionKey("anthropic", "primary")).toBe("cred:anthropic:primary");
    expect(getCredentialExhaustionKey("openai", "backup-1")).toBe("cred:openai:backup-1");
  });
});

describe("getEntryExhaustionKey", () => {
  it("generates correct key format", () => {
    expect(getEntryExhaustionKey("anthropic/claude-3")).toBe("entry:anthropic/claude-3");
    expect(getEntryExhaustionKey("openai")).toBe("entry:openai");
  });
});

// ─── Exhaustion Tracking ─────────────────────────────────────────────────────

describe("isExhausted", () => {
  let exhausted: Map<string, ExhaustionEntry>;

  beforeEach(() => {
    exhausted = new Map();
  });

  it("returns false for unknown key", () => {
    expect(isExhausted(exhausted, "unknown")).toBe(false);
  });

  it("returns true within cooldown window", () => {
    const now = 10000;
    exhausted.set("key1", { exhaustedAt: 9000, cooldownMs: 5000 });
    expect(isExhausted(exhausted, "key1", now)).toBe(true);
  });

  it("returns false after cooldown expires", () => {
    const now = 20000;
    exhausted.set("key1", { exhaustedAt: 9000, cooldownMs: 5000 });
    expect(isExhausted(exhausted, "key1", now)).toBe(false);
  });

  it("returns false at exact cooldown boundary", () => {
    const now = 14000;
    exhausted.set("key1", { exhaustedAt: 9000, cooldownMs: 5000 });
    expect(isExhausted(exhausted, "key1", now)).toBe(false);
  });

  it("returns true 1ms before cooldown expires", () => {
    const now = 13999;
    exhausted.set("key1", { exhaustedAt: 9000, cooldownMs: 5000 });
    expect(isExhausted(exhausted, "key1", now)).toBe(true);
  });
});

describe("markExhausted", () => {
  it("adds entry to the map", () => {
    const exhausted = new Map<string, ExhaustionEntry>();
    markExhausted(exhausted, "key1", 5000, 10000);
    expect(exhausted.get("key1")).toEqual({ exhaustedAt: 10000, cooldownMs: 5000 });
  });

  it("overwrites existing entry", () => {
    const exhausted = new Map<string, ExhaustionEntry>();
    markExhausted(exhausted, "key1", 3000, 5000);
    markExhausted(exhausted, "key1", 8000, 10000);
    expect(exhausted.get("key1")).toEqual({ exhaustedAt: 10000, cooldownMs: 8000 });
  });
});

describe("countActiveExhausted", () => {
  it("returns 0 for empty map", () => {
    expect(countActiveExhausted(new Map())).toBe(0);
  });

  it("counts only non-expired entries", () => {
    const now = 10000;
    const exhausted = new Map<string, ExhaustionEntry>([
      ["a", { exhaustedAt: 9000, cooldownMs: 5000 }],  // active (expires at 14000)
      ["b", { exhaustedAt: 3000, cooldownMs: 2000 }],  // expired (expired at 5000)
      ["c", { exhaustedAt: 8000, cooldownMs: 3000 }],  // active (expires at 11000)
    ]);
    expect(countActiveExhausted(exhausted, now)).toBe(2);
  });
});

// ─── getCurrentGroupEntry ────────────────────────────────────────────────────

describe("getCurrentGroupEntry", () => {
  const group: HaGroup = {
    name: "test",
    entries: [
      { id: "anthropic/claude-3" },
      { id: "openai/gpt-4" },
      { id: "google" }, // provider-only entry
    ],
  };

  it("returns -1 index for null model", () => {
    const result = getCurrentGroupEntry(group, null);
    expect(result).toEqual({ entry: undefined, index: -1 });
  });

  it("returns -1 index for undefined model", () => {
    const result = getCurrentGroupEntry(group);
    expect(result).toEqual({ entry: undefined, index: -1 });
  });

  it("matches by provider/model ID", () => {
    const result = getCurrentGroupEntry(group, { provider: "openai", id: "gpt-4" });
    expect(result.index).toBe(1);
    expect(result.entry?.id).toBe("openai/gpt-4");
  });

  it("matches by provider-only entry", () => {
    const result = getCurrentGroupEntry(group, { provider: "google", id: "gemini-pro" });
    expect(result.index).toBe(2);
    expect(result.entry?.id).toBe("google");
  });

  it("returns -1 for unmatched model", () => {
    const result = getCurrentGroupEntry(group, { provider: "mistral", id: "large" });
    expect(result).toEqual({ entry: undefined, index: -1 });
  });

  it("prefers exact provider/model match over provider-only", () => {
    const groupWithBoth: HaGroup = {
      name: "mixed",
      entries: [
        { id: "anthropic/claude-3" },
        { id: "anthropic" },
      ],
    };
    const result = getCurrentGroupEntry(groupWithBoth, { provider: "anthropic", id: "claude-3" });
    expect(result.index).toBe(0); // exact match first
  });
});

// ─── resolveGroupEntryModel ──────────────────────────────────────────────────

describe("resolveGroupEntryModel", () => {
  const mockRegistry = {
    find: (provider: string, modelId: string) => {
      const models: Record<string, any> = {
        "anthropic/claude-3": { provider: "anthropic", id: "claude-3" },
        "openai/gpt-4": { provider: "openai", id: "gpt-4" },
      };
      return models[`${provider}/${modelId}`] || undefined;
    },
    getAll: () => [
      { provider: "anthropic", id: "claude-3" },
      { provider: "openai", id: "gpt-4" },
      { provider: "google", id: "gemini-pro" },
    ],
  };

  it("resolves provider/model entry via find()", () => {
    const result = resolveGroupEntryModel("anthropic/claude-3", mockRegistry);
    expect(result).toEqual({ provider: "anthropic", id: "claude-3" });
  });

  it("resolves provider-only entry via getAll()", () => {
    const result = resolveGroupEntryModel("google", mockRegistry);
    expect(result).toEqual({ provider: "google", id: "gemini-pro" });
  });

  it("returns undefined for unknown provider/model", () => {
    const result = resolveGroupEntryModel("mistral/large", mockRegistry);
    expect(result).toBeUndefined();
  });

  it("returns undefined for unknown provider-only", () => {
    const result = resolveGroupEntryModel("mistral", mockRegistry);
    expect(result).toBeUndefined();
  });
});

// ─── pickCredentialForProvider ────────────────────────────────────────────────

describe("pickCredentialForProvider", () => {
  let activeCredential: Map<string, string>;
  let exhausted: Map<string, ExhaustionEntry>;
  const now = 10000;

  beforeEach(() => {
    activeCredential = new Map();
    exhausted = new Map();
  });

  it("returns undefined when provider has no credentials", () => {
    expect(pickCredentialForProvider("anthropic", {}, activeCredential, exhausted, now)).toBeUndefined();
  });

  it("returns undefined when credentials is undefined", () => {
    expect(pickCredentialForProvider("anthropic", undefined, activeCredential, exhausted, now)).toBeUndefined();
  });

  it("returns undefined when provider entry has only reserved keys", () => {
    const creds = {
      anthropic: { __meta: { defaultName: "primary" }, type: "oauth" },
    };
    expect(pickCredentialForProvider("anthropic", creds, activeCredential, exhausted, now)).toBeUndefined();
  });

  it("returns the active credential when available", () => {
    const creds = {
      anthropic: {
        primary: { key: "k1" },
        "backup-1": { key: "k2" },
        __meta: { defaultName: "primary" },
      },
    };
    activeCredential.set("anthropic", "backup-1");
    expect(pickCredentialForProvider("anthropic", creds, activeCredential, exhausted, now)).toBe("backup-1");
  });

  it("skips exhausted active credential and returns default", () => {
    const creds = {
      anthropic: {
        primary: { key: "k1" },
        "backup-1": { key: "k2" },
        __meta: { defaultName: "primary" },
      },
    };
    activeCredential.set("anthropic", "backup-1");
    exhausted.set("cred:anthropic:backup-1", { exhaustedAt: 9000, cooldownMs: 5000 });
    expect(pickCredentialForProvider("anthropic", creds, activeCredential, exhausted, now)).toBe("primary");
  });

  it("returns undefined when all credentials are exhausted", () => {
    const creds = {
      anthropic: {
        primary: { key: "k1" },
        "backup-1": { key: "k2" },
        __meta: { defaultName: "primary" },
      },
    };
    exhausted.set("cred:anthropic:primary", { exhaustedAt: 9000, cooldownMs: 5000 });
    exhausted.set("cred:anthropic:backup-1", { exhaustedAt: 9000, cooldownMs: 5000 });
    expect(pickCredentialForProvider("anthropic", creds, activeCredential, exhausted, now)).toBeUndefined();
  });

  it("returns credential that has expired cooldown", () => {
    const creds = {
      anthropic: {
        primary: { key: "k1" },
        __meta: { defaultName: "primary" },
      },
    };
    exhausted.set("cred:anthropic:primary", { exhaustedAt: 1000, cooldownMs: 3000 }); // expired at 4000
    expect(pickCredentialForProvider("anthropic", creds, activeCredential, exhausted, now)).toBe("primary");
  });

  it("deduplicates preference list", () => {
    // When active = default = first, should not check the same name 3x
    const creds = {
      anthropic: {
        primary: { key: "k1" },
        __meta: { defaultName: "primary" },
      },
    };
    activeCredential.set("anthropic", "primary");
    expect(pickCredentialForProvider("anthropic", creds, activeCredential, exhausted, now)).toBe("primary");
  });

  it("returns undefined when entryId is provided and entry is exhausted", () => {
    const creds = {
      anthropic: {
        primary: { key: "k1" },
        __meta: { defaultName: "primary" },
      },
    };
    exhausted.set("entry:anthropic/claude-3", { exhaustedAt: 9000, cooldownMs: 5000 });
    expect(pickCredentialForProvider("anthropic", creds, activeCredential, exhausted, now, "anthropic/claude-3")).toBeUndefined();
  });

  it("returns credential normally when entryId is provided but not exhausted", () => {
    const creds = {
      anthropic: {
        primary: { key: "k1" },
        __meta: { defaultName: "primary" },
      },
    };
    expect(pickCredentialForProvider("anthropic", creds, activeCredential, exhausted, now, "anthropic/claude-3")).toBe("primary");
  });

  it("ignores entry exhaustion when entryId is not provided", () => {
    const creds = {
      anthropic: {
        primary: { key: "k1" },
        __meta: { defaultName: "primary" },
      },
    };
    exhausted.set("entry:anthropic/claude-3", { exhaustedAt: 9000, cooldownMs: 5000 });
    expect(pickCredentialForProvider("anthropic", creds, activeCredential, exhausted, now)).toBe("primary");
  });
});

// ─── findMatchingCredentialName ──────────────────────────────────────────────

describe("findMatchingCredentialName", () => {
  it("matches by refresh token", () => {
    const stored = {
      primary: { refresh: "token-1", type: "oauth" },
      __meta: { defaultName: "primary" },
    };
    expect(findMatchingCredentialName(stored, { refresh: "token-1" })).toBe("primary");
  });

  it("matches by API key", () => {
    const stored = {
      work: { key: "sk-123", type: "api_key" },
      __meta: { defaultName: "work" },
    };
    expect(findMatchingCredentialName(stored, { key: "sk-123" })).toBe("work");
  });

  it("returns null when no match", () => {
    const stored = {
      primary: { key: "sk-old", type: "api_key" },
      __meta: { defaultName: "primary" },
    };
    expect(findMatchingCredentialName(stored, { key: "sk-new" })).toBeNull();
  });

  it("skips reserved keys during matching", () => {
    const stored = {
      type: "oauth",
      __meta: { defaultName: "primary", refresh: "token-1" },
      primary: { refresh: "token-1" },
    };
    // Should find "primary", not "type" or "__meta"
    expect(findMatchingCredentialName(stored, { refresh: "token-1" })).toBe("primary");
  });

  it("returns null when stored is empty", () => {
    expect(findMatchingCredentialName({}, { key: "sk-123" })).toBeNull();
  });

  it("matches credential with access_token (was gap #7)", () => {
    const stored = {
      primary: { access_token: "at-123" },
    };
    expect(findMatchingCredentialName(stored, { access_token: "at-123" })).toBe("primary");
  });

  it("matches existing entry even after OAuth access token refresh", () => {
    const stored = {
      primary: { refresh: "stable-refresh", access: "old-access", type: "oauth" },
      __meta: { defaultName: "primary" },
    };
    // Simulate a token refresh: same refresh token, different access token
    expect(findMatchingCredentialName(stored, { refresh: "stable-refresh", access: "new-access" })).toBe("primary");
  });
});

// ─── credentialFingerprint ─────────────────────────────────────────────────

describe("credentialFingerprint", () => {
  it("strips type and __meta fields", () => {
    expect(credentialFingerprint({ key: "sk-1", type: "api_key", __meta: { x: 1 } })).toBe(
      JSON.stringify({ key: "sk-1" }),
    );
  });

  it("produces same fingerprint regardless of key order", () => {
    const a = { access_token: "tok", refresh_token: "ref" };
    const b = { refresh_token: "ref", access_token: "tok" };
    expect(credentialFingerprint(a)).toBe(credentialFingerprint(b));
  });

  it("different credentials produce different fingerprints", () => {
    expect(credentialFingerprint({ key: "sk-1" })).not.toBe(credentialFingerprint({ key: "sk-2" }));
  });

  it("returns empty JSON object when all fields are stripped", () => {
    expect(credentialFingerprint({ type: "oauth", __meta: {} })).toBe(JSON.stringify({}));
  });

  it("produces different fingerprints for same refresh but different access token", () => {
    const a = { refresh: "r1", access: "old" };
    const b = { refresh: "r1", access: "new" };
    expect(credentialFingerprint(a)).not.toBe(credentialFingerprint(b));
  });
});

// ─── determineNewCredentialName ──────────────────────────────────────────────

describe("determineNewCredentialName", () => {
  it("returns 'primary' for empty list", () => {
    expect(determineNewCredentialName([])).toBe("primary");
  });

  it("returns 'backup-N' based on list length", () => {
    expect(determineNewCredentialName(["primary"])).toBe("backup-1");
    expect(determineNewCredentialName(["primary", "backup-1"])).toBe("backup-2");
  });
});

// ─── determineCredentialType ─────────────────────────────────────────────────

describe("determineCredentialType", () => {
  it("returns 'oauth' for refresh token", () => {
    expect(determineCredentialType({ refresh: "token" })).toBe("oauth");
  });

  it("returns 'api_key' for key field", () => {
    expect(determineCredentialType({ key: "sk-123" })).toBe("api_key");
  });

  it("returns undefined for unknown auth shape", () => {
    expect(determineCredentialType({ access_token: "at-123" })).toBeUndefined();
  });

  it("prefers oauth when both refresh and key present", () => {
    expect(determineCredentialType({ refresh: "token", key: "sk-123" })).toBe("oauth");
  });
});
