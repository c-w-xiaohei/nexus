import { nexus, type NexusConfig, type NexusInstance } from "@nexus-js/core";
import { IframeChildEndpoint } from "./child-endpoint.js";
import { DEFAULT_INSTANCE } from "./constants.js";
import { IframeParentEndpoint } from "./parent-endpoint.js";
import type {
  IframeChildConfigOptions,
  IframeChildOptions,
  IframeParentConfigOptions,
  IframeParentOptions,
  IframeAdapterModel,
} from "./types.js";
import { getOrigin } from "./window.js";

/**
 * Builds or applies a parent iframe Nexus configuration. With `configure:false`,
 * this returns a config object instead of mutating the default Nexus instance;
 * keep frame origins exact unless `allowAnyOrigin:true` is explicitly needed.
 */
export function usingIframeParent(
  options: IframeParentConfigOptions,
): NexusConfig<IframeAdapterModel>;
export function usingIframeParent(
  options: IframeParentOptions,
): NexusInstance<IframeAdapterModel>;
export function usingIframeParent(
  options: IframeParentOptions | IframeParentConfigOptions,
): NexusConfig<IframeAdapterModel> | NexusInstance<IframeAdapterModel> {
  const instance = options.instance ?? DEFAULT_INSTANCE;
  const origin = getOrigin(options.localWindow ?? options.window);
  const config: NexusConfig<IframeAdapterModel> = {
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
  };
  return options.configure === false
    ? config
    : (nexus as unknown as NexusInstance<IframeAdapterModel>).configure(config);
}

/**
 * Builds or applies a child iframe Nexus configuration. With `configure:false`,
 * this returns a config object for custom Nexus instances; `parentOrigin:"*"`
 * is rejected unless `allowAnyOrigin:true` is set intentionally.
 */
export function usingIframeChild(
  options: IframeChildConfigOptions,
): NexusConfig<IframeAdapterModel>;
export function usingIframeChild(
  options: IframeChildOptions,
): NexusInstance<IframeAdapterModel>;
export function usingIframeChild(
  options: IframeChildOptions | IframeChildConfigOptions,
): NexusConfig<IframeAdapterModel> | NexusInstance<IframeAdapterModel> {
  const instance = options.instance ?? DEFAULT_INSTANCE;
  const frameId = options.frameId ?? "default";
  const config: NexusConfig<IframeAdapterModel> = {
    ...options,
    endpoint: {
      meta: {
        context: "iframe-child",
        appId: options.appId,
        instance,
        origin: getOrigin(options.localWindow ?? options.window),
        frameId,
      },
      implementation: new IframeChildEndpoint({
        ...options,
        frameId,
      }),
      defaultTarget: Object.freeze(
        options.defaultTarget
          ? { ...options.defaultTarget }
          : {
              context: "iframe-parent",
              appId: options.appId,
              instance,
              origin: options.parentOrigin,
            },
      ),
    },
  };
  return options.configure === false
    ? config
    : (nexus as unknown as NexusInstance<IframeAdapterModel>).configure(config);
}
