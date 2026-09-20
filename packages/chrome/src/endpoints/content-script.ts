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
import { ChromePort, connectRuntimePort } from "../ports/chrome-port.js";
import { chromePortName } from "../ports/chrome-port-name.js";
import { listenForChromePort } from "../ports/chrome-port-listener.js";
import {
  createChromeConnectionMeta,
  matchesChromeTarget,
} from "./connection-meta.js";

/**
 * Content script endpoint implementation
 * Primarily connects to background script
 */
export class ContentScriptEndpoint implements IEndpoint<ChromeAdapterModel> {
  private stopListening?: () => void;

  capabilities = {
    supportsTransferables: false,
  };

  matchesTarget(
    target: ChromeConnectionTarget,
    contextMeta: ChromeAdapterModel["contextMeta"],
    connectionMeta: ChromeConnectionMeta,
  ): boolean {
    return (
      target.kind !== "content-frame" &&
      target.kind !== "content-document" &&
      matchesChromeTarget(target, contextMeta, connectionMeta)
    );
  }

  listen(onConnect: (port: IPort, meta: ChromeConnectionMeta) => void): void {
    if (this.stopListening) return;
    try {
      const listener = listenForChromePort(
        chromePortName.contentScript,
        (port) =>
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
        target.kind !== "content-frame" &&
        target.kind !== "content-document"
      ) {
        const port = connectRuntimePort(target);
        const chromePort = new ChromePort(port);
        const connectionMeta = createChromeConnectionMeta(port.sender, target);
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

  close(): void {
    this.stopListening?.();
    this.stopListening = undefined;
  }
}
