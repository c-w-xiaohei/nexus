import type { ChromeUserMeta } from './types/meta';

/**
 * Pre-defined matchers for common Chrome extension scenarios
 */
export const ChromeMatchers = {
  /**
   * Match any content script
   */
  anyContentScript: (identity: ChromeUserMeta) =>
    identity.context === 'content-script',

  /**
   * Match any popup
   */
  anyPopup: (identity: ChromeUserMeta) =>
    identity.context === 'popup',

  /**
   * Match background script
   */
  background: (identity: ChromeUserMeta) =>
    identity.context === 'background',

  /**
   * Match content script in specific tab
   */
  contentScriptInTab: (tabId: number, frameId: number = 0) =>
    (identity: ChromeUserMeta) =>
      identity.context === 'content-script' &&
      identity.tabId === tabId &&
      identity.frameId === frameId,

  /**
   * Match active content scripts
   */
  activeContentScript: (identity: ChromeUserMeta) =>
    identity.context === 'content-script' &&
    identity.isActive === true,

  /**
   * Match content scripts by URL pattern
   */
  contentScriptByUrl: (urlPattern: string | RegExp) =>
    (identity: ChromeUserMeta) => {
      if (identity.context !== 'content-script') return false;
      
      if (typeof urlPattern === 'string') {
        return identity.url.includes(urlPattern);
      }
      return urlPattern.test(identity.url);
    },

  /**
   * Match content scripts by origin
   */
  contentScriptByOrigin: (origin: string) =>
    (identity: ChromeUserMeta) =>
      identity.context === 'content-script' &&
      identity.origin === origin,
};
