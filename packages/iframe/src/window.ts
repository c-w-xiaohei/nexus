import { IframeAdapterError } from "./errors";
import type { WindowLike } from "./types";

export function getWindow(localWindow?: Window): Window {
  if (localWindow) return localWindow;
  if (typeof window !== "undefined") return window;
  throw new IframeAdapterError(
    "Iframe window is required outside browser globals",
    "E_IFRAME_CONFIG_INVALID",
  );
}

export function getOrigin(localWindow?: Window): string {
  const windowRef = getWindow(localWindow) as WindowLike;
  const value = windowRef.origin ?? windowRef.location?.origin;
  if (!value)
    throw new IframeAdapterError(
      "Iframe window origin is unavailable",
      "E_IFRAME_CONFIG_INVALID",
    );
  return value;
}

export function postMessageFrom(
  source: Window,
  target: Window,
  message: unknown,
  targetOrigin: string,
  transfer?: Transferable[],
): void {
  const fakeDeliver = (
    source as unknown as {
      deliver?: (
        target: Window,
        data: unknown,
        targetOrigin?: string,
        transfer?: Transferable[],
      ) => void;
    }
  ).deliver;
  if (typeof fakeDeliver === "function") {
    // Unit tests use fake windows without browser postMessage dispatch semantics.
    // This seam preserves source/origin delivery so security filtering is tested.
    fakeDeliver.call(source, target, message, targetOrigin, transfer);
    return;
  }
  target.postMessage(message, targetOrigin, transfer);
}
