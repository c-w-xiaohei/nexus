import { nexus, type NexusConfig, type NexusInstance } from "@nexus-js/core";
import type {
  ChromeBackgroundMeta,
  ChromeBuiltinContext,
  ChromeContentScriptMeta,
  ChromeDevToolsPageMeta,
  ChromeContextMeta,
  ChromeAdapterModel,
  ChromeOffscreenDocumentMeta,
  ChromeOptionsPageMeta,
  ChromePopupMeta,
} from "./types/meta.js";
import { BackgroundEndpoint } from "./endpoints/background.js";
import { ContentScriptEndpoint } from "./endpoints/content-script.js";
import { UIClientEndpoint } from "./endpoints/ui-client.js";

type ChromeConfig<
  TAppMeta = never,
  TCustomMeta extends { context: string } = never,
> = NexusConfig<ChromeAdapterModel<TAppMeta, TCustomMeta>>;

type AppOption<TAppMeta> = [TAppMeta] extends [never]
  ? { app?: never }
  : { app: TAppMeta };

type OptionalOptions<TAppMeta, TOptions> = [TAppMeta] extends [never]
  ? [options?: TOptions]
  : [options: TOptions];

export type CreateBackgroundScriptConfigOptions<TAppMeta = never> =
  AppOption<TAppMeta>;

export type CreateContentScriptConfigOptions<TAppMeta = never> =
  AppOption<TAppMeta>;

export type CreatePopupConfigOptions<TAppMeta = never> = AppOption<TAppMeta> & {
  tabId?: number;
  windowId?: number;
};

export type CreateOptionsPageConfigOptions<TAppMeta = never> =
  AppOption<TAppMeta> & {
    windowId?: number;
  };

export type CreateDevToolsPageConfigOptions<TAppMeta = never> =
  AppOption<TAppMeta>;

export type CreateOffscreenDocumentConfigOptions<TAppMeta = never> =
  AppOption<TAppMeta> & {
    reason: string;
    tabId?: number;
  };

type ExtensionPageConfigMeta<
  TAppMeta,
  TCustomMeta extends { context: string },
> = TCustomMeta & AppOption<TAppMeta>;

type ExtensionPageConfigInput<
  TAppMeta,
  TCustomMeta extends { context: string },
> = TCustomMeta &
  (TCustomMeta["context"] extends ChromeBuiltinContext ? never : unknown) &
  AppOption<TAppMeta>;

const chromeBuiltinContexts = new Set<ChromeBuiltinContext>([
  "background",
  "content-script",
  "popup",
  "options-page",
  "devtools-page",
  "offscreen-document",
]);

function backgroundDefaultTarget() {
  return { kind: "background" as const };
}

function configureChrome<
  TAppMeta = never,
  TCustomMeta extends { context: string } = never,
>(
  config: ChromeConfig<TAppMeta, TCustomMeta>,
): NexusInstance<ChromeAdapterModel<TAppMeta, TCustomMeta>> {
  return (
    nexus as unknown as NexusInstance<ChromeAdapterModel<TAppMeta, TCustomMeta>>
  ).configure(config);
}

function isChromeBuiltinContext(
  context: string,
): context is ChromeBuiltinContext {
  return chromeBuiltinContexts.has(context as ChromeBuiltinContext);
}

/**
 * Create pure background script config without mutating the singleton Nexus runtime.
 */
export function createBackgroundScriptConfig<TAppMeta = never>(
  ...[options]: OptionalOptions<
    TAppMeta,
    CreateBackgroundScriptConfigOptions<TAppMeta>
  >
): ChromeConfig<TAppMeta> {
  const backgroundMeta: ChromeBackgroundMeta<TAppMeta> = {
    context: "background",
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    ...options,
  } as ChromeBackgroundMeta<TAppMeta>;

  const config = {
    endpoint: {
      meta: backgroundMeta,
      implementation: new BackgroundEndpoint(),
    },
  } satisfies ChromeConfig<TAppMeta>;

  return config;
}

/**
 * Configure the singleton Nexus runtime as a background script context.
 */
export function usingBackgroundScript<TAppMeta = never>(
  ...[options]: OptionalOptions<
    TAppMeta,
    CreateBackgroundScriptConfigOptions<TAppMeta>
  >
) {
  return configureChrome<TAppMeta>(
    createBackgroundScriptConfig<TAppMeta>(
      ...([options] as OptionalOptions<
        TAppMeta,
        CreateBackgroundScriptConfigOptions<TAppMeta>
      >),
    ),
  );
}

/**
 * Create pure content script config without registering visibility listeners.
 */
export function createContentScriptConfig<TAppMeta = never>(
  ...[options]: OptionalOptions<
    TAppMeta,
    CreateContentScriptConfigOptions<TAppMeta>
  >
): ChromeConfig<TAppMeta> {
  const contentScriptMeta: ChromeContentScriptMeta<TAppMeta> = {
    context: "content-script",
    url: window.location.href,
    origin: window.location.origin,
    isVisible: !document.hidden,
    ...options,
  } as ChromeContentScriptMeta<TAppMeta>;

  const config = {
    endpoint: {
      meta: contentScriptMeta,
      implementation: new ContentScriptEndpoint(),
      defaultTarget:
        backgroundDefaultTarget() as ChromeAdapterModel<TAppMeta>["connectionTarget"],
    },
  } satisfies ChromeConfig<TAppMeta>;

  return config;
}

/**
 * Configure the singleton Nexus runtime as a content script context.
 */
export function usingContentScript<TAppMeta = never>(
  ...[options]: OptionalOptions<
    TAppMeta,
    CreateContentScriptConfigOptions<TAppMeta>
  >
) {
  const nexusInstance = configureChrome<TAppMeta>(
    createContentScriptConfig<TAppMeta>(
      ...([options] as OptionalOptions<
        TAppMeta,
        CreateContentScriptConfigOptions<TAppMeta>
      >),
    ),
  );

  document.addEventListener("visibilitychange", () => {
    void nexusInstance.updateIdentity({
      isVisible: !document.hidden,
    } as Partial<ChromeContentScriptMeta<TAppMeta>>);
  });

  return nexusInstance;
}

/**
 * Create pure popup config. The caller owns tab/window discovery.
 */
export function createPopupConfig<TAppMeta = never>(
  ...[options]: OptionalOptions<TAppMeta, CreatePopupConfigOptions<TAppMeta>>
): ChromeConfig<TAppMeta> {
  const popupMeta: ChromePopupMeta<TAppMeta> = {
    context: "popup",
    ...options,
  } as ChromePopupMeta<TAppMeta>;

  return createUiClientConfig<TAppMeta>(popupMeta);
}

/**
 * Configure the singleton Nexus runtime as a popup context.
 */
export function usingPopup<TAppMeta = never>(
  ...[options]: OptionalOptions<TAppMeta, CreatePopupConfigOptions<TAppMeta>>
) {
  return configureChrome<TAppMeta>(
    createPopupConfig<TAppMeta>(
      ...([options] as OptionalOptions<
        TAppMeta,
        CreatePopupConfigOptions<TAppMeta>
      >),
    ),
  );
}

export function createOptionsPageConfig<TAppMeta = never>(
  ...[options]: OptionalOptions<
    TAppMeta,
    CreateOptionsPageConfigOptions<TAppMeta>
  >
): ChromeConfig<TAppMeta> {
  const optionsPageMeta: ChromeOptionsPageMeta<TAppMeta> = {
    context: "options-page",
    windowId: chrome.windows.WINDOW_ID_CURRENT,
    ...options,
  } as ChromeOptionsPageMeta<TAppMeta>;

  return createUiClientConfig<TAppMeta>(optionsPageMeta);
}

export function usingOptionsPage<TAppMeta = never>(
  ...[options]: OptionalOptions<
    TAppMeta,
    CreateOptionsPageConfigOptions<TAppMeta>
  >
) {
  return configureChrome<TAppMeta>(
    createOptionsPageConfig<TAppMeta>(
      ...([options] as OptionalOptions<
        TAppMeta,
        CreateOptionsPageConfigOptions<TAppMeta>
      >),
    ),
  );
}

export function createDevToolsPageConfig<TAppMeta = never>(
  ...[options]: OptionalOptions<
    TAppMeta,
    CreateDevToolsPageConfigOptions<TAppMeta>
  >
): ChromeConfig<TAppMeta> {
  const devToolsPageMeta: ChromeDevToolsPageMeta<TAppMeta> = {
    context: "devtools-page",
    inspectedTabId: chrome.devtools.inspectedWindow.tabId,
    ...options,
  } as ChromeDevToolsPageMeta<TAppMeta>;

  return createUiClientConfig<TAppMeta>(devToolsPageMeta);
}

export function usingDevToolsPage<TAppMeta = never>(
  ...[options]: OptionalOptions<
    TAppMeta,
    CreateDevToolsPageConfigOptions<TAppMeta>
  >
) {
  return configureChrome<TAppMeta>(
    createDevToolsPageConfig<TAppMeta>(
      ...([options] as OptionalOptions<
        TAppMeta,
        CreateDevToolsPageConfigOptions<TAppMeta>
      >),
    ),
  );
}

export function createOffscreenDocumentConfig<TAppMeta = never>(
  options: CreateOffscreenDocumentConfigOptions<TAppMeta>,
): ChromeConfig<TAppMeta> {
  const offscreenDocumentMeta: ChromeOffscreenDocumentMeta<TAppMeta> = {
    context: "offscreen-document",
    ...options,
  } as ChromeOffscreenDocumentMeta<TAppMeta>;

  return createUiClientConfig<TAppMeta>(offscreenDocumentMeta);
}

export function usingOffscreenDocument<TAppMeta = never>(
  ...[reasonOrOptions]: [TAppMeta] extends [never]
    ? [reasonOrOptions: string | CreateOffscreenDocumentConfigOptions<TAppMeta>]
    : [reasonOrOptions: CreateOffscreenDocumentConfigOptions<TAppMeta>]
) {
  const options =
    typeof reasonOrOptions === "string"
      ? ({
          reason: reasonOrOptions,
        } as CreateOffscreenDocumentConfigOptions<TAppMeta>)
      : reasonOrOptions;

  return configureChrome<TAppMeta>(createOffscreenDocumentConfig(options));
}

export function createExtensionPageConfig<
  TAppMeta = never,
  const TCustomMeta extends { context: string } = {
    context: "extension-page";
    page?: string;
  },
>(
  meta: ExtensionPageConfigInput<TAppMeta, TCustomMeta>,
): ChromeConfig<TAppMeta, ExtensionPageConfigMeta<TAppMeta, TCustomMeta>>;
export function createExtensionPageConfig(
  meta: { context: string } & Record<string, unknown>,
): ChromeConfig<any, any> {
  if (isChromeBuiltinContext(meta.context)) {
    throw new Error(
      `Custom extension page context cannot reuse built-in Chrome context '${meta.context}'.`,
    );
  }

  return createUiClientConfig<
    unknown,
    { context: string } & Record<string, unknown>
  >(meta);
}

export function usingExtensionPage<
  TAppMeta = never,
  const TCustomMeta extends { context: string } = {
    context: "extension-page";
    page?: string;
  },
>(
  meta: ExtensionPageConfigInput<TAppMeta, TCustomMeta>,
): NexusInstance<
  ChromeAdapterModel<TAppMeta, ExtensionPageConfigMeta<TAppMeta, TCustomMeta>>
>;
export function usingExtensionPage(
  meta: { context: string } & Record<string, unknown>,
): NexusInstance<any> {
  return configureChrome(createExtensionPageConfig(meta));
}

function createUiClientConfig<
  TAppMeta = never,
  TCustomMeta extends { context: string } = never,
>(
  meta: ChromeContextMeta<TAppMeta, TCustomMeta>,
): ChromeConfig<TAppMeta, TCustomMeta> {
  const config = {
    endpoint: {
      meta,
      implementation: new UIClientEndpoint(),
      defaultTarget: backgroundDefaultTarget() as ChromeAdapterModel<
        TAppMeta,
        TCustomMeta
      >["connectionTarget"],
    },
  } satisfies ChromeConfig<TAppMeta, TCustomMeta>;

  return config;
}
