import { DEFAULT_INSTANCE } from "./constants.js";
import type { IframeEndpointMeta } from "./types.js";

export const IframeMatchers = {
  parent: (appId: string) => (identity: IframeEndpointMeta) =>
    identity.context === "iframe-parent" && identity.appId === appId,
  child: (appId: string) => (identity: IframeEndpointMeta) =>
    identity.context === "iframe-child" && identity.appId === appId,
  instance: (name: string) => (identity: IframeEndpointMeta) =>
    (identity.instance ?? DEFAULT_INSTANCE) === name,
  origin: (origin: string) => (identity: IframeEndpointMeta) =>
    identity.origin === origin,
  frame: (frameId: string) => (identity: IframeEndpointMeta) =>
    identity.context === "iframe-child" && identity.frameId === frameId,
};

export function baseMatchers(appId: string, instance: string) {
  return {
    parent: IframeMatchers.parent(appId),
    child: IframeMatchers.child(appId),
    instance: IframeMatchers.instance(instance),
  };
}
