import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("built node-ipc package", () => {
  it("imports the ESM artifact without bundling node fs/promises incorrectly", async () => {
    const result = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      "import('./dist/index.mjs').then((mod) => { if (!mod.usingNodeIpcDaemon) process.exit(2); })",
    ]);

    expect(result.stderr).toBe("");
  });
});
