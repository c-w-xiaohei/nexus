import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const forbiddenPatterns = [
  "ReactCurrentDispatcher",
  "__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED",
  "react.element",
  "ReactCurrentOwner",
  "jsxDEV",
];

const distFiles = ["dist/index.mjs", "dist/index.js"];
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const failures = [];

for (const distFile of distFiles) {
  const filePath = path.join(packageRoot, distFile);
  const contents = await readFile(filePath, "utf8");

  for (const pattern of forbiddenPatterns) {
    if (contents.includes(pattern)) {
      failures.push(
        `${distFile} contains bundled React internals marker: ${pattern}`,
      );
    }
  }
}

if (failures.length > 0) {
  throw new Error(failures.join("\n"));
}
