import type { IEndpoint, IPort } from "@nexus/core";
import {
  NexusEndpointConnectError,
  NexusEndpointListenError,
} from "@nexus/core";
import type { ChromeUserMeta, ChromePlatformMeta } from "../types/meta";
import { ChromePort } from "../ports/chrome-port";

/**
 * Content script endpoint implementation
 * Primarily connects to background script
 */
export class ContentScriptEndpoint
  implements IEndpoint<ChromeUserMeta, ChromePlatformMeta>
{
  private connectHandler?: (port: IPort, meta?: ChromePlatformMeta) => void;

  capabilities = {
    supportsTransferables: false,
  };

  listen(onConnect: (port: IPort, meta?: ChromePlatformMeta) => void): void {
    try {
      this.connectHandler = onConnect;
      chrome.runtime.onConnect.addListener(this.handleConnect);
    } catch (error) {
      throw new NexusEndpointListenError(
        `Failed to start listening for connections: ${error instanceof Error ? error.message : String(error)}`,
        { originalError: error }
      );
    }
  }

  async connect(
    target: Partial<ChromeUserMeta>
  ): Promise<[IPort, ChromePlatformMeta]> {
    try {
      // Content script typically connects to background
      if (target.context === "background") {
        const port = chrome.runtime.connect();
        const chromePort = new ChromePort(port);
        const platformMeta: ChromePlatformMeta = {
          sender: port.sender,
        };
        return [chromePort, platformMeta];
      }

      throw new NexusEndpointConnectError(
        "Cannot connect to target: unsupported target type",
        { target }
      );
    } catch (error) {
      if (error instanceof NexusEndpointConnectError) {
        throw error;
      }
      throw new NexusEndpointConnectError(
        `Failed to connect to target: ${error instanceof Error ? error.message : String(error)}`,
        { target, originalError: error }
      );
    }
  }

  private handleConnect = (port: chrome.runtime.Port) => {
    if (!this.connectHandler) return;

    const chromePort = new ChromePort(port);
    const platformMeta: ChromePlatformMeta = {
      sender: port.sender,
    };

    this.connectHandler(chromePort, platformMeta);
  };
}
