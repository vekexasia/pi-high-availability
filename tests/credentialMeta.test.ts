import { describe, it, expect } from "vitest";
import {
  isCredentialEntryKey,
  isReservedCredentialName,
  getCredentialNames,
  getDefaultCredentialName,
  ensureCredentialMeta,
  setDefaultCredentialName,
  normalizeCredentialProviders,
  type ProviderCredentials,
} from "../extensions/credentialMeta";

// ─── isCredentialEntryKey ────────────────────────────────────────────────────

describe("isCredentialEntryKey", () => {
  it("returns true for normal credential names", () => {
    expect(isCredentialEntryKey("primary")).toBe(true);
    expect(isCredentialEntryKey("backup-1")).toBe(true);
    expect(isCredentialEntryKey("my-key")).toBe(true);
    expect(isCredentialEntryKey("work")).toBe(true);
  });

  it("returns false for reserved keys", () => {
    expect(isCredentialEntryKey("type")).toBe(false);
    expect(isCredentialEntryKey("__meta")).toBe(false);
  });

  it("returns false for prototype-polluting keys", () => {
    expect(isCredentialEntryKey("__proto__")).toBe(false);
    expect(isCredentialEntryKey("constructor")).toBe(false);
    expect(isCredentialEntryKey("prototype")).toBe(false);
    expect(isCredentialEntryKey("toString")).toBe(false);
    expect(isCredentialEntryKey("valueOf")).toBe(false);
    expect(isCredentialEntryKey("hasOwnProperty")).toBe(false);
  });
});

// ─── isReservedCredentialName ────────────────────────────────────────────────

describe("isReservedCredentialName", () => {
  it("returns false for normal credential names", () => {
    expect(isReservedCredentialName("primary")).toBe(false);
    expect(isReservedCredentialName("backup-1")).toBe(false);
    expect(isReservedCredentialName("work")).toBe(false);
  });

  it("returns true for 'type'", () => {
    expect(isReservedCredentialName("type")).toBe(true);
  });

  it("returns true for '__meta'", () => {
    expect(isReservedCredentialName("__meta")).toBe(true);
  });

  it("returns true for any dunder key", () => {
    expect(isReservedCredentialName("__proto__")).toBe(true);
    expect(isReservedCredentialName("__defineGetter__")).toBe(true);
    expect(isReservedCredentialName("__lookupSetter__")).toBe(true);
  });

  it("returns true for Object.prototype keys", () => {
    expect(isReservedCredentialName("constructor")).toBe(true);
    expect(isReservedCredentialName("prototype")).toBe(true);
    expect(isReservedCredentialName("toString")).toBe(true);
    expect(isReservedCredentialName("valueOf")).toBe(true);
    expect(isReservedCredentialName("hasOwnProperty")).toBe(true);
    expect(isReservedCredentialName("isPrototypeOf")).toBe(true);
  });
});

// ─── getCredentialNames ──────────────────────────────────────────────────────

describe("getCredentialNames", () => {
  it("returns empty array for null/undefined", () => {
    expect(getCredentialNames(null)).toEqual([]);
    expect(getCredentialNames(undefined)).toEqual([]);
  });

  it("returns empty array for object with only reserved keys", () => {
    const creds: ProviderCredentials = { type: "oauth", __meta: { defaultName: "x" } };
    expect(getCredentialNames(creds)).toEqual([]);
  });

  it("returns credential entry names, filtering reserved keys", () => {
    const creds: ProviderCredentials = {
      primary: { key: "k1" },
      "backup-1": { key: "k2" },
      type: "api_key",
      __meta: { defaultName: "primary" },
    };
    expect(getCredentialNames(creds)).toEqual(["primary", "backup-1"]);
  });

  it("preserves insertion order", () => {
    const creds: ProviderCredentials = {
      zebra: { key: "z" },
      alpha: { key: "a" },
    };
    expect(getCredentialNames(creds)).toEqual(["zebra", "alpha"]);
  });
});

// ─── getDefaultCredentialName ────────────────────────────────────────────────

describe("getDefaultCredentialName", () => {
  it("returns undefined for null/undefined", () => {
    expect(getDefaultCredentialName(null)).toBeUndefined();
    expect(getDefaultCredentialName(undefined)).toBeUndefined();
  });

  it("returns undefined for empty credentials", () => {
    expect(getDefaultCredentialName({})).toBeUndefined();
  });

  it("returns undefined for only reserved keys", () => {
    const creds: ProviderCredentials = { type: "oauth", __meta: {} };
    expect(getDefaultCredentialName(creds)).toBeUndefined();
  });

  it("returns meta default when it exists and is valid", () => {
    const creds: ProviderCredentials = {
      work: { key: "w" },
      personal: { key: "p" },
      __meta: { defaultName: "personal" },
    };
    expect(getDefaultCredentialName(creds)).toBe("personal");
  });

  it("ignores meta default when it references a non-existent name", () => {
    const creds: ProviderCredentials = {
      work: { key: "w" },
      __meta: { defaultName: "deleted" },
    };
    // Falls through: no "primary", so returns first
    expect(getDefaultCredentialName(creds)).toBe("work");
  });

  it("prefers 'primary' over first entry when no meta default", () => {
    const creds: ProviderCredentials = {
      "backup-1": { key: "b" },
      primary: { key: "p" },
    };
    expect(getDefaultCredentialName(creds)).toBe("primary");
  });

  it("falls back to first entry when no meta default and no 'primary'", () => {
    const creds: ProviderCredentials = {
      work: { key: "w" },
      personal: { key: "p" },
    };
    expect(getDefaultCredentialName(creds)).toBe("work");
  });
});

// ─── ensureCredentialMeta ────────────────────────────────────────────────────

describe("ensureCredentialMeta", () => {
  it("does not throw for null input", () => {
    expect(() => ensureCredentialMeta(null)).not.toThrow();
  });

  it("does not throw for undefined input", () => {
    expect(() => ensureCredentialMeta(undefined)).not.toThrow();
  });

  it("sets __meta.defaultName to the resolved default", () => {
    const creds: ProviderCredentials = {
      primary: { key: "k1" },
      "backup-1": { key: "k2" },
    };
    ensureCredentialMeta(creds);
    expect(creds.__meta?.defaultName).toBe("primary");
  });

  it("preserves existing meta fields while adding defaultName", () => {
    const creds: ProviderCredentials = {
      work: { key: "w" },
      __meta: { someOther: "value" } as any,
    };
    ensureCredentialMeta(creds);
    expect(creds.__meta).toEqual({ someOther: "value", defaultName: "work" });
  });

  it("removes defaultName from __meta when no credentials exist", () => {
    const creds: ProviderCredentials = {
      __meta: { defaultName: "gone" },
    };
    ensureCredentialMeta(creds);
    expect(creds.__meta?.defaultName).toBeUndefined();
  });

  it("mutates the object in-place", () => {
    const creds: ProviderCredentials = { primary: { key: "k" } };
    ensureCredentialMeta(creds);
    expect(creds.__meta?.defaultName).toBe("primary");
  });

  it("handles __meta being a non-object gracefully", () => {
    const creds: ProviderCredentials = {
      primary: { key: "k" },
      __meta: "invalid" as any,
    };
    ensureCredentialMeta(creds);
    expect(creds.__meta).toEqual({ defaultName: "primary" });
  });
});

// ─── setDefaultCredentialName ────────────────────────────────────────────────

describe("setDefaultCredentialName", () => {
  it("sets the specified name as default when it exists", () => {
    const creds: ProviderCredentials = {
      work: { key: "w" },
      personal: { key: "p" },
    };
    setDefaultCredentialName(creds, "personal");
    expect(creds.__meta?.defaultName).toBe("personal");
  });

  it("falls back to resolved default when name doesn't exist", () => {
    const creds: ProviderCredentials = {
      primary: { key: "p" },
      work: { key: "w" },
    };
    setDefaultCredentialName(creds, "nonexistent");
    expect(creds.__meta?.defaultName).toBe("primary");
  });

  it("falls back to resolved default when name is undefined", () => {
    const creds: ProviderCredentials = {
      first: { key: "f" },
    };
    setDefaultCredentialName(creds);
    expect(creds.__meta?.defaultName).toBe("first");
  });

  it("removes defaultName when no credentials exist", () => {
    const creds: ProviderCredentials = {
      __meta: { defaultName: "old" },
    };
    setDefaultCredentialName(creds);
    expect(creds.__meta?.defaultName).toBeUndefined();
  });

  it("preserves existing meta fields", () => {
    const creds: ProviderCredentials = {
      work: { key: "w" },
      __meta: { other: "data" } as any,
    };
    setDefaultCredentialName(creds, "work");
    expect(creds.__meta).toEqual({ other: "data", defaultName: "work" });
  });
});

// ─── normalizeCredentialProviders ────────────────────────────────────────────

describe("normalizeCredentialProviders", () => {
  it("does nothing for undefined input", () => {
    expect(() => normalizeCredentialProviders(undefined)).not.toThrow();
  });

  it("ensures meta for all providers", () => {
    const credentials: Record<string, ProviderCredentials> = {
      anthropic: { primary: { key: "a" } },
      openai: { work: { key: "o" }, personal: { key: "p" } },
    };
    normalizeCredentialProviders(credentials);
    expect(credentials.anthropic.__meta?.defaultName).toBe("primary");
    expect(credentials.openai.__meta?.defaultName).toBe("work");
  });
});
