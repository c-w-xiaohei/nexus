import type { IEndpoint, IPort } from "@nexus-js/core";
import {
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
 * Content script endpoint implementation
 * Primarily connects to background script
 */
export class ContentScriptEndpoint implements IEndpoint<ChromeAdapterModel> {
  private connectHandler?: (port: IPort, meta: ChromeConnectionMeta) => void;

  capabilities = {
    supportsTransferables: false,
  };

  matchesTarget(
    target: ChromeConnectionTarget,
    contextMeta: ChromeAdapterModel["contextMeta"],
    connectionMeta: ChromeConnectionMeta,
  ): boolean {
    return (
      target.kind === "background" &&
      matchesChromeTarget(target, contextMeta, connectionMeta)
    );
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
      // Content script typically connects to background
      if (target.kind === "background") {
        const port = chrome.runtime.connect();
        const chromePort = new ChromePort(port);
        const connectionMeta = createChromeConnectionMeta(port.sender, {
          kind: "background",
        });
        return { port: chromePort, connectionMeta };
      }

      throw new NexusEndpointConnectError(
        "Cannot connect to target: unsupported target type",
        { target },
      );
    } catch (error) {
      if (error instanceof NexusEndpointConnectError) {
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
