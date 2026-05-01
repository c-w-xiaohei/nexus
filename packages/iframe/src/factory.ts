import { nexus, type NexusConfig, type NexusInstance } from "@nexus-js/core";
import { IframeChildEndpoint } from "./child-endpoint";
import { DEFAULT_INSTANCE } from "./constants";
import { baseMatchers } from "./matchers";
import { IframeParentEndpoint } from "./parent-endpoint";
import type {
  IframeChildConfigOptions,
  IframeChildOptions,
  IframeParentConfigOptions,
  IframeParentOptions,
  IframePlatformMeta,
  IframeUserMeta,
} from "./types";
import { getOrigin } from "./window";

/**
 * Builds or applies a parent iframe Nexus configuration. With `configure:false`,
 * this returns a config object instead of mutating the default Nexus instance;
 * keep frame origins exact unless `allowAnyOrigin:true` is explicitly needed.
 */
export function usingIframeParent(
  options: IframeParentConfigOptions,
): NexusConfig<IframeUserMeta, IframePlatformMeta>;
export function usingIframeParent(
  options: IframeParentOptions,
): NexusInstance<IframeUserMeta, IframePlatformMeta>;
export function usingIframeParent(
  options: IframeParentOptions | IframeParentConfigOptions,
) {
  const instance = options.instance ?? DEFAULT_INSTANCE;
  const origin = getOrigin(options.localWindow ?? options.window);
  const config: NexusConfig<IframeUserMeta, IframePlatformMeta> = {
    ...options,
    endpoint: {
      meta: {
        context: "iframe-parent",
        appId: options.appId,
        instance,
        origin,
      },
      implementation: new IframeParentEndpoint(options),
    },
    matchers: baseMatchers(options.appId, instance),
    descriptors: Object.fromEntries(
      options.frames.map((frame, index) => [
        index === 0 ? "child" : `child:${frame.frameId}`,
        {
          context: "iframe-child",
          appId: options.appId,
          instance: frame.instance ?? instance,
          frameId: frame.frameId,
          origin: frame.origin,
        },
      ]),
    ) as Record<string, Partial<IframeUserMeta>>,
  };
  return options.configure === false ? config : nexus.configure(config);
}

/**
 * Builds or applies a child iframe Nexus configuration. With `configure:false`,
 * this returns a config object for custom Nexus instances; `parentOrigin:"*"`
 * is rejected unless `allowAnyOrigin:true` is set intentionally.
 */
export function usingIframeChild(
  options: IframeChildConfigOptions,
): NexusConfig<IframeUserMeta, IframePlatformMeta>;
export function usingIframeChild(
  options: IframeChildOptions,
): NexusInstance<IframeUserMeta, IframePlatformMeta>;
export function usingIframeChild(
  options: IframeChildOptions | IframeChildConfigOptions,
) {
  const instance = options.instance ?? DEFAULT_INSTANCE;
  const frameId = options.frameId ?? "default";
  const config: NexusConfig<IframeUserMeta, IframePlatformMeta> = {
    ...options,
    endpoint: {
      meta: {
        context: "iframe-child",
        appId: options.appId,
        instance,
        origin: getOrigin(options.localWindow ?? options.window),
        frameId,
      },
      implementation: new IframeChildEndpoint({ ...options, frameId }),
      connectTo: options.connectTo,
    },
    matchers: baseMatchers(options.appId, instance),
    descriptors: {
      parent: {
        context: "iframe-parent",
        appId: options.appId,
        instance,
        origin: options.parentOrigin,
      },
    },
  };
  return options.configure === false ? config : nexus.configure(config);
}
