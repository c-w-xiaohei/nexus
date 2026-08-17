import type { ConnectionWhere } from "@nexus-js/core";
import type { ChromeAdapterModel } from "./types/meta";

type ChromeWhere = ConnectionWhere<ChromeAdapterModel>;

export const whereContentScript: ChromeWhere = (contextMeta) =>
  contextMeta.context === "content-script";
export const wherePopup: ChromeWhere = (contextMeta) =>
  contextMeta.context === "popup";
export const whereBackground: ChromeWhere = (contextMeta) =>
  contextMeta.context === "background";
export const whereVisibleContentScript: ChromeWhere = (contextMeta) =>
  contextMeta.context === "content-script" && contextMeta.isVisible === true;
export const whereContentScriptInFrame =
  (tabId: number, frameId: number): ChromeWhere =>
  (contextMeta, connectionMeta) =>
    contextMeta.context === "content-script" &&
    connectionMeta.observed.tabId === tabId &&
    connectionMeta.observed.frameId === frameId;
export const whereContentScriptByUrl =
  (urlPattern: string | RegExp): ChromeWhere =>
  (contextMeta) => {
    if (contextMeta.context !== "content-script") return false;
    if (typeof urlPattern === "string")
      return contextMeta.url.includes(urlPattern);
    const lastIndex = urlPattern.lastIndex;
    try {
      return urlPattern.test(contextMeta.url);
    } finally {
      urlPattern.lastIndex = lastIndex;
    }
  };
export const whereContentScriptByOrigin =
  (origin: string): ChromeWhere =>
  (contextMeta) =>
    contextMeta.context === "content-script" && contextMeta.origin === origin;
