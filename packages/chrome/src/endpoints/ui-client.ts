import type { IEndpoint, IPort } from "@nexus/core";
import {
  NexusEndpointConnectError,
  NexusEndpointListenError,
} from "@nexus/core";
import type { ChromeUserMeta, ChromePlatformMeta } from "../types/meta";
import { ChromePort } from "../ports/chrome-port";

/**
 * Generic UI client endpoint implementation for Chrome extension contexts
 * that primarily connect to background script (popup, options page, devtools page, etc.)
 */
export class UIClientEndpoint
  implements IEndpoint<ChromeUserMeta, ChromePlatformMeta>
{
  capabilities = {
    supportsTransferables: false,
  };

  /**
   * UI clients typically don't listen for connections
   */
  listen?(onConnect: (port: IPort, meta?: ChromePlatformMeta) => void): void {
    try {
      console.warn(
        "UIClientEndpoint.listen is not commonly used for this context."
      );
      // If future special requirements arise, chrome.runtime.onConnect.addListener can be added here
    } catch (error) {
      throw new NexusEndpointListenError(
        `Failed to start listening for connections: ${error instanceof Error ? error.message : String(error)}`,
        { originalError: error }
      );
    }
  }

  /**
   * Connect to target, typically background script
   */
  async connect(
    target: Partial<ChromeUserMeta>
  ): Promise<[IPort, ChromePlatformMeta]> {
    try {
      if (target.context === "background") {
        const port = chrome.runtime.connect();
        const chromePort = new ChromePort(port);
        const platformMeta: ChromePlatformMeta = {
          sender: port.sender,
        };
        return [chromePort, platformMeta];
      }

      throw new NexusEndpointConnectError(
        "Cannot connect to target: expected 'background' context",
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
}
