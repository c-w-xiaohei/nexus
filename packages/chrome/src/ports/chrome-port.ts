import { NexusEndpointCapabilityError, type IPort } from "@nexus-js/core";
import type {
  ChromeBackgroundTarget,
  ChromeContentDocumentTarget,
  ChromeContentFrameTarget,
  ChromePageTarget,
} from "../types/meta.js";
import { chromePortName } from "./chrome-port-name.js";

export function connectRuntimePort(
  target: ChromeBackgroundTarget | ChromePageTarget,
): chrome.runtime.Port {
  return chrome.runtime.connect({
    name:
      target.kind === "background"
        ? chromePortName.background
        : chromePortName.page(target),
  });
}

export function connectContentPort(
  target: ChromeContentFrameTarget | ChromeContentDocumentTarget,
): chrome.runtime.Port {
  const connectInfo: chrome.tabs.ConnectInfo = {
    name: chromePortName.contentScript,
    ...(target.kind === "content-frame"
      ? { frameId: target.frameId }
      : { documentId: target.documentId }),
  };

  try {
    return chrome.tabs.connect(target.tabId, connectInfo);
  } catch (error) {
    if (
      target.kind === "content-document" &&
      /(?:unexpected (?:property|key).*documentId|documentId.*(?:not supported|unsupported|unexpected))/i.test(
        error instanceof Error ? error.message : String(error),
      )
    ) {
      throw new NexusEndpointCapabilityError(
        "Chrome tabs.connect() does not support documentId targeting in this runtime.",
        { target, originalError: error },
      );
    }
    throw error;
  }
}

/**
 * Wraps chrome.runtime.Port to implement Nexus IPort interface
 */
export class ChromePort implements IPort {
  private messageHandler?: (data: any) => void;
  private disconnectHandler?: () => void;

  constructor(private port: chrome.runtime.Port) {
    // Set up event listeners
    this.port.onMessage.addListener(this.handleMessage);
    this.port.onDisconnect.addListener(this.handleDisconnect);
  }

  postMessage(data: any): void {
    this.port.postMessage(data);
  }

  onMessage(handler: (data: any) => void): void {
    this.messageHandler = handler;
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  close(): void {
    this.port.disconnect();
  }

  private handleMessage = (data: any) => {
    if (this.messageHandler) {
      this.messageHandler(data);
    }
  };

  private handleDisconnect = () => {
    if (this.disconnectHandler) {
      this.disconnectHandler();
    }
  };

  /**
   * Get the underlying chrome.runtime.Port for advanced usage
   */
  get nativePort(): chrome.runtime.Port {
    return this.port;
  }
}
