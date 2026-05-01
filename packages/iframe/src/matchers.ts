import { DEFAULT_INSTANCE } from "./constants";
import type { IframeUserMeta } from "./types";

export const IframeMatchers = {
  parent: (appId: string) => (identity: IframeUserMeta) =>
    identity.context === "iframe-parent" && identity.appId === appId,
  child: (appId: string) => (identity: IframeUserMeta) =>
    identity.context === "iframe-child" && identity.appId === appId,
  instance: (name: string) => (identity: IframeUserMeta) =>
    (identity.instance ?? DEFAULT_INSTANCE) === name,
  origin: (origin: string) => (identity: IframeUserMeta) =>
    identity.origin === origin,
  frame: (frameId: string) => (identity: IframeUserMeta) =>
    identity.context === "iframe-child" && identity.frameId === frameId,
};

export function baseMatchers(appId: string, instance: string) {
  return {
    parent: IframeMatchers.parent(appId),
    child: IframeMatchers.child(appId),
    instance: IframeMatchers.instance(instance),
  };
}
