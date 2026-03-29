import { describe, it, expect, vi } from "vitest";

// extensions/index.ts is the pi extension entry point. Its command handlers
// and event listeners depend on the pi runtime API (ExtensionAPI), which would
// require a full mock to integration-test. The core business logic delegated
// by these handlers (error classification, exhaustion tracking, credential
// picking, group resolution) is covered in tests/ha-core.test.ts and
// tests/credentialMeta.test.ts (115 tests total).
//
// This file provides structural smoke tests verifying that the module loads
// cleanly and wires up the expected pi API surface.

describe("extensions/index.ts", () => {
  it("exports a default function (the extension entry point)", async () => {
    const mod = await import("../extensions/index.ts");
    expect(typeof mod.default).toBe("function");
  });

  it("registers expected event listeners and commands when called", async () => {
    const on = vi.fn();
    const registerCommand = vi.fn();
    const piMock = {
      on,
      registerCommand,
      appendEntry: vi.fn(),
      setModel: vi.fn(),
      sendUserMessage: vi.fn(),
    };

    const { default: extensionFactory } = await import("../extensions/index.ts");
    extensionFactory(piMock as any);

    // Event listeners
    const eventNames = on.mock.calls.map((c: any[]) => c[0]);
    expect(eventNames).toContain("session_start");
    expect(eventNames).toContain("turn_start");
    expect(eventNames).toContain("turn_end");

    // Commands
    const commandNames = registerCommand.mock.calls.map((c: any[]) => c[0]);
    expect(commandNames).toContain("ha");
    expect(commandNames).toContain("ha-rename");
    expect(commandNames).toContain("ha-group");
    expect(commandNames).toContain("ha-group-delete");
    expect(commandNames).toContain("ha-activate");
    expect(commandNames).toContain("ha-clear");
  });
});
