import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "../..");
const fixtureRoot = await mkdtemp(
  path.join(os.tmpdir(), "opencode/nexus-react19-import-"),
);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout;
};

try {
  run("pnpm", ["--filter", "@nexus-js/core", "build"]);

  const reactPackOutput = run("pnpm", [
    "--dir",
    packageRoot,
    "pack",
    "--pack-destination",
    fixtureRoot,
  ]);
  const corePackOutput = run("pnpm", [
    "--dir",
    path.join(repoRoot, "packages/core"),
    "pack",
    "--pack-destination",
    fixtureRoot,
  ]);

  const resolvePackedPackage = (packOutput) => {
    const packedPath = packOutput.trim().split("\n").at(-1);
    return path.isAbsolute(packedPath)
      ? packedPath
      : path.join(fixtureRoot, packedPath);
  };

  const reactPackage = resolvePackedPackage(reactPackOutput);
  const corePackage = resolvePackedPackage(corePackOutput);

  await writeFile(
    path.join(fixtureRoot, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2),
  );
  await writeFile(
    path.join(fixtureRoot, "check.mjs"),
    `import { NexusProvider, useNexus, useRemoteStore, useStoreSelector } from "@nexus-js/react";\n\nfor (const [name, value] of Object.entries({ NexusProvider, useNexus, useRemoteStore, useStoreSelector })) {\n  if (typeof value !== "function") {\n    throw new Error(\`Expected named export \${name} to be a function.\`);\n  }\n}\n`,
  );

  run(
    "pnpm",
    [
      "add",
      "--ignore-workspace",
      "--ignore-scripts",
      "react@19",
      "react-dom@19",
      corePackage,
      reactPackage,
    ],
    { cwd: fixtureRoot },
  );
  run("node", ["check.mjs"], { cwd: fixtureRoot });

  const installedReactPackageJson = JSON.parse(
    await readFile(
      path.join(fixtureRoot, "node_modules/react/package.json"),
      "utf8",
    ),
  );
  if (!String(installedReactPackageJson.version).startsWith("19.")) {
    throw new Error(
      `Expected React 19, got ${installedReactPackageJson.version}`,
    );
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
