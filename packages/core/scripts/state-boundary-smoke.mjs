import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(thisDir, "..");

const requiredArtifacts = [
  "dist/state/index.mjs",
  "dist/state/index.js",
  "dist/state/index.d.ts",
];

for (const relativePath of requiredArtifacts) {
  await access(path.join(pkgDir, relativePath), constants.F_OK);
}

const require = createRequire(import.meta.url);
const resolvedByExports = require.resolve("@nexus-js/core/state");

if (!resolvedByExports.includes(`${path.sep}dist${path.sep}state${path.sep}`)) {
  throw new Error(
    `Expected @nexus-js/core/state to resolve to dist artifacts, got: ${resolvedByExports}`,
  );
}

if (resolvedByExports.includes(`${path.sep}src${path.sep}`)) {
  throw new Error(
    `Expected @nexus-js/core/state to avoid source aliasing, got: ${resolvedByExports}`,
  );
}

const stateModule = await import("@nexus-js/core/state");

if (typeof stateModule.connectNexusStore !== "function") {
  throw new Error("Expected @nexus-js/core/state to expose connectNexusStore");
}

if (typeof stateModule.NexusStoreProtocolError !== "function") {
  throw new Error(
    "Expected @nexus-js/core/state to expose NexusStoreProtocolError",
  );
}
