import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureRoot = fileURLToPath(new URL("./extension", import.meta.url));
export const outputDirectory = join(fixtureRoot, ".output", "chrome-mv3");
const requiredPermissions = ["storage", "webNavigation", "offscreen", "tabs"];
const requiredHosts = ["http://127.0.0.1:4173/*", "http://127.0.0.1:4174/*"];

export interface BuildValidation {
  readonly manifest: Record<string, unknown>;
}

export function validateExtensionBuild(
  files: Readonly<Record<string, string>>,
): BuildValidation {
  const manifestText = files["manifest.json"];
  if (!manifestText) throw new Error("missing manifest.json");
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  assert(manifest.manifest_version === 3, "manifest_version must be 3");
  const background = asRecord(manifest.background, "background");
  const worker = asString(
    background.service_worker,
    "background.service_worker",
  );
  const action = asRecord(manifest.action, "action");
  const popup = asString(action.default_popup, "action.default_popup");
  const options = asRecord(manifest.options_ui, "options_ui");
  const optionsPage = asString(options.page, "options_ui.page");
  const content = asArray(manifest.content_scripts, "content_scripts");
  assert(content.length === 1, "expected one content script declaration");
  const script = asRecord(content[0], "content_scripts[0]");
  const contentFiles = asStringArray(script.js, "content_scripts[0].js");
  assertEqual(script.matches, requiredHosts, "content script matches");
  assert(script.all_frames === true, "content script all_frames must be true");
  assert(
    script.run_at === "document_start",
    "content script run_at must be document_start",
  );
  assert(script.world === "ISOLATED", "content script world must be ISOLATED");
  assertEqual(manifest.permissions, requiredPermissions, "permissions");
  assertEqual(manifest.host_permissions, requiredHosts, "host_permissions");

  for (const file of [worker, popup, optionsPage, ...contentFiles]) {
    assert(
      files[file] !== undefined,
      `manifest references missing file: ${file}`,
    );
  }
  for (const asset of ["workspace.html", "offscreen.html"]) {
    assert(files[asset] !== undefined, `missing required asset: ${asset}`);
  }
  for (const [path, source] of Object.entries(files)) {
    assert(!isUnsafeOutputPath(path), `unsafe generated output path: ${path}`);
    if (!path.endsWith(".js")) continue;
    assert(!hasPrivateImport(source), `private or source import in ${path}`);
    assert(!hasBareImport(source), `unresolved bare import in ${path}`);
  }
  return { manifest };
}

async function main(): Promise<void> {
  const files = await readOutput(outputDirectory);
  validateExtensionBuild(files);
}

async function readOutput(directory: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [child, source] of Object.entries(await readOutput(path))) {
        output[join(entry.name, child)] = source;
      }
    } else if (entry.isFile()) {
      output[relative(directory, path)] = await readFile(path, "utf8");
    }
  }
  return output;
}

function hasPrivateImport(source: string): boolean {
  return /(?:from\s*["']|import\s*["'])(?:[^"']*(?:\/src\/|\/tests\/)|@\/)/.test(
    source,
  );
}

function hasBareImport(source: string): boolean {
  return /(?:from\s*["']|import\s*["'])(?![./])[^"]+["']/.test(source);
}

function isUnsafeOutputPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    /(^|\/)(src|tests)(\/|$)/.test(normalized)
  );
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  assert(
    typeof value === "object" && value !== null,
    `${name} must be an object`,
  );
  return value as Record<string, unknown>;
}

function asArray(value: unknown, name: string): unknown[] {
  assert(Array.isArray(value), `${name} must be an array`);
  return value;
}

function asString(value: unknown, name: string): string {
  assert(typeof value === "string", `${name} must be a string`);
  return value;
}

function asStringArray(value: unknown, name: string): string[] {
  const array = asArray(value, name);
  assert(
    array.every((item) => typeof item === "string"),
    `${name} must be strings`,
  );
  return array as string[];
}

function assertEqual(
  value: unknown,
  expected: readonly string[],
  name: string,
): void {
  assert(
    Array.isArray(value) &&
      value.length === expected.length &&
      value.every((item, index) => item === expected[index]),
    `${name} must exactly equal ${expected.join(", ")}`,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
