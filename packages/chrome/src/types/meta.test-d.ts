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

type AppMeta = { feature: string };

createBackgroundScriptConfig<AppMeta>({ app: { feature: "background" } });
usingBackgroundScript<AppMeta>({ app: { feature: "background" } });
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
