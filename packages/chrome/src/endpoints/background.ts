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
import {
  ChromePort,
  connectContentPort,
  connectRuntimePort,
} from "../ports/chrome-port.js";
import { chromePortName } from "../ports/chrome-port-name.js";
import { listenForChromePort } from "../ports/chrome-port-listener.js";
import {
  createChromeConnectionMeta,
  matchesChromeTarget,
} from "./connection-meta.js";

/**
 * Background script endpoint implementation
 * Handles connections from content scripts, popups, and other extension contexts
 */
export class BackgroundEndpoint implements IEndpoint<ChromeAdapterModel> {
  private stopListening?: () => void;

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
    if (this.stopListening) return;
    try {
      const listener = listenForChromePort(chromePortName.background, (port) =>
        onConnect(
          new ChromePort(port),
          createChromeConnectionMeta(port.sender),
        ),
      );
      this.stopListening = listener.stop;
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
      if (
        target.kind === "content-frame" ||
        target.kind === "content-document"
      ) {
        const port = connectContentPort(target);
        const chromePort = new ChromePort(port);
        const connectionMeta = createChromeConnectionMeta(port.sender, target);
        return { port: chromePort, connectionMeta };
      }

      if (target.kind !== "background") {
        const port = connectRuntimePort(target);
        return {
          port: new ChromePort(port),
          connectionMeta: createChromeConnectionMeta(port.sender, target),
        };
      }
      throw new NexusEndpointConnectError(
        `Cannot connect to target: unsupported target ${JSON.stringify(target)}`,
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

  close(): void {
    this.stopListening?.();
    this.stopListening = undefined;
  }
}
