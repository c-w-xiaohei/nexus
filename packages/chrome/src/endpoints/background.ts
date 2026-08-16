import type { IEndpoint, IPort } from "@nexus-js/core";
import {
  NexusEndpointCapabilityError,
  NexusEndpointConnectError,
  NexusEndpointListenError,
} from "@nexus-js/core";
import type {
  ChromeAdapterModel,
  ChromeConnectionTarget,
  ChromeConnectionMeta,
} from "../types/meta.js";
import { ChromePort } from "../ports/chrome-port.js";
import {
  createChromeConnectionMeta,
  matchesChromeTarget,
} from "./connection-meta.js";

/**
 * Background script endpoint implementation
 * Handles connections from content scripts, popups, and other extension contexts
 */
export class BackgroundEndpoint implements IEndpoint<ChromeAdapterModel> {
  private connectHandler?: (port: IPort, meta: ChromeConnectionMeta) => void;

  capabilities = {
    supportsTransferables: false, // Chrome extension IPC doesn't support transferables
  };

  matchesTarget(
    target: ChromeConnectionTarget,
    contextMeta: ChromeAdapterModel["contextMeta"],
    connectionMeta: ChromeConnectionMeta,
  ): boolean {
    return matchesChromeTarget(target, contextMeta, connectionMeta);
  }

  listen(onConnect: (port: IPort, meta: ChromeConnectionMeta) => void): void {
    try {
      this.connectHandler = onConnect;
      chrome.runtime.onConnect.addListener(this.handleConnect);
    } catch (error) {
      throw new NexusEndpointListenError(
        `Failed to start listening for connections: ${error instanceof Error ? error.message : String(error)}`,
        { originalError: error },
      );
    }
  }

  async connect(
    target: ChromeConnectionTarget,
  ): Promise<{ port: IPort; connectionMeta: ChromeConnectionMeta }> {
    try {
      // Background can connect to specific content scripts
      if (
        target.kind === "content-frame" ||
        target.kind === "content-document"
      ) {
        // Type assertion for accessing frameId safely
        const connectInfo: chrome.tabs.ConnectInfo = {};
        if (target.kind === "content-frame") {
          connectInfo.frameId = target.frameId;
        }
        if (target.kind === "content-document") {
          connectInfo.documentId = target.documentId;
        }

        let port: chrome.runtime.Port;
        try {
          port = chrome.tabs.connect(target.tabId, connectInfo);
        } catch (error) {
          if (
            target.kind === "content-document" &&
            isUnsupportedDocumentIdError(error)
          ) {
            throw new NexusEndpointCapabilityError(
              "Chrome tabs.connect() does not support documentId targeting in this runtime.",
              { target, originalError: error },
            );
          }
          throw error;
        }
        const chromePort = new ChromePort(port);
        const connectionMeta = createChromeConnectionMeta(port.sender, target);
        return { port: chromePort, connectionMeta };
      }

      throw new NexusEndpointConnectError(
        `Cannot connect to target: expected 'content-script' context with 'tabId', but received ${JSON.stringify(target)}`,
        { target },
      );
    } catch (error) {
      if (
        error instanceof NexusEndpointConnectError ||
        error instanceof NexusEndpointCapabilityError
      ) {
        throw error;
      }
      throw new NexusEndpointConnectError(
        `Failed to connect to target: ${error instanceof Error ? error.message : String(error)}`,
        { target, originalError: error },
      );
    }
  }

  private handleConnect = (port: chrome.runtime.Port) => {
    if (!this.connectHandler) return;

    const chromePort = new ChromePort(port);
    const connectionMeta = createChromeConnectionMeta(port.sender);

    this.connectHandler(chromePort, connectionMeta);
  };
}

function isUnsupportedDocumentIdError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unexpected (?:property|key).*documentId|documentId.*(?:not supported|unsupported|unexpected))/i.test(
    message,
  );
}
