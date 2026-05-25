import type { PlatformMeta } from "@nexus-js/core";

export type ChromeBuiltinContext =
  | "background"
  | "content-script"
  | "popup"
  | "options-page"
  | "devtools-page"
  | "offscreen-document";

type AppMeta<TAppMeta> = [TAppMeta] extends [never]
  ? { app?: never }
  : { app: TAppMeta };

export type RejectBuiltinContext<TMeta> = TMeta extends {
  context: infer TContext;
}
  ? TContext extends ChromeBuiltinContext
    ? never
    : TMeta
  : TMeta;

/**
 * Chrome extension endpoint metadata using discriminated union types
 * for type-safe context identification
 */
export type ChromeEndpointMeta<
  TAppMeta = never,
  TCustomMeta extends { context: string } = never,
> = ChromeBuiltinEndpointMeta<TAppMeta> | RejectBuiltinContext<TCustomMeta>;

export type ChromeBuiltinEndpointMeta<TAppMeta = never> =
  | ChromeBackgroundMeta<TAppMeta>
  | ChromeContentScriptMeta<TAppMeta>
  | ChromePopupMeta<TAppMeta>
  | ChromeOptionsPageMeta<TAppMeta>
  | ChromeDevToolsPageMeta<TAppMeta>
  | ChromeOffscreenDocumentMeta<TAppMeta>;

/**
 * Type helpers for specific contexts
 */
export type ChromeBackgroundMeta<TAppMeta = never> = {
  context: "background";
  extensionId: string;
  version?: string;
} & AppMeta<TAppMeta>;

export type ChromeContentScriptMeta<TAppMeta = never> = {
  context: "content-script";
  url: string;
  origin: string;
  tabId?: number;
  frameId?: number;
  isVisible?: boolean;
} & AppMeta<TAppMeta>;

export type ChromePopupMeta<TAppMeta = never> = {
  context: "popup";
  tabId?: number;
  windowId?: number;
} & AppMeta<TAppMeta>;

export type ChromeOptionsPageMeta<TAppMeta = never> = {
  context: "options-page";
  windowId?: number;
} & AppMeta<TAppMeta>;

export type ChromeDevToolsPageMeta<TAppMeta = never> = {
  context: "devtools-page";
  inspectedTabId: number;
} & AppMeta<TAppMeta>;

export type ChromeOffscreenDocumentMeta<TAppMeta = never> = {
  context: "offscreen-document";
  reason: string;
  tabId?: number;
} & AppMeta<TAppMeta>;

/**
 * Chrome platform-specific metadata from chrome.runtime.Port.sender
 */
export interface ChromePlatformMeta extends PlatformMeta {
  sender?: chrome.runtime.MessageSender;
}
