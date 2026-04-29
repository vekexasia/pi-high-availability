import { describe, expect, it } from "vitest";

import { mergeCredentialProvidersFromDisk } from "../extensions/configMerge";
import type { ProviderCredentials } from "../extensions/credentialMeta";

describe("mergeCredentialProvidersFromDisk", () => {
  it("keeps additive merge behavior for untouched providers", () => {
    const current: Record<string, ProviderCredentials> = {
      anthropic: {
        primary: { key: "current" },
      },
    };
    const disk: Record<string, ProviderCredentials> = {
      anthropic: {
        primary: { key: "current" },
        backup: { key: "backup" },
      },
      openai: {
        primary: { key: "openai" },
      },
    };

    const merged = mergeCredentialProvidersFromDisk(current, disk);

    expect(merged).toEqual({
      anthropic: {
        primary: { key: "current" },
        backup: { key: "backup" },
        __meta: { defaultName: "primary" },
      },
      openai: {
        primary: { key: "openai" },
        __meta: { defaultName: "primary" },
      },
    });
  });

  it("does not resurrect credentials for a replaced provider", () => {
    const current: Record<string, ProviderCredentials> = {
      anthropic: {
        renamed: { key: "current" },
      },
    };
    const disk: Record<string, ProviderCredentials> = {
      anthropic: {
        primary: { key: "current" },
        backup: { key: "backup" },
      },
      openai: {
        primary: { key: "openai" },
      },
    };

    const merged = mergeCredentialProvidersFromDisk(current, disk, {
      replaceProviders: ["anthropic"],
    });

    expect(merged).toEqual({
      anthropic: {
        renamed: { key: "current" },
      },
      openai: {
        primary: { key: "openai" },
        __meta: { defaultName: "primary" },
      },
    });
  });

  it("supports replacing all providers for full clear flows", () => {
    const current: Record<string, ProviderCredentials> = {};
    const disk: Record<string, ProviderCredentials> = {
      anthropic: {
        primary: { key: "current" },
      },
    };

    const merged = mergeCredentialProvidersFromDisk(current, disk, {
      replaceProviders: "all",
    });

    expect(merged).toEqual({});
  });
});
