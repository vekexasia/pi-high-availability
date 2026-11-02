import { afterEach, describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  lockSync: vi.fn(() => vi.fn()),
}));

vi.mock("fs", () => mocks);
vi.mock("fs/promises", () => ({ mkdir: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock("os", () => ({ homedir: () => "/tmp/pi-ha-test-home" }));
vi.mock("proper-lockfile", () => ({ default: { lockSync: mocks.lockSync } }));

const config = {
  groups: {
    default: { name: "default", entries: [] },
    review: { name: "review", entries: [] },
  },
  defaultGroup: "default",
  credentials: {},
};

function createPi() {
  const handlers = new Map<string, (event: unknown, ctx: any) => Promise<void> | void>();
  return {
    pi: {
      on: vi.fn((event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) => {
        handlers.set(event, handler);
      }),
      registerCommand: vi.fn(),
      appendEntry: vi.fn(),
    },
    handlers,
  };
}

async function loadSession(group: string | undefined) {
  vi.resetModules();
  mocks.readFileSync.mockImplementation((path: string) =>
    path.endsWith("ha.json") ? JSON.stringify(config) : "{}",
  );
  const mod = await import("../extensions/index.ts");
  const { pi, handlers } = createPi();
  mod.default(pi as any);
  if (group === undefined) delete process.env.PI_HA_GROUP;
  else process.env.PI_HA_GROUP = group;
  const ui = { notify: vi.fn(), setStatus: vi.fn() };
  const ctx = {
    sessionManager: { getEntries: () => [] },
    ui,
    model: undefined,
  };
  await handlers.get("session_start")?.({}, ctx);
  await handlers.get("turn_start")?.({}, ctx);
  return ui;
}

afterEach(() => {
  delete process.env.PI_HA_GROUP;
  vi.clearAllMocks();
});

// The extension entry point needs a small runtime mock because it reads ha.json
// and registers handlers with Pi. These tests cover session group resolution;
// core failover logic is covered in tests/ha-core.test.ts.

describe("extensions/index.ts", () => {
  it("exports a default function (the extension entry point)", async () => {
    const mod = await import("../extensions/index.ts");
    expect(typeof mod.default).toBe("function");
  });

  it("uses a valid PI_HA_GROUP for the session", async () => {
    const ui = await loadSession("review");

    expect(ui.setStatus).toHaveBeenLastCalledWith("ha", "HA: review (?)");
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("falls back and notifies when PI_HA_GROUP is unknown", async () => {
    const ui = await loadSession("missing");

    expect(ui.setStatus).toHaveBeenLastCalledWith("ha", "HA: default (?)");
    expect(ui.notify).toHaveBeenCalledWith(
      "[HA] Group 'missing' not found. Using default group 'default'.",
      "warning",
    );
  });

  it("keeps the default group when PI_HA_GROUP is absent", async () => {
    const ui = await loadSession(undefined);

    expect(ui.setStatus).toHaveBeenLastCalledWith("ha", "HA: default (?)");
    expect(ui.notify).not.toHaveBeenCalled();
  });
});
