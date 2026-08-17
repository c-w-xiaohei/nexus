import type { AdapterModel, ConnectionMeta } from "@nexus-js/core";

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
  | ChromeOffscreenDocumentMeta<TAppMeta>;

export type ChromeBackgroundMeta<TAppMeta = never> = {
  context: "background";
  extensionId: string;
  version?: string;
} & AppMeta<TAppMeta>;

export type ChromeContentScriptMeta<TAppMeta = never> = {
  context: "content-script";
  url: string;
  origin: string;
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
export type ChromeConnectionTarget =
  | ChromeBackgroundTarget
  | ChromeContentFrameTarget
  | ChromeContentDocumentTarget;

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
};

export interface ChromeObservedSender {
  readonly tab?: Readonly<{ id?: number; windowId?: number }>;
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
