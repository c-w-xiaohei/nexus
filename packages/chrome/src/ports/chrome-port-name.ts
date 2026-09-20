import type { ChromePageTarget } from "../types/meta.js";

const PORT_PREFIX = "nexus.chrome/1";

export function isNexusChromePortName(name: string): boolean {
  return name.startsWith(`${PORT_PREFIX}/`);
}

/** Canonical names used to filter native Chrome Ports before Core sees them. */
export const chromePortName = {
  background: `${PORT_PREFIX}/background`,
  contentScript: `${PORT_PREFIX}/content-script`,
  page: (target: ChromePageTarget): string => {
    switch (target.kind) {
      case "popup":
        return `${PORT_PREFIX}/popup/window/${target.windowId}`;
      case "options-page":
        return `${PORT_PREFIX}/options-page`;
      case "side-panel":
        return `${PORT_PREFIX}/side-panel/window/${target.windowId}`;
      case "devtools-page":
        return `${PORT_PREFIX}/devtools-page/tab/${target.inspectedTabId}`;
      case "offscreen-document":
        return `${PORT_PREFIX}/offscreen-document`;
      case "extension-page":
        return `${PORT_PREFIX}/extension-page/${encodeURIComponent(target.endpointId)}`;
    }
  },
};
