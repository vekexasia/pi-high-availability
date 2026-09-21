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
    const { writeFileAtomically } = await import("../extensions/index.ts");
    const dir = mkdtempSync(join(tmpdir(), "pi-ha-"));
    const filePath = join(dir, "ha.json");
    writeFileSync(filePath, "{\"existing\":true}", "utf-8");
    const writeError = new Error("disk full");
    fsMocks.writeFile.mockRejectedValue(writeError);

    await expect(writeFileAtomically(filePath, "{\"replacement\":true}")).rejects.toBe(writeError);
    expect(readFileSync(filePath, "utf-8")).toBe("{\"existing\":true}");
  });
});
