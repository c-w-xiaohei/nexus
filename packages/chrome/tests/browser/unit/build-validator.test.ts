import { describe, expect, test } from "vitest";
import { validateExtensionBuild } from "../build-extension";

describe("validateExtensionBuild", () => {
  test("accepts a complete WXT Chrome MV3 output", () => {
    const output = {
      "manifest.json": JSON.stringify({
        manifest_version: 3,
        background: { service_worker: "background.js" },
        action: { default_popup: "popup.html" },
        options_ui: { page: "options.html" },
        content_scripts: [
          {
            js: ["content.js"],
            matches: ["http://127.0.0.1:4173/*", "http://127.0.0.1:4174/*"],
            all_frames: true,
            run_at: "document_start",
            world: "ISOLATED",
          },
        ],
        permissions: ["storage", "webNavigation", "offscreen", "tabs"],
        host_permissions: [
          "http://127.0.0.1:4173/*",
          "http://127.0.0.1:4174/*",
        ],
      }),
      "background.js": "export {}",
      "popup.html": '<script src="popup.js"></script>',
      "popup.js": "export {}",
      "options.html": '<script src="options.js"></script>',
      "options.js": "export {}",
      "content.js": "const fixture = true;",
      "workspace.html": '<script src="chunks/workspace.js"></script>',
      "offscreen.html": '<script src="chunks/offscreen.js"></script>',
    };

    expect(validateExtensionBuild(output).manifest).toMatchObject({
      manifest_version: 3,
    });
  });

  test("rejects source paths and bare imports in every executable output", () => {
    const output = {
      "manifest.json": JSON.stringify({
        manifest_version: 3,
        background: { service_worker: "background.js" },
        action: { default_popup: "popup.html" },
        options_ui: { page: "options.html" },
        content_scripts: [
          {
            js: ["content.js"],
            matches: ["http://127.0.0.1:4173/*", "http://127.0.0.1:4174/*"],
            all_frames: true,
            run_at: "document_start",
            world: "ISOLATED",
          },
        ],
        permissions: ["storage", "webNavigation", "offscreen", "tabs"],
        host_permissions: [
          "http://127.0.0.1:4173/*",
          "http://127.0.0.1:4174/*",
        ],
      }),
      "background.js": "import '@nexus-js/core'",
      "popup.html": "",
      "options.html": "",
      "content.js": "const fixture = true;",
      "workspace.html": "",
      "offscreen.html": "",
    };

    expect(() => validateExtensionBuild(output)).toThrow(
      "unresolved bare import",
    );
    expect(() =>
      validateExtensionBuild({
        ...output,
        "background.js": "import '/src/private.js'",
      }),
    ).toThrow("private or source import");
  });
});
