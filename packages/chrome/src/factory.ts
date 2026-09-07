import { nexus, type NexusConfig, type NexusInstance } from "@nexus-js/core";
import type {
  ChromeAppMeta,
  ChromeBackgroundMeta,
  ChromeBuiltinContext,
  ChromeContentScriptMeta,
  ChromeConnectionTarget,
  ChromeDevToolsPageMeta,
  ChromeContextMeta,
  ChromeAdapterModel,
  ChromeOffscreenDocumentMeta,
  ChromeOptionsPageMeta,
  ChromePopupMeta,
} from "./types/meta.js";
import { chromeTarget } from "./types/meta.js";
import { BackgroundEndpoint } from "./endpoints/background.js";
import { ContentScriptEndpoint } from "./endpoints/content-script.js";
import { UIClientEndpoint } from "./endpoints/ui-client.js";

type ChromeConfig<
  TAppMeta = never,
  TCustomMeta extends { context: string } = never,
> = NexusConfig<ChromeAdapterModel<TAppMeta, TCustomMeta>>;

type ChromeConnectionOptions = {
  connectTo?: readonly ChromeConnectionTarget[];
};

type OptionalOptions<TOptions> =
  Partial<TOptions> extends TOptions
    ? [options?: TOptions]
    : [options: TOptions];

export type CreateBackgroundScriptConfigOptions<TAppMeta = never> =
  ChromeAppMeta<TAppMeta> & ChromeConnectionOptions;

export type CreateContentScriptConfigOptions<TAppMeta = never> =
  CreateBackgroundScriptConfigOptions<TAppMeta>;

export type CreatePopupConfigOptions<TAppMeta = never> = Omit<
  ChromePopupMeta<TAppMeta>,
  "context"
> &
  ChromeConnectionOptions;

export type CreateOptionsPageConfigOptions<TAppMeta = never> = Omit<
  ChromeOptionsPageMeta<TAppMeta>,
  "context"
> &
  ChromeConnectionOptions;

export type CreateDevToolsPageConfigOptions<TAppMeta = never> =
  CreateBackgroundScriptConfigOptions<TAppMeta>;

export type CreateOffscreenDocumentConfigOptions<TAppMeta = never> = Omit<
  ChromeOffscreenDocumentMeta<TAppMeta>,
  "context"
> &
  ChromeConnectionOptions;

type ExtensionPageConfigMeta<
  TAppMeta,
  TCustomMeta extends { context: string },
> = TCustomMeta & ChromeAppMeta<TAppMeta>;

type ExtensionPageConfigInput<
  TAppMeta,
  TCustomMeta extends { context: string },
> = TCustomMeta &
  (TCustomMeta["context"] extends ChromeBuiltinContext ? never : unknown) &
  ChromeAppMeta<TAppMeta>;

const chromeBuiltinContexts = new Set<ChromeBuiltinContext>([
  "background",
  "content-script",
  "popup",
  "options-page",
  "devtools-page",
  "offscreen-document",
]);

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
  ...[options]: OptionalOptions<CreateBackgroundScriptConfigOptions<TAppMeta>>
): ChromeConfig<TAppMeta> {
  const { connectTo, ...optionsMeta } = options ?? {};
  const backgroundMeta: ChromeBackgroundMeta<TAppMeta> = {
    context: "background",
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    ...optionsMeta,
  } as ChromeBackgroundMeta<TAppMeta>;

  return {
    endpoint: {
      meta: backgroundMeta,
      implementation: new BackgroundEndpoint(),
      ...(connectTo ? { connectTo } : {}),
    },
  };
}

/**
 * Configure the singleton Nexus runtime as a background script context.
 */
export function usingBackgroundScript<TAppMeta = never>(
  ...args: OptionalOptions<CreateBackgroundScriptConfigOptions<TAppMeta>>
) {
  return configureChrome<TAppMeta>(
    createBackgroundScriptConfig<TAppMeta>(...args),
  );
}

/**
 * Create pure content script config without registering visibility listeners.
 */
export function createContentScriptConfig<TAppMeta = never>(
  ...[options]: OptionalOptions<CreateContentScriptConfigOptions<TAppMeta>>
): ChromeConfig<TAppMeta> {
  const { connectTo, ...optionsMeta } = options ?? {};
  const contentScriptMeta: ChromeContentScriptMeta<TAppMeta> = {
    context: "content-script",
    url: window.location.href,
    origin: window.location.origin,
    isVisible: !document.hidden,
    ...optionsMeta,
  } as ChromeContentScriptMeta<TAppMeta>;

  return {
    endpoint: {
      meta: contentScriptMeta,
      implementation: new ContentScriptEndpoint(),
      defaultTarget: chromeTarget.background(),
      ...(connectTo ? { connectTo } : {}),
    },
  };
}

/**
 * Configure the singleton Nexus runtime as a content script context.
 */
export function usingContentScript<TAppMeta = never>(
  ...args: OptionalOptions<CreateContentScriptConfigOptions<TAppMeta>>
) {
  const nexusInstance = configureChrome<TAppMeta>(
    createContentScriptConfig<TAppMeta>(...args),
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
  ...[options]: OptionalOptions<CreatePopupConfigOptions<TAppMeta>>
): ChromeConfig<TAppMeta> {
  const { connectTo, ...popupOptions } = options ?? {};
  const popupMeta: ChromePopupMeta<TAppMeta> = {
    context: "popup",
    ...popupOptions,
  } as ChromePopupMeta<TAppMeta>;

  return createUiClientConfig<TAppMeta>(popupMeta, connectTo);
}

/**
 * Configure the singleton Nexus runtime as a popup context.
 */
export function usingPopup<TAppMeta = never>(
  ...args: OptionalOptions<CreatePopupConfigOptions<TAppMeta>>
) {
  return configureChrome<TAppMeta>(createPopupConfig<TAppMeta>(...args));
}

export function createOptionsPageConfig<TAppMeta = never>(
  ...[options]: OptionalOptions<CreateOptionsPageConfigOptions<TAppMeta>>
): ChromeConfig<TAppMeta> {
  const { connectTo, ...optionsPageOptions } = options ?? {};
  const optionsPageMeta: ChromeOptionsPageMeta<TAppMeta> = {
    context: "options-page",
    windowId: chrome.windows.WINDOW_ID_CURRENT,
    ...optionsPageOptions,
  } as ChromeOptionsPageMeta<TAppMeta>;

  return createUiClientConfig<TAppMeta>(optionsPageMeta, connectTo);
}

export function usingOptionsPage<TAppMeta = never>(
  ...args: OptionalOptions<CreateOptionsPageConfigOptions<TAppMeta>>
) {
  return configureChrome<TAppMeta>(createOptionsPageConfig<TAppMeta>(...args));
}

export function createDevToolsPageConfig<TAppMeta = never>(
  ...[options]: OptionalOptions<CreateDevToolsPageConfigOptions<TAppMeta>>
): ChromeConfig<TAppMeta> {
  const { connectTo, ...devToolsPageOptions } = options ?? {};
  const devToolsPageMeta: ChromeDevToolsPageMeta<TAppMeta> = {
    context: "devtools-page",
    inspectedTabId: chrome.devtools.inspectedWindow.tabId,
    ...devToolsPageOptions,
  } as ChromeDevToolsPageMeta<TAppMeta>;

  return createUiClientConfig<TAppMeta>(devToolsPageMeta, connectTo);
}

export function usingDevToolsPage<TAppMeta = never>(
  ...args: OptionalOptions<CreateDevToolsPageConfigOptions<TAppMeta>>
) {
  return configureChrome<TAppMeta>(createDevToolsPageConfig<TAppMeta>(...args));
}

export function createOffscreenDocumentConfig<TAppMeta = never>(
  options: CreateOffscreenDocumentConfigOptions<TAppMeta>,
): ChromeConfig<TAppMeta> {
  const { connectTo, ...offscreenDocumentOptions } = options;
  const offscreenDocumentMeta: ChromeOffscreenDocumentMeta<TAppMeta> = {
    context: "offscreen-document",
    ...offscreenDocumentOptions,
  } as ChromeOffscreenDocumentMeta<TAppMeta>;

  return createUiClientConfig<TAppMeta>(offscreenDocumentMeta, connectTo);
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

/** Keep arbitrary identity metadata separate from local connection options. */
export function createExtensionPageConfig<
  TAppMeta = never,
  const TCustomMeta extends { context: string } = {
    context: "extension-page";
    page?: string;
  },
>(
  meta: ExtensionPageConfigInput<TAppMeta, TCustomMeta>,
  options?: ChromeConnectionOptions,
): ChromeConfig<TAppMeta, ExtensionPageConfigMeta<TAppMeta, TCustomMeta>>;
export function createExtensionPageConfig(
  meta: { context: string } & Record<string, unknown>,
  options?: ChromeConnectionOptions,
): ChromeConfig<any, any> {
  if (isChromeBuiltinContext(meta.context)) {
    throw new Error(
      `Custom extension page context cannot reuse built-in Chrome context '${meta.context}'.`,
    );
  }

  return createUiClientConfig<
    unknown,
    { context: string } & Record<string, unknown>
  >(meta, options?.connectTo);
}

export function usingExtensionPage<
  TAppMeta = never,
  const TCustomMeta extends { context: string } = {
    context: "extension-page";
    page?: string;
  },
>(
  meta: ExtensionPageConfigInput<TAppMeta, TCustomMeta>,
  options?: ChromeConnectionOptions,
): NexusInstance<
  ChromeAdapterModel<TAppMeta, ExtensionPageConfigMeta<TAppMeta, TCustomMeta>>
>;
export function usingExtensionPage(
  meta: { context: string } & Record<string, unknown>,
  options?: ChromeConnectionOptions,
): NexusInstance<any> {
  return configureChrome(createExtensionPageConfig(meta, options));
}

function createUiClientConfig<
  TAppMeta = never,
  TCustomMeta extends { context: string } = never,
>(
  meta: ChromeContextMeta<TAppMeta, TCustomMeta>,
  connectTo?: readonly ChromeConnectionTarget[],
): ChromeConfig<TAppMeta, TCustomMeta> {
  return {
    endpoint: {
      meta,
      implementation: new UIClientEndpoint(),
      defaultTarget: chromeTarget.background(),
      ...(connectTo ? { connectTo } : {}),
    },
  };
}
