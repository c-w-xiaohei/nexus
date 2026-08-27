import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Nexus Chrome E2E Fixture",
    version: "0.0.0",
    permissions: ["storage", "webNavigation", "offscreen", "tabs"],
    host_permissions: ["http://127.0.0.1:4173/*", "http://127.0.0.1:4174/*"],
  },
});
