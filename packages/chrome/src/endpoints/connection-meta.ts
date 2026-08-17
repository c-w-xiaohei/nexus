import type {
  ChromeConnectionMeta,
  ChromeConnectionTarget,
  ChromeContextMeta,
  ChromeObservedConnectionFacts,
} from "../types/meta";

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
  });
  if (selectedTarget) {
    selectedRoutes.set(observed, snapshotSelectedTarget(selectedTarget));
  }
  return Object.freeze({ observed });
}

function snapshotSelectedTarget(
  target: ChromeConnectionTarget,
): ChromeConnectionTarget {
  switch (target.kind) {
    case "background":
      return Object.freeze({ kind: "background" });
    case "content-frame":
      return Object.freeze({
        kind: "content-frame",
        tabId: target.tabId,
        frameId: target.frameId,
      });
    case "content-document":
      return Object.freeze({
        kind: "content-document",
        tabId: target.tabId,
        documentId: target.documentId,
      });
  }
}

export function matchesChromeTarget(
  target: ChromeConnectionTarget,
  contextMeta: ChromeContextMeta,
  connectionMeta: ChromeConnectionMeta,
): boolean {
  if (target.kind === "background") return contextMeta.context === "background";
  if (contextMeta.context !== "content-script") return false;

  const selectedRoute = selectedRoutes.get(connectionMeta.observed);
  if (selectedRoute) {
    if (selectedRoute.kind === "background") return false;
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
