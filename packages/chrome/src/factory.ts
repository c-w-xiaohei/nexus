import { nexus, type NexusConfig, type NexusInstance } from "@nexus-js/core";
import type {
  ChromeAppMeta,
  ChromeBackgroundMeta,
  ChromeBuiltinContext,
  ChromeContentScriptMeta,
  ChromeConnectionTarget,
  ChromeBackgroundConnectTarget,
  ChromeContentScriptConnectTarget,
  ChromeExtensionPageConnectTarget,
  ChromeOffscreenDocumentConnectTarget,
  ChromeDevToolsPageMeta,
  ChromeContextMeta,
  ChromeAdapterModel,
  ChromeOffscreenDocumentMeta,
  ChromeOptionsPageMeta,
  ChromePageTarget,
  ChromePopupMeta,
  ChromeSidePanelMeta,
} from "./types/meta.js";
import { BackgroundEndpoint } from "./endpoints/background.js";
import { ContentScriptEndpoint } from "./endpoints/content-script.js";
import { UIClientEndpoint } from "./endpoints/ui-client.js";
import { chromeTarget } from "./types/meta.js";

type ChromeConfig<
  TAppMeta = never,
  TCustomMeta extends { context: string } = never,
> = NexusConfig<ChromeAdapterModel<TAppMeta, TCustomMeta>>;

type ChromeConnectionOptions<TTarget extends ChromeConnectionTarget> = {
  connectTo?: readonly TTarget[];
};

type OptionalOptions<TOptions> =
  Partial<TOptions> extends TOptions
    ? [options?: TOptions]
    : [options: TOptions];

export type CreateBackgroundScriptConfigOptions<TAppMeta = never> =
  ChromeAppMeta<TAppMeta> &
    ChromeConnectionOptions<ChromeBackgroundConnectTarget>;

export type CreateContentScriptConfigOptions<TAppMeta = never> =
  ChromeAppMeta<TAppMeta> &
    ChromeConnectionOptions<ChromeContentScriptConnectTarget>;

export type CreatePopupConfigOptions<TAppMeta = never> = Omit<
  ChromePopupMeta<TAppMeta>,
  "context" | "tabId" | "windowId"
> &
  ChromeConnectionOptions<ChromeExtensionPageConnectTarget>;

export type CreateOptionsPageConfigOptions<TAppMeta = never> = Omit<
  ChromeOptionsPageMeta<TAppMeta>,
  "context"
> &
  ChromeConnectionOptions<ChromeExtensionPageConnectTarget>;

export type CreateDevToolsPageConfigOptions<TAppMeta = never> =
  ChromeAppMeta<TAppMeta> &
    ChromeConnectionOptions<ChromeExtensionPageConnectTarget>;

export type CreateOffscreenDocumentConfigOptions<TAppMeta = never> = Omit<
  ChromeOffscreenDocumentMeta<TAppMeta>,
  "context"
> &
  ChromeConnectionOptions<ChromeOffscreenDocumentConnectTarget>;

export type CreateSidePanelConfigOptions<TAppMeta = never> = Omit<
  ChromeSidePanelMeta<TAppMeta>,
  "context" | "tabId" | "windowId"
> &
  ChromeConnectionOptions<ChromeExtensionPageConnectTarget>;

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

type ExtensionPageConnectionOptions =
  ChromeConnectionOptions<ChromeExtensionPageConnectTarget> & {
    endpointId?: string;
  };

const chromeBuiltinContexts = new Set<ChromeBuiltinContext>([
  "background",
  "content-script",
  "popup",
  "options-page",
  "devtools-page",
  "offscreen-document",
  "side-panel",
]);

/** Apply one adapter config to the shared Chrome Nexus instance. */
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

/** Reject custom page metadata that collides with an adapter-owned context. */
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

  return createUiClientConfig<TAppMeta>(popupMeta, {
    connectTo,
    receiver: () => resolveCurrentWindowReceiver(chromeTarget.popup),
  });
}

/**
 * Configure the singleton Nexus runtime as a popup context.
 */
export function usingPopup<TAppMeta = never>(
  ...args: OptionalOptions<CreatePopupConfigOptions<TAppMeta>>
) {
  return configureChrome<TAppMeta>(createPopupConfig<TAppMeta>(...args));
}

/** Create pure options-page configuration with optional startup connections. */
export function createOptionsPageConfig<TAppMeta = never>(
  ...[options]: OptionalOptions<CreateOptionsPageConfigOptions<TAppMeta>>
): ChromeConfig<TAppMeta> {
  const { connectTo, ...optionsPageOptions } = options ?? {};
  const optionsPageMeta: ChromeOptionsPageMeta<TAppMeta> = {
    context: "options-page",
    ...optionsPageOptions,
  } as ChromeOptionsPageMeta<TAppMeta>;

  return createUiClientConfig<TAppMeta>(optionsPageMeta, {
    connectTo,
    receiver: chromeTarget.optionsPage(),
    exclusiveReceiver: true,
  });
}

/** Configure the singleton Nexus runtime as an options page context. */
export function usingOptionsPage<TAppMeta = never>(
  ...args: OptionalOptions<CreateOptionsPageConfigOptions<TAppMeta>>
) {
  return configureChrome<TAppMeta>(createOptionsPageConfig<TAppMeta>(...args));
}

/** Create a pure DevTools page configuration. */
export function createDevToolsPageConfig<TAppMeta = never>(
  ...[options]: OptionalOptions<CreateDevToolsPageConfigOptions<TAppMeta>>
): ChromeConfig<TAppMeta> {
  const { connectTo, ...devToolsPageOptions } = options ?? {};
  const devToolsPageMeta: ChromeDevToolsPageMeta<TAppMeta> = {
    context: "devtools-page",
    inspectedTabId: chrome.devtools.inspectedWindow.tabId,
    ...devToolsPageOptions,
  } as ChromeDevToolsPageMeta<TAppMeta>;

  return createUiClientConfig<TAppMeta>(devToolsPageMeta, {
    connectTo,
    receiver: chromeTarget.devToolsPage({
      inspectedTabId: devToolsPageMeta.inspectedTabId,
    }),
  });
}

/** Configure the singleton Nexus runtime as a DevTools page context. */
export function usingDevToolsPage<TAppMeta = never>(
  ...args: OptionalOptions<CreateDevToolsPageConfigOptions<TAppMeta>>
) {
  return configureChrome<TAppMeta>(createDevToolsPageConfig<TAppMeta>(...args));
}

/** Create a pure offscreen document configuration. */
export function createOffscreenDocumentConfig<TAppMeta = never>(
  options: CreateOffscreenDocumentConfigOptions<TAppMeta>,
): ChromeConfig<TAppMeta> {
  const { connectTo, ...offscreenDocumentOptions } = options;
  const offscreenDocumentMeta: ChromeOffscreenDocumentMeta<TAppMeta> = {
    context: "offscreen-document",
    ...offscreenDocumentOptions,
  } as ChromeOffscreenDocumentMeta<TAppMeta>;

  return createUiClientConfig<TAppMeta>(offscreenDocumentMeta, {
    connectTo,
    receiver: chromeTarget.offscreenDocument(),
    canConnectContent: false,
  });
}

/** Configure the singleton Nexus runtime as an offscreen document context. */
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

/** Create pure configuration for an application-defined extension page context. */
export function createExtensionPageConfig<
  TAppMeta = never,
  const TCustomMeta extends { context: string } = {
    context: "extension-page";
    page?: string;
  },
>(
  meta: ExtensionPageConfigInput<TAppMeta, TCustomMeta>,
  options?: ExtensionPageConnectionOptions,
): ChromeConfig<TAppMeta, ExtensionPageConfigMeta<TAppMeta, TCustomMeta>>;
export function createExtensionPageConfig(
  meta: { context: string } & Record<string, unknown>,
  options?: ExtensionPageConnectionOptions,
): ChromeConfig<any, any> {
  if (isChromeBuiltinContext(meta.context)) {
    throw new Error(
      `Custom extension page context cannot reuse built-in Chrome context '${meta.context}'.`,
    );
  }

  const { endpointId, ...connectionOptions } = options ?? {};
  const receiver =
    endpointId === undefined
      ? undefined
      : chromeTarget.extensionPage({ endpointId });

  return createUiClientConfig<
    unknown,
    { context: string } & Record<string, unknown>
  >(meta, { ...connectionOptions, receiver });
}

/** Configure the shared Nexus instance for an application-defined page context. */
export function usingExtensionPage<
  TAppMeta = never,
  const TCustomMeta extends { context: string } = {
    context: "extension-page";
    page?: string;
  },
>(
  meta: ExtensionPageConfigInput<TAppMeta, TCustomMeta>,
  options?: ExtensionPageConnectionOptions,
): NexusInstance<
  ChromeAdapterModel<TAppMeta, ExtensionPageConfigMeta<TAppMeta, TCustomMeta>>
>;
export function usingExtensionPage(
  meta: { context: string } & Record<string, unknown>,
  options?: ExtensionPageConnectionOptions,
): NexusInstance<any> {
  return configureChrome(createExtensionPageConfig(meta, options));
}

export function createSidePanelConfig<TAppMeta = never>(
  ...[options]: OptionalOptions<CreateSidePanelConfigOptions<TAppMeta>>
): ChromeConfig<TAppMeta> {
  const { connectTo, ...meta } = options ?? {};
  const sidePanelMeta = {
    context: "side-panel",
    ...meta,
  } as ChromeSidePanelMeta<TAppMeta>;
  return createUiClientConfig<TAppMeta>(sidePanelMeta, {
    connectTo,
    receiver: () => resolveCurrentWindowReceiver(chromeTarget.sidePanel),
  });
}

export function usingSidePanel<TAppMeta = never>(
  ...args: OptionalOptions<CreateSidePanelConfigOptions<TAppMeta>>
) {
  return configureChrome<TAppMeta>(createSidePanelConfig<TAppMeta>(...args));
}

/** Create a UI client endpoint configuration without mutating Nexus state. */
function createUiClientConfig<
  TAppMeta = never,
  TCustomMeta extends { context: string } = never,
>(
  meta: ChromeContextMeta<TAppMeta, TCustomMeta>,
  options: {
    connectTo?: readonly ChromeConnectionTarget[];
    receiver?: ChromePageTarget | (() => Promise<ChromePageTarget>);
    exclusiveReceiver?: boolean;
    canConnectContent?: boolean;
  } = {},
): ChromeConfig<TAppMeta, TCustomMeta> {
  const { connectTo, ...endpointOptions } = options;
  return {
    endpoint: {
      meta,
      implementation: new UIClientEndpoint(endpointOptions),
      ...(connectTo ? { connectTo } : {}),
    },
  };
}

async function resolveCurrentWindowReceiver(
  createTarget: (options: { windowId: number }) => ChromePageTarget,
): Promise<ChromePageTarget> {
  const windowId = (await chrome.windows.getCurrent()).id;
  if (windowId === undefined || windowId < 0) {
    throw new Error("Chrome did not expose a concrete current window ID.");
  }
  return createTarget({ windowId });
}
