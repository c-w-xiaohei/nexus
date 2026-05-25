import { nexus, type IEndpoint, type NexusConfig } from "@nexus-js/core";
import type {
  ChromeBackgroundMeta,
  ChromeBuiltinContext,
  ChromeContentScriptMeta,
  ChromeDevToolsPageMeta,
  ChromeEndpointMeta,
  ChromeOffscreenDocumentMeta,
  ChromeOptionsPageMeta,
  ChromePlatformMeta,
  ChromePopupMeta,
} from "./types/meta";
import { BackgroundEndpoint } from "./endpoints/background";
import { ContentScriptEndpoint } from "./endpoints/content-script";
import { UIClientEndpoint } from "./endpoints/ui-client";
import { ChromeMatchers, type ChromeMatcherMeta } from "./matchers";

type ChromeConfig<
  TAppMeta = never,
  TCustomMeta extends { context: string } = never,
> = NexusConfig<ChromeEndpointMeta<TAppMeta, TCustomMeta>, ChromePlatformMeta>;

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

const backgroundDescriptor = { context: "background" } as const;
const chromeBuiltinContexts = new Set<ChromeBuiltinContext>([
  "background",
  "content-script",
  "popup",
  "options-page",
  "devtools-page",
  "offscreen-document",
]);

function backgroundDescriptorFor<
  TAppMeta,
  TCustomMeta extends { context: string } = never,
>(): Partial<ChromeEndpointMeta<TAppMeta, TCustomMeta>> {
  return backgroundDescriptor as Partial<
    ChromeEndpointMeta<TAppMeta, TCustomMeta>
  >;
}

function backgroundConnectToFor<
  TAppMeta,
  TCustomMeta extends { context: string } = never,
>() {
  return [{ descriptor: backgroundDescriptorFor<TAppMeta, TCustomMeta>() }];
}

function isChromeBuiltinContext(
  context: string,
): context is ChromeBuiltinContext {
  return chromeBuiltinContexts.has(context as ChromeBuiltinContext);
}

function matcherFor<TMeta extends object>(
  matcher: (identity: ChromeMatcherMeta) => boolean,
): (identity: TMeta) => boolean {
  return matcher as (identity: TMeta) => boolean;
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
      implementation: new BackgroundEndpoint() as IEndpoint<
        ChromeEndpointMeta<TAppMeta>,
        ChromePlatformMeta
      >,
    },
    matchers: {
      "any-content-script": matcherFor<ChromeEndpointMeta<TAppMeta>>(
        ChromeMatchers.anyContentScript,
      ),
      "any-popup": matcherFor<ChromeEndpointMeta<TAppMeta>>(
        ChromeMatchers.anyPopup,
      ),
      "visible-content-script": matcherFor<ChromeEndpointMeta<TAppMeta>>(
        ChromeMatchers.visibleContentScript,
      ),
    },
    descriptors: {
      background: backgroundDescriptorFor<TAppMeta>(),
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
  return nexus.configure(
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
      implementation: new ContentScriptEndpoint() as IEndpoint<
        ChromeEndpointMeta<TAppMeta>,
        ChromePlatformMeta
      >,
      connectTo: backgroundConnectToFor<TAppMeta>(),
    },
    matchers: {
      background: matcherFor<ChromeEndpointMeta<TAppMeta>>(
        ChromeMatchers.background,
      ),
    },
    descriptors: {
      background: backgroundDescriptorFor<TAppMeta>(),
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
  const nexusInstance = nexus.configure(
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

  return createUiClientConfig(popupMeta);
}

/**
 * Configure the singleton Nexus runtime as a popup context.
 */
export function usingPopup<TAppMeta = never>(
  ...[options]: OptionalOptions<TAppMeta, CreatePopupConfigOptions<TAppMeta>>
) {
  return nexus.configure(
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

  return createUiClientConfig(optionsPageMeta);
}

export function usingOptionsPage<TAppMeta = never>(
  ...[options]: OptionalOptions<
    TAppMeta,
    CreateOptionsPageConfigOptions<TAppMeta>
  >
) {
  return nexus.configure(
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

  return createUiClientConfig(devToolsPageMeta);
}

export function usingDevToolsPage<TAppMeta = never>(
  ...[options]: OptionalOptions<
    TAppMeta,
    CreateDevToolsPageConfigOptions<TAppMeta>
  >
) {
  return nexus.configure(
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

  return createUiClientConfig(offscreenDocumentMeta);
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

  return nexus.configure(createOffscreenDocumentConfig(options));
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
): ReturnType<typeof nexus.configure>;
export function usingExtensionPage(
  meta: { context: string } & Record<string, unknown>,
) {
  return nexus.configure(createExtensionPageConfig(meta));
}

function createUiClientConfig<
  TAppMeta = never,
  TCustomMeta extends { context: string } = never,
>(
  meta: ChromeEndpointMeta<TAppMeta, TCustomMeta>,
): ChromeConfig<TAppMeta, TCustomMeta> {
  const config = {
    endpoint: {
      meta,
      implementation: new UIClientEndpoint() as IEndpoint<
        ChromeEndpointMeta<TAppMeta, TCustomMeta>,
        ChromePlatformMeta
      >,
      connectTo: backgroundConnectToFor<TAppMeta, TCustomMeta>(),
    },
    matchers: {
      background: matcherFor<ChromeEndpointMeta<TAppMeta, TCustomMeta>>(
        ChromeMatchers.background,
      ),
    },
    descriptors: {
      background: backgroundDescriptorFor<TAppMeta, TCustomMeta>(),
    },
  } satisfies ChromeConfig<TAppMeta, TCustomMeta>;

  return config;
}
