export type ChromeMatcherMeta = {
  context: string;
  url?: string;
  origin?: string;
  tabId?: number;
  frameId?: number;
  isVisible?: boolean;
};

/**
 * Pre-defined matchers for common Chrome extension scenarios
 */
export const ChromeMatchers = {
  /**
   * Match any content script
   */
  anyContentScript: (identity: ChromeMatcherMeta) =>
    identity.context === "content-script",

  /**
   * Match any popup
   */
  anyPopup: (identity: ChromeMatcherMeta) => identity.context === "popup",

  /**
   * Match background script
   */
  background: (identity: ChromeMatcherMeta) =>
    identity.context === "background",

  /**
   * Match content script in specific tab
   */
  contentScriptInTab: (tabId: number) => (identity: ChromeMatcherMeta) =>
    identity.context === "content-script" && identity.tabId === tabId,

  /**
   * Match content script in specific frame
   */
  contentScriptInFrame:
    (tabId: number, frameId: number) => (identity: ChromeMatcherMeta) =>
      identity.context === "content-script" &&
      identity.tabId === tabId &&
      identity.frameId === frameId,

  /**
   * Match visible content scripts
   */
  visibleContentScript: (identity: ChromeMatcherMeta) =>
    identity.context === "content-script" && identity.isVisible === true,

  /**
   * Match content scripts by URL pattern
   */
  contentScriptByUrl:
    (urlPattern: string | RegExp) => (identity: ChromeMatcherMeta) => {
      if (identity.context !== "content-script") return false;
      if (typeof identity.url !== "string") return false;

      if (typeof urlPattern === "string") {
        return identity.url.includes(urlPattern);
      }
      return urlPattern.test(identity.url);
    },

  /**
   * Match content scripts by origin
   */
  contentScriptByOrigin: (origin: string) => (identity: ChromeMatcherMeta) =>
    identity.context === "content-script" && identity.origin === origin,
};
