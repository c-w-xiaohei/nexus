import type { AdapterModel, ConnectionMeta } from "@nexus-js/core";

export type ChromeBuiltinContext =
  | "background"
  | "content-script"
  | "popup"
  | "options-page"
  | "devtools-page"
  | "offscreen-document"
  | "side-panel";

export type ChromeAppMeta<TAppMeta = never> = [TAppMeta] extends [never]
  ? { app?: never }
  : { app: TAppMeta };

export type RejectBuiltinContext<TMeta> = TMeta extends {
  context: infer TContext;
}
  ? TContext extends ChromeBuiltinContext
    ? never
    : TMeta
  : TMeta;

/** Remote context identity exchanged during the Nexus handshake. */
export type ChromeContextMeta<
  TAppMeta = never,
  TCustomMeta extends { context: string } = never,
> = ChromeBuiltinContextMeta<TAppMeta> | RejectBuiltinContext<TCustomMeta>;

export type ChromeBuiltinContextMeta<TAppMeta = never> =
  | ChromeBackgroundMeta<TAppMeta>
  | ChromeContentScriptMeta<TAppMeta>
  | ChromePopupMeta<TAppMeta>
  | ChromeOptionsPageMeta<TAppMeta>
  | ChromeDevToolsPageMeta<TAppMeta>
  | ChromeOffscreenDocumentMeta<TAppMeta>
  | ChromeSidePanelMeta<TAppMeta>;

export type ChromeBackgroundMeta<TAppMeta = never> = {
  context: "background";
  extensionId: string;
  version?: string;
} & ChromeAppMeta<TAppMeta>;

export type ChromeContentScriptMeta<TAppMeta = never> = {
  context: "content-script";
  url: string;
  origin: string;
  isVisible?: boolean;
} & ChromeAppMeta<TAppMeta>;

export type ChromePopupMeta<TAppMeta = never> = {
  context: "popup";
  tabId?: number;
  windowId?: number;
} & ChromeAppMeta<TAppMeta>;
export type ChromeOptionsPageMeta<TAppMeta = never> = {
  context: "options-page";
  windowId?: number;
} & ChromeAppMeta<TAppMeta>;
export type ChromeDevToolsPageMeta<TAppMeta = never> = {
  context: "devtools-page";
  inspectedTabId: number;
} & ChromeAppMeta<TAppMeta>;
export type ChromeOffscreenDocumentMeta<TAppMeta = never> = {
  context: "offscreen-document";
  reason: string;
  tabId?: number;
} & ChromeAppMeta<TAppMeta>;

export type ChromeSidePanelMeta<TAppMeta = never> = {
  context: "side-panel";
  tabId?: number;
  windowId?: number;
} & ChromeAppMeta<TAppMeta>;

export type ChromeBackgroundTarget = Readonly<{ kind: "background" }>;
export type ChromeContentFrameTarget = Readonly<{
  kind: "content-frame";
  tabId: number;
  frameId: number;
}>;
export type ChromeContentDocumentTarget = Readonly<{
  kind: "content-document";
  tabId: number;
  documentId: string;
}>;
export type ChromePopupTarget = Readonly<{
  kind: "popup";
  windowId: number;
}>;
export type ChromeOptionsPageTarget = Readonly<{
  kind: "options-page";
}>;
export type ChromeDevToolsPageTarget = Readonly<{
  kind: "devtools-page";
  inspectedTabId: number;
}>;
export type ChromeOffscreenDocumentTarget = Readonly<{
  kind: "offscreen-document";
}>;
export type ChromeSidePanelTarget = Readonly<{
  kind: "side-panel";
  windowId: number;
}>;
/** Exact application address for a custom extension-owned page. */
export type ChromeExtensionPageTarget = Readonly<{
  kind: "extension-page";
  endpointId: string;
}>;
export type ChromePageTarget =
  | ChromePopupTarget
  | ChromeOptionsPageTarget
  | ChromeDevToolsPageTarget
  | ChromeOffscreenDocumentTarget
  | ChromeSidePanelTarget
  | ChromeExtensionPageTarget;
export type ChromeConnectionTarget =
  | ChromeBackgroundTarget
  | ChromeContentFrameTarget
  | ChromeContentDocumentTarget
  | ChromePageTarget;

export type ChromeBackgroundConnectTarget =
  | ChromeContentFrameTarget
  | ChromeContentDocumentTarget
  | ChromePageTarget;
export type ChromeContentScriptConnectTarget =
  | ChromeBackgroundTarget
  | ChromePageTarget;
export type ChromeExtensionPageConnectTarget = ChromeConnectionTarget;
export type ChromeOffscreenDocumentConnectTarget =
  | ChromeBackgroundTarget
  | Exclude<ChromePageTarget, ChromeOffscreenDocumentTarget>;

export const chromeTarget = {
  background: (): ChromeBackgroundTarget =>
    Object.freeze({ kind: "background" }),
  contentFrame: ({
    tabId,
    frameId,
  }: Readonly<{ tabId: number; frameId: number }>): ChromeContentFrameTarget =>
    Object.freeze({ kind: "content-frame", tabId, frameId }),
  contentDocument: ({
    tabId,
    documentId,
  }: Readonly<{
    tabId: number;
    documentId: string;
  }>): ChromeContentDocumentTarget =>
    Object.freeze({ kind: "content-document", tabId, documentId }),
  popup: ({ windowId }: Readonly<{ windowId: number }>): ChromePopupTarget =>
    Object.freeze({ kind: "popup", windowId }),
  optionsPage: (): ChromeOptionsPageTarget =>
    Object.freeze({ kind: "options-page" }),
  devToolsPage: ({
    inspectedTabId,
  }: Readonly<{ inspectedTabId: number }>): ChromeDevToolsPageTarget =>
    Object.freeze({ kind: "devtools-page", inspectedTabId }),
  offscreenDocument: (): ChromeOffscreenDocumentTarget =>
    Object.freeze({ kind: "offscreen-document" }),
  sidePanel: ({
    windowId,
  }: Readonly<{ windowId: number }>): ChromeSidePanelTarget =>
    Object.freeze({ kind: "side-panel", windowId }),
  extensionPage: ({ endpointId }: Readonly<{ endpointId: string }>) => {
    if (!endpointId) throw new Error("endpointId must be nonempty");
    return Object.freeze({ kind: "extension-page", endpointId });
  },
};

export interface ChromeObservedSender {
  readonly id?: string;
  readonly origin?: string;
  readonly documentLifecycle?: chrome.runtime.MessageSender["documentLifecycle"];
  readonly tab?: Readonly<{
    id?: number;
    windowId?: number;
    incognito?: boolean;
  }>;
  readonly frameId?: number;
  readonly documentId?: string;
  readonly url?: string;
}

export interface ChromeObservedConnectionFacts {
  readonly sender?: ChromeObservedSender;
  readonly tabId?: number;
  readonly windowId?: number;
  readonly frameId?: number;
  readonly documentId?: string;
  readonly incognito?: boolean;
}

/** Local adapter observations for one Chrome Port. */
export interface ChromeConnectionMeta extends ConnectionMeta {
  readonly observed: ChromeObservedConnectionFacts;
}

export interface ChromeAdapterModel<
  TAppMeta = never,
  TCustomMeta extends { context: string } = never,
> extends AdapterModel {
  contextMeta: ChromeContextMeta<TAppMeta, TCustomMeta>;
  connectionMeta: ChromeConnectionMeta;
  connectionTarget: ChromeConnectionTarget;
}
