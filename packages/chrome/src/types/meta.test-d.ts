import {
  createBackgroundScriptConfig,
  createContentScriptConfig,
  createDevToolsPageConfig,
  createExtensionPageConfig,
  createOffscreenDocumentConfig,
  createOptionsPageConfig,
  createPopupConfig,
  usingBackgroundScript,
  usingContentScript,
  usingDevToolsPage,
  usingExtensionPage,
  usingOffscreenDocument,
  usingOptionsPage,
  usingPopup,
} from "../factory";
import type {
  ChromeAdapterModel,
  ChromeConnectionTarget,
  ChromeContentScriptMeta,
} from "./meta";
import { chromeTarget } from "./meta";
import {
  Token,
  type AdapterModel,
  type ConnectionWhere,
  type NexusInstance,
} from "@nexus-js/core";

type AppMeta = { feature: string };

interface OtherAdapterModel extends AdapterModel {
  contextMeta: { context: "other" };
  connectionMeta: { other: true };
  connectionTarget: { kind: "other" };
}

interface PingService {
  ping(): string;
}

const backgroundTarget: ChromeConnectionTarget = { kind: "background" };
const contentTarget: ChromeConnectionTarget = {
  kind: "content-frame",
  tabId: 1,
  frameId: 0,
};
void backgroundTarget;
void contentTarget;

const backgroundConstructor = chromeTarget.background();
const contentConstructor = chromeTarget.contentDocument({
  tabId: 1,
  documentId: "document-1",
});
void backgroundConstructor;
void contentConstructor;

const where: ConnectionWhere<ChromeAdapterModel> = (
  _contextMeta,
  _connectionMeta,
) => true;
void where;
// @ts-expect-error target values cannot be predicates.
const targetAsWhere: ConnectionWhere<ChromeAdapterModel> =
  backgroundConstructor;
void targetAsWhere;
// @ts-expect-error frame targets require a frame ID.
chromeTarget.contentFrame({ tabId: 1 });
// @ts-expect-error document targets require a document ID.
chromeTarget.contentDocument({ tabId: 1 });

const contentMeta: ChromeContentScriptMeta = {
  context: "content-script",
  url: "https://example.com",
  origin: "https://example.com",
};
void contentMeta;

const model: ChromeAdapterModel = {
  contextMeta: contentMeta,
  connectionMeta: { observed: { sender: undefined } },
  connectionTarget: contentTarget,
};
void model;

// @ts-expect-error selected routing data is not public connection metadata.
model.connectionMeta.selected;

const contentMetaWithoutRouteFields: ChromeContentScriptMeta = {
  context: "content-script",
  url: "https://example.com",
  origin: "https://example.com",
};
void contentMetaWithoutRouteFields;

createBackgroundScriptConfig<AppMeta>({ app: { feature: "background" } });
usingBackgroundScript<AppMeta>({ app: { feature: "background" } });
const backgroundNexus: NexusInstance<ChromeAdapterModel<AppMeta>> =
  usingBackgroundScript<AppMeta>({ app: { feature: "background" } });
const chromePingToken = new Token<PingService, ChromeAdapterModel<AppMeta>>(
  "chrome-model-bound-ping",
);
void backgroundNexus.create(chromePingToken, {
  target: chromeTarget.contentFrame({ tabId: 1, frameId: 0 }),
  where: (_contextMeta: AppMeta, _connectionMeta: object) => true,
});
const otherPingToken = new Token<PingService, OtherAdapterModel>(
  "other-model-bound-ping",
);
// @ts-expect-error Chrome instances reject tokens bound to another adapter model.
void backgroundNexus.create(otherPingToken, {
  target: { kind: "other" },
});
createContentScriptConfig<AppMeta>({ app: { feature: "content" } });
usingContentScript<AppMeta>({ app: { feature: "content" } });
createPopupConfig<AppMeta>({ app: { feature: "popup" }, tabId: 1 });
usingPopup<AppMeta>({ app: { feature: "popup" }, windowId: 1 });
createOptionsPageConfig<AppMeta>({ app: { feature: "options" } });
usingOptionsPage<AppMeta>({ app: { feature: "options" } });
createDevToolsPageConfig<AppMeta>({ app: { feature: "devtools" } });
usingDevToolsPage<AppMeta>({ app: { feature: "devtools" } });
createOffscreenDocumentConfig<AppMeta>({
  reason: "audio-processing",
  app: { feature: "offscreen" },
});
usingOffscreenDocument<AppMeta>({
  reason: "audio-processing",
  app: { feature: "offscreen" },
});

// @ts-expect-error app is required when TAppMeta is provided.
createBackgroundScriptConfig<AppMeta>();
// @ts-expect-error app is required when TAppMeta is provided.
usingBackgroundScript<AppMeta>();
// @ts-expect-error app is required when TAppMeta is provided.
createContentScriptConfig<AppMeta>();
// @ts-expect-error app is required when TAppMeta is provided.
usingContentScript<AppMeta>();
// @ts-expect-error app is required when TAppMeta is provided.
createPopupConfig<AppMeta>();
// @ts-expect-error app is required when TAppMeta is provided.
usingPopup<AppMeta>();
// @ts-expect-error app is required when TAppMeta is provided.
createOptionsPageConfig<AppMeta>();
// @ts-expect-error app is required when TAppMeta is provided.
usingOptionsPage<AppMeta>();
// @ts-expect-error app is required when TAppMeta is provided.
createDevToolsPageConfig<AppMeta>();
// @ts-expect-error app is required when TAppMeta is provided.
usingDevToolsPage<AppMeta>();
// @ts-expect-error app is required when TAppMeta is provided.
createOffscreenDocumentConfig<AppMeta>({ reason: "audio-processing" });
// @ts-expect-error app is required when TAppMeta is provided.
usingOffscreenDocument<AppMeta>({ reason: "audio-processing" });
// @ts-expect-error string shorthand cannot provide app when TAppMeta is provided.
usingOffscreenDocument<AppMeta>("audio-processing");

createExtensionPageConfig({
  context: "extension-page",
  page: "settings.html",
});

createExtensionPageConfig({
  context: "side-panel",
  page: "panel.html",
});

createExtensionPageConfig({
  context: "reports",
  app: { feature: "reports" },
});

usingExtensionPage({
  context: "reports",
  app: { feature: "reports" },
});
const extensionNexus: NexusInstance<
  ChromeAdapterModel<AppMeta, { context: "reports"; app: AppMeta }>
> = usingExtensionPage<AppMeta, { context: "reports"; app: AppMeta }>({
  context: "reports",
  app: { feature: "reports" },
});
void extensionNexus;

createExtensionPageConfig({
  context: "side-panel",
  page: "panel.html",
  app: { feature: "panel" },
});

usingExtensionPage({
  context: "side-panel",
  page: "panel.html",
});

// Extension-page app/custom metadata is inference-first. Use `satisfies` at the
// call site to validate a named app payload shape when needed.
createExtensionPageConfig({
  context: "settings-page",
  page: "settings.html",
  app: { feature: "settings" } satisfies AppMeta,
});

// @ts-expect-error custom extension page meta cannot reuse a built-in context.
createExtensionPageConfig<never, { context: "popup"; page: string }>({
  context: "popup",
  page: "settings.html",
});

// @ts-expect-error inferred custom extension page meta cannot reuse a built-in context.
createExtensionPageConfig({ context: "popup" });

// @ts-expect-error inferred custom extension page meta cannot reuse a built-in context.
usingExtensionPage({ context: "background" });

// @ts-expect-error inferred custom extension page meta cannot reuse a built-in context.
createExtensionPageConfig({
  context: "content-script",
  app: { feature: "content" },
});

// @ts-expect-error inferred custom extension page meta cannot reuse a built-in context.
usingExtensionPage({ context: "options-page", app: { feature: "options" } });

// @ts-expect-error inferred custom extension page meta cannot reuse a built-in context.
createExtensionPageConfig({ context: "devtools-page" });

// @ts-expect-error inferred custom extension page meta cannot reuse a built-in context.
usingExtensionPage({ context: "offscreen-document" });
