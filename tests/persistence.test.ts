import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  fsMocks.readFile.mockImplementation(actual.readFile);
  fsMocks.writeFile.mockImplementation(actual.writeFile);
  return { ...actual, readFile: fsMocks.readFile, writeFile: fsMocks.writeFile };
});

describe("file persistence", () => {
  it("propagates non-ENOENT read errors before invoking the update", async () => {
    const { withFileLock } = await import("../extensions/index.ts");
    const dir = mkdtempSync(join(tmpdir(), "pi-ha-"));
    const filePath = join(dir, "auth.json");
    writeFileSync(filePath, "{\"existing\":{\"key\":\"old\"}}", "utf-8");
    const readError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const update = vi.fn();

    fsMocks.readFile.mockImplementation((path: string, encoding: BufferEncoding) => {
      if (path === filePath) return Promise.reject(readError);
      return import("fs/promises").then(({ readFile }) => readFile(path, encoding));
    });

    await expect(withFileLock(filePath, async (raw) => {
      update(raw);
      return { raw: "{}", result: undefined };
    })).rejects.toBe(readError);
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the previous content when the temporary-file write fails", async () => {
    const { withFileLock } = await import("../extensions/index.ts");
    const dir = mkdtempSync(join(tmpdir(), "pi-ha-"));
    const filePath = join(dir, "ha.json");
    writeFileSync(filePath, "{\"existing\":true}", "utf-8");
    const writeError = new Error("disk full");

    fsMocks.readFile.mockImplementation(async (path: string, encoding: BufferEncoding) => {
      const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
      return actual.readFile(path, encoding);
    });
    fsMocks.writeFile.mockImplementation(async (path: string, data: string, options: { flag?: string }) => {
      if (path === filePath && options.flag === "wx") {
        throw Object.assign(new Error("already exists"), { code: "EEXIST" });
      }
      const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
      await actual.writeFile(path, data, options);
      throw writeError;
    });

    await expect(withFileLock(filePath, async () => ({
      raw: "{\"replacement\":true}",
      result: undefined,
    }))).rejects.toBe(writeError);
    expect(readFileSync(filePath, "utf-8")).toBe("{\"existing\":true}");
  });

  it("does not replace the file when the update cannot parse its content", async () => {
    const { withFileLock } = await import("../extensions/index.ts");
    const dir = mkdtempSync(join(tmpdir(), "pi-ha-"));
    const filePath = join(dir, "ha.json");
    const existing = "{\"existing\":true}";
    writeFileSync(filePath, existing, "utf-8");

    await expect(withFileLock(filePath, async (raw) => {
      JSON.parse(`${raw},`);
      return { raw: "{\"replacement\":true}", result: undefined };
    })).rejects.toThrow(SyntaxError);
    expect(readFileSync(filePath, "utf-8")).toBe(existing);
  });
});
