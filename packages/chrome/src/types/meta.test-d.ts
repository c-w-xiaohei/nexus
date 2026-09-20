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
  createSidePanelConfig,
  usingSidePanel,
} from "../factory";
import type {
  ChromeAdapterModel,
  ChromeConnectionTarget,
  ChromeContentScriptMeta,
} from "./meta";
import { chromeTarget } from "./meta";
import { UIClientEndpoint } from "../endpoints/ui-client";
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
const extensionPageConstructor = chromeTarget.extensionPage({
  endpointId: "settings",
});
const popupConstructor = chromeTarget.popup({ windowId: 1 });
const optionsConstructor = chromeTarget.optionsPage();
const devToolsConstructor = chromeTarget.devToolsPage({ inspectedTabId: 1 });
const offscreenConstructor = chromeTarget.offscreenDocument();
const sidePanelConstructor = chromeTarget.sidePanel({ windowId: 1 });
// @ts-expect-error context metadata is not endpoint capability configuration.
new UIClientEndpoint({ context: "reports" });
void backgroundConstructor;
void contentConstructor;
void extensionPageConstructor;
void popupConstructor;
void optionsConstructor;
void devToolsConstructor;
void offscreenConstructor;
void sidePanelConstructor;

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
// @ts-expect-error popup targets require a window.
chromeTarget.popup({});
// @ts-expect-error side-panel targets require a window.
chromeTarget.sidePanel({});

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

createBackgroundScriptConfig<AppMeta>({
  app: { feature: "background" },
  connectTo: [contentTarget],
});
// @ts-expect-error background cannot dial itself.
createBackgroundScriptConfig({ connectTo: [backgroundTarget] });
usingBackgroundScript<AppMeta>({ app: { feature: "background" } });
const backgroundNexus: NexusInstance<ChromeAdapterModel<AppMeta>> =
  usingBackgroundScript<AppMeta>({ app: { feature: "background" } });
const chromePingToken = new Token<PingService, ChromeAdapterModel<AppMeta>>(
  "chrome-model-bound-ping",
);
void backgroundNexus
  .connect({
    target: chromeTarget.contentFrame({ tabId: 1, frameId: 0 }),
    where: (_contextMeta: AppMeta, _connectionMeta: object) => true,
  })
  .then((connection) => connection.get(chromePingToken));
const otherPingToken = new Token<PingService, OtherAdapterModel>(
  "other-model-bound-ping",
);
void backgroundNexus
  .connect({
    target: { kind: "other" },
  })
  .then((connection) => {
    // @ts-expect-error Chrome instances reject tokens bound to another adapter model.
    return connection.get(otherPingToken);
  });
createContentScriptConfig<AppMeta>({ app: { feature: "content" } });
// @ts-expect-error content scripts cannot initiate tabs.connect.
createContentScriptConfig({ connectTo: [contentTarget] });
usingContentScript<AppMeta>({ app: { feature: "content" } });
createPopupConfig<AppMeta>({ app: { feature: "popup" } });
usingPopup<AppMeta>({ app: { feature: "popup" } });
createOptionsPageConfig<AppMeta>({ app: { feature: "options" } });
usingOptionsPage<AppMeta>({ app: { feature: "options" } });
createDevToolsPageConfig<AppMeta>({ app: { feature: "devtools" } });
usingDevToolsPage<AppMeta>({ app: { feature: "devtools" } });
createOffscreenDocumentConfig<AppMeta>({
  reason: "audio-processing",
  app: { feature: "offscreen" },
  connectTo: [backgroundTarget, sidePanelConstructor],
});
createOffscreenDocumentConfig({
  reason: "audio-processing",
  // @ts-expect-error offscreen documents cannot initiate tabs.connect.
  connectTo: [contentTarget],
});
createOffscreenDocumentConfig({
  reason: "audio-processing",
  // @ts-expect-error the singleton offscreen document cannot target itself.
  connectTo: [offscreenConstructor],
});
usingOffscreenDocument<AppMeta>({
  reason: "audio-processing",
  app: { feature: "offscreen" },
});
createSidePanelConfig<AppMeta>({
  app: { feature: "side-panel" },
  connectTo: [backgroundTarget, contentTarget, extensionPageConstructor],
});
usingSidePanel<AppMeta>({
  app: { feature: "side-panel" },
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

createExtensionPageConfig(
  { context: "extension-page", page: "settings.html" },
  { connectTo: [backgroundTarget] },
);

createSidePanelConfig();

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

createSidePanelConfig<AppMeta>({
  app: { feature: "panel" },
});

usingSidePanel();

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
