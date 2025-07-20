import type { IEndpoint, IPort } from "@nexus/core";
import {
  NexusEndpointConnectError,
  NexusEndpointListenError,
} from "@nexus/core";
import type {
  ChromeUserMeta,
  ChromePlatformMeta,
  ContentScriptMeta,
} from "../types/meta";
import { ChromePort } from "../ports/chrome-port";

/**
 * Background script endpoint implementation
 * Handles connections from content scripts, popups, and other extension contexts
 */
export class BackgroundEndpoint
  implements IEndpoint<ChromeUserMeta, ChromePlatformMeta>
{
  private connectHandler?: (port: IPort, meta?: ChromePlatformMeta) => void;

  capabilities = {
    supportsTransferables: false, // Chrome extension IPC doesn't support transferables
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
      // Background can connect to specific content scripts
      if (
        target.context === "content-script" &&
        typeof target.tabId === "number"
      ) {
        // Type assertion for accessing frameId safely
        const contentScriptTarget = target as ContentScriptMeta;
        const connectInfo: chrome.tabs.ConnectInfo = {};
        if (typeof contentScriptTarget.frameId === "number") {
          connectInfo.frameId = contentScriptTarget.frameId;
        }

        const port = chrome.tabs.connect(
          contentScriptTarget.tabId,
          connectInfo
        );
        const chromePort = new ChromePort(port);
        const platformMeta: ChromePlatformMeta = {
          sender: port.sender,
        };
        return [chromePort, platformMeta];
      }

      throw new NexusEndpointConnectError(
        `Cannot connect to target: expected 'content-script' context with 'tabId', but received ${JSON.stringify(target)}`,
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
