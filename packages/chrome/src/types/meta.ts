import type { PlatformMetadata } from "@nexus-js/core";

/**
 * Chrome extension user metadata using discriminated union types
 * for type-safe context identification
 */
export type ChromeUserMeta =
  | {
      context: "background";
      extensionId: string;
      version?: string;
      state?: "active" | "inactive" | "suspended";
    }
  | {
      context: "content-script";
      url: string;
      origin: string;
      tabId: number;
      frameId: number;
      isActive?: boolean;
    }
  | {
      context: "popup";
      tabId: number;
      windowId?: number;
    }
  | {
      context: "options-page";
      windowId?: number;
    }
  | {
      context: "devtools-page";
      inspectedTabId: number;
    }
  | {
      context: "offscreen-document";
      reason: string;
      tabId?: number;
    };

/**
 * Chrome platform-specific metadata from chrome.runtime.Port.sender
 */
export interface ChromePlatformMeta extends PlatformMetadata {
  sender?: chrome.runtime.MessageSender;
}

/**
 * Type helpers for specific contexts
 */
export type BackgroundMeta = Extract<ChromeUserMeta, { context: "background" }>;
export type ContentScriptMeta = Extract<
  ChromeUserMeta,
  { context: "content-script" }
>;
export type PopupMeta = Extract<ChromeUserMeta, { context: "popup" }>;
export type OptionsPageMeta = Extract<
  ChromeUserMeta,
  { context: "options-page" }
>;
export type DevToolsPageMeta = Extract<
  ChromeUserMeta,
  { context: "devtools-page" }
>;
export type OffscreenDocumentMeta = Extract<
  ChromeUserMeta,
  { context: "offscreen-document" }
>;
