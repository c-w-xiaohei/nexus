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
 * Generic UI client endpoint implementation for Chrome extension contexts
 * that primarily connect to background script (popup, options page, devtools page, etc.)
 */
export class UIClientEndpoint implements IEndpoint<ChromeAdapterModel> {
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

  /**
   * UI clients typically don't listen for connections
   */
  listen?(_onConnect: (port: IPort, meta: ChromeConnectionMeta) => void): void {
    try {
      console.warn(
        "UIClientEndpoint.listen is not commonly used for this context.",
      );
      // If future special requirements arise, chrome.runtime.onConnect.addListener can be added here
    } catch (error) {
      throw new NexusEndpointListenError(
        `Failed to start listening for connections: ${error instanceof Error ? error.message : String(error)}`,
        { originalError: error },
      );
    }
  }

  /**
   * Connect to target, typically background script
   */
  async connect(
    target: ChromeConnectionTarget,
  ): Promise<{ port: IPort; connectionMeta: ChromeConnectionMeta }> {
    try {
      if (target.kind === "background") {
        const port = chrome.runtime.connect();
        const chromePort = new ChromePort(port);
        const connectionMeta = createChromeConnectionMeta(port.sender, {
          kind: "background",
        });
        return { port: chromePort, connectionMeta };
      }

      throw new NexusEndpointConnectError(
        "Cannot connect to target: expected 'background' context",
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
}
