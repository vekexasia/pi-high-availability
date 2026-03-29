import { describe, it, expect } from "vitest";

// extensions/index.ts is the pi extension entry point. Its command handlers
// and event listeners depend on the pi runtime API (ExtensionAPI), which would
// require a full mock to integration-test. The core business logic delegated
// by these handlers (error classification, exhaustion tracking, credential
// picking, group resolution) is covered in tests/ha-core.test.ts and
// tests/credentialMeta.test.ts (115 tests total).
//
// The factory function also reads from ~/.pi/agent/ha.json and auth.json at
// startup; mocking those filesystem calls would require additional setup that
// is out of scope for a lean smoke test. The registration behavior (which
// commands and event listeners are wired) is not tested here for the same reason.
//
// This file provides one structural smoke test: the module loads cleanly and
// exports the extension entry point.

describe("extensions/index.ts", () => {
  it("exports a default function (the extension entry point)", async () => {
    const mod = await import("../extensions/index.ts");
    expect(typeof mod.default).toBe("function");
  });
});
