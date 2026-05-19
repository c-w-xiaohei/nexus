import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("package exports", () => {
  it("points the public type entry at the generated declaration file", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as {
      types: string;
      exports: { ".": { types: string; import: string; require?: string } };
    };

    expect(manifest.types).toBe("./dist/index.d.ts");
    expect(manifest.exports["."].types).toBe("./dist/index.d.ts");
    expect(manifest.exports["."].import).toBe("./dist/index.mjs");
    expect(manifest.exports["."].require).toBeUndefined();
  });
});
