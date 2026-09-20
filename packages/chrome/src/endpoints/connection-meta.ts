import type {
  ChromeConnectionMeta,
  ChromeConnectionTarget,
  ChromeContextMeta,
  ChromeObservedConnectionFacts,
  ChromePageTarget,
} from "../types/meta";
import { chromePortName } from "../ports/chrome-port-name";

const selectedRoutes = new WeakMap<
  ChromeObservedConnectionFacts,
  ChromeConnectionTarget
>();

export function createChromeConnectionMeta(
  sender: chrome.runtime.MessageSender | undefined,
  selectedTarget?: ChromeConnectionTarget,
): ChromeConnectionMeta {
  const tab = sender?.tab
    ? Object.freeze({
        ...(sender.tab.id === undefined ? {} : { id: sender.tab.id }),
        ...(sender.tab.windowId === undefined
          ? {}
          : { windowId: sender.tab.windowId }),
        ...(sender.tab.incognito === undefined
          ? {}
          : { incognito: sender.tab.incognito }),
      })
    : undefined;
  const observedSender = sender
    ? Object.freeze({
        ...(tab ? { tab } : {}),
        ...(sender.frameId === undefined ? {} : { frameId: sender.frameId }),
        ...(sender.documentId === undefined
          ? {}
          : { documentId: sender.documentId }),
        ...(sender.url === undefined ? {} : { url: sender.url }),
        ...(sender.id === undefined ? {} : { id: sender.id }),
        ...(sender.origin === undefined ? {} : { origin: sender.origin }),
        ...(sender.documentLifecycle === undefined
          ? {}
          : { documentLifecycle: sender.documentLifecycle }),
      })
    : undefined;
  const observed = Object.freeze({
    ...(observedSender ? { sender: observedSender } : {}),
    ...(sender?.tab?.id === undefined ? {} : { tabId: sender.tab.id }),
    ...(sender?.tab?.windowId === undefined
      ? {}
      : { windowId: sender.tab.windowId }),
    ...(sender?.frameId === undefined ? {} : { frameId: sender.frameId }),
    ...(sender?.documentId === undefined
      ? {}
      : { documentId: sender.documentId }),
    ...(sender?.tab?.incognito === undefined
      ? {}
      : { incognito: sender.tab.incognito }),
  });
  if (selectedTarget) {
    selectedRoutes.set(observed, snapshotSelectedTarget(selectedTarget));
  }
  return Object.freeze({ observed });
}

function snapshotSelectedTarget(
  target: ChromeConnectionTarget,
): ChromeConnectionTarget {
  return Object.freeze({ ...target }) as ChromeConnectionTarget;
}

export function matchesChromeTarget(
  target: ChromeConnectionTarget,
  contextMeta: ChromeContextMeta,
  connectionMeta: ChromeConnectionMeta,
): boolean {
  const selectedRoute = selectedRoutes.get(connectionMeta.observed);
  if (target.kind === "background") {
    return selectedRoute
      ? selectedRoute.kind === "background"
      : contextMeta.context === "background";
  }
  if (isChromePageTarget(target)) {
    return (
      selectedRoute !== undefined &&
      isChromePageTarget(selectedRoute) &&
      chromePortName.page(selectedRoute) === chromePortName.page(target)
    );
  }
  if (contextMeta.context !== "content-script") return false;

  if (selectedRoute) {
    if (!isChromeContentTarget(selectedRoute)) return false;
    if (selectedRoute.tabId !== target.tabId) {
      return false;
    }
    if (selectedRoute.kind === "content-frame") {
      return (
        target.kind === "content-frame" &&
        selectedRoute.frameId === target.frameId
      );
    }
    return (
      target.kind === "content-document" &&
      selectedRoute.documentId === target.documentId
    );
  }
  return (
    connectionMeta.observed.tabId === target.tabId &&
    (target.kind === "content-frame"
      ? connectionMeta.observed.frameId === target.frameId
      : connectionMeta.observed.documentId === target.documentId)
  );
}

function isChromePageTarget(
  target: ChromeConnectionTarget,
): target is ChromePageTarget {
  return (
    target.kind !== "background" &&
    target.kind !== "content-frame" &&
    target.kind !== "content-document"
  );
}

function isChromeContentTarget(
  target: ChromeConnectionTarget,
): target is Extract<
  ChromeConnectionTarget,
  { kind: "content-frame" | "content-document" }
> {
  return target.kind === "content-frame" || target.kind === "content-document";
}
