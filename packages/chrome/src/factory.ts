import { nexus, type NexusConfig } from "@nexus-js/core";
import type {
  ChromeUserMeta,
  ChromePlatformMeta,
  BackgroundMeta,
  ContentScriptMeta,
  PopupMeta,
  OptionsPageMeta,
  DevToolsPageMeta,
  OffscreenDocumentMeta,
} from "./types/meta";
import { BackgroundEndpoint } from "./endpoints/background";
import { ContentScriptEndpoint } from "./endpoints/content-script";
import { UIClientEndpoint } from "./endpoints/ui-client";
import { ChromeMatchers } from "./matchers";

/**
 * Factory function for background script context
 */
export function usingBackgroundScript() {
  const backgroundMeta: BackgroundMeta = {
    context: "background",
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
  };

  const config: NexusConfig<ChromeUserMeta, ChromePlatformMeta> = {
    endpoint: {
      meta: backgroundMeta,
      implementation: new BackgroundEndpoint(),
    },
    matchers: {
      "any-content-script": ChromeMatchers.anyContentScript,
      "any-popup": ChromeMatchers.anyPopup,
      "active-content-script": ChromeMatchers.activeContentScript,
    },
    descriptors: {
      background: { context: "background" },
    },
  };

  return nexus.configure(config);
}

/**
 * Factory function for content script context
 */
export function usingContentScript() {
  const contentScriptMeta: ContentScriptMeta = {
    context: "content-script",
    url: window.location.href,
    origin: window.location.origin,
    // tabId and frameId will be filled by background during handshake
    tabId: -1,
    frameId: -1,
    isActive: !document.hidden,
  };

  const config: NexusConfig<ChromeUserMeta, ChromePlatformMeta> = {
    endpoint: {
      meta: contentScriptMeta,
      implementation: new ContentScriptEndpoint(),
      connectTo: [{ descriptor: { context: "background" } }],
    },
    matchers: {
      background: ChromeMatchers.background,
    },
    descriptors: {
      background: { context: "background" },
    },
  };

  const nexusInstance = nexus.configure(config);

  // Automatically update isActive status based on page visibility
  document.addEventListener("visibilitychange", () => {
    nexusInstance.updateIdentity({
      isActive: !document.hidden,
    } as ContentScriptMeta);
  });

  return nexusInstance;
}

/**
 * Factory function for popup context
 */
export async function usingPopup() {
  // Get current active tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id || -1;

  const popupMeta: PopupMeta = {
    context: "popup",
    tabId,
  };

  const config: NexusConfig<ChromeUserMeta, ChromePlatformMeta> = {
    endpoint: {
      meta: popupMeta,
      implementation: new UIClientEndpoint(), // Use generic UI client endpoint
      connectTo: [{ descriptor: { context: "background" } }],
    },
    matchers: {
      background: ChromeMatchers.background,
    },
    descriptors: {
      background: { context: "background" },
    },
  };

  return nexus.configure(config);
}

/**
 * Factory function for options page context
 */
export function usingOptionsPage() {
  const optionsPageMeta: OptionsPageMeta = {
    context: "options-page",
    windowId: chrome.windows.WINDOW_ID_CURRENT,
  };

  const config: NexusConfig<ChromeUserMeta, ChromePlatformMeta> = {
    endpoint: {
      meta: optionsPageMeta,
      implementation: new UIClientEndpoint(),
      connectTo: [{ descriptor: { context: "background" } }],
    },
    matchers: {
      background: ChromeMatchers.background,
    },
    descriptors: {
      background: { context: "background" },
    },
  };

  return nexus.configure(config);
}

/**
 * Factory function for devtools page context
 */
export function usingDevToolsPage() {
  const devToolsPageMeta: DevToolsPageMeta = {
    context: "devtools-page",
    inspectedTabId: chrome.devtools.inspectedWindow.tabId,
  };

  const config: NexusConfig<ChromeUserMeta, ChromePlatformMeta> = {
    endpoint: {
      meta: devToolsPageMeta,
      implementation: new UIClientEndpoint(),
      connectTo: [{ descriptor: { context: "background" } }],
    },
    matchers: {
      background: ChromeMatchers.background,
    },
    descriptors: {
      background: { context: "background" },
    },
  };

  return nexus.configure(config);
}

/**
 * Factory function for offscreen document context
 */
export function usingOffscreenDocument(reason: string) {
  const offscreenDocumentMeta: OffscreenDocumentMeta = {
    context: "offscreen-document",
    reason: reason,
  };

  const config: NexusConfig<ChromeUserMeta, ChromePlatformMeta> = {
    endpoint: {
      meta: offscreenDocumentMeta,
      implementation: new UIClientEndpoint(),
      connectTo: [{ descriptor: { context: "background" } }],
    },
    matchers: {
      background: ChromeMatchers.background,
    },
    descriptors: {
      background: { context: "background" },
    },
  };

  return nexus.configure(config);
}
