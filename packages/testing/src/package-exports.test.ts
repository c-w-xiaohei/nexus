import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execPath } from "node:process";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("package exports", () => {
  it("shares Core call identity when consuming the built testing package", async () => {
    const { stderr } = await promisify(execFile)(
      execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { Nexus, Token } from "@nexus-js/core";
      import { createMockNexus } from "./dist/index.mjs";
      const mock = createMockNexus();
       const token = new Token("testing:built-call");
       mock.service(token, { ping: () => "pong" }, {
         contextMeta: { context: "host" }, connectionMeta: {},
       });
       const connection = await mock.nexus.connect({ where: (meta) => meta.context === "host" });
       const proxy = connection.get(token);
      const call = proxy.ping();
      assert.equal((await Nexus.safeCall(call)).unwrap(), "pong");
      assert.equal(await call, "pong");
      assert.equal(Nexus.getProxyStatus(proxy).type, "active");
      call.connection.disconnect();
      assert.equal(Nexus.getProxyStatus(proxy).type, "disconnected");
    `,
      ],
      { cwd: packageRoot },
    );
    expect(stderr).toBe("");
  });
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
