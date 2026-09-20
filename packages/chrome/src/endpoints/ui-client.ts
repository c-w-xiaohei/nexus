import type { IEndpoint, IPort } from "@nexus-js/core";
import {
  NexusEndpointCapabilityError,
  NexusEndpointConnectError,
} from "@nexus-js/core";
import type {
  ChromeAdapterModel,
  ChromeConnectionMeta,
  ChromeConnectionTarget,
  ChromePageTarget,
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

/** Endpoint for extension pages, including popup, side panel and offscreen pages. */
export class UIClientEndpoint implements IEndpoint<ChromeAdapterModel> {
  capabilities = { supportsTransferables: false };
  private stopListening?: () => void;
  private readonly acceptedPorts = new Set<chrome.runtime.Port>();
  private readonly receiver?:
    | ChromePageTarget
    | (() => Promise<ChromePageTarget>);
  private readonly exclusiveReceiver: boolean;
  private releaseReceiverLock?: () => void;
  private readonly canConnectContent: boolean;

  constructor(
    options: {
      receiver?: ChromePageTarget | (() => Promise<ChromePageTarget>);
      exclusiveReceiver?: boolean;
      canConnectContent?: boolean;
    } = {},
  ) {
    const {
      receiver,
      exclusiveReceiver = false,
      canConnectContent = true,
    } = options;
    this.receiver = receiver;
    this.exclusiveReceiver = exclusiveReceiver;
    this.canConnectContent = canConnectContent;
  }

  matchesTarget = (
    target: ChromeConnectionTarget,
    contextMeta: ChromeAdapterModel["contextMeta"],
    connectionMeta: ChromeConnectionMeta,
  ): boolean => {
    if (!this.canConnectContent && isContentTarget(target)) {
      return false;
    }

    return matchesChromeTarget(target, contextMeta, connectionMeta);
  };

  async listen(
    onConnect: (port: IPort, meta: ChromeConnectionMeta) => void,
  ): Promise<void> {
    if (!this.receiver || this.stopListening) return;
    if (typeof addEventListener === "function") {
      addEventListener("pagehide", this.handlePageHide);
    }
    const listener = listenForChromePort(this.getReceiverName(), (port) => {
      this.acceptedPorts.add(port);
      port.onDisconnect.addListener(() => this.acceptedPorts.delete(port));
      onConnect(new ChromePort(port), createChromeConnectionMeta(port.sender));
    });
    this.stopListening = listener.stop;
    await listener.ready;
  }

  async connect(
    target: ChromeConnectionTarget,
  ): Promise<{ port: IPort; connectionMeta: ChromeConnectionMeta }> {
    try {
      if (!isContentTarget(target)) {
        const port = connectRuntimePort(target);
        return {
          port: new ChromePort(port),
          connectionMeta: createChromeConnectionMeta(port.sender, target),
        };
      }
      if (!this.canConnectContent) {
        throw new NexusEndpointCapabilityError(
          "Offscreen documents cannot connect to content scripts.",
          { target },
        );
      }
      const port = connectContentPort(target);
      return {
        port: new ChromePort(port),
        connectionMeta: createChromeConnectionMeta(port.sender, target),
      };
    } catch (error) {
      if (error instanceof NexusEndpointCapabilityError) throw error;
      throw new NexusEndpointConnectError(
        `Failed to connect to target: ${error instanceof Error ? error.message : String(error)}`,
        { target, originalError: error },
      );
    }
  }

  close(): void {
    this.disconnectAcceptedPorts();
    this.stopListening?.();
    this.stopListening = undefined;
    this.releaseReceiverLock?.();
    this.releaseReceiverLock = undefined;
    if (typeof removeEventListener === "function") {
      removeEventListener("pagehide", this.handlePageHide);
    }
  }

  private handlePageHide = (): void => this.disconnectAcceptedPorts();

  private disconnectAcceptedPorts(): void {
    const ports = [...this.acceptedPorts];
    this.acceptedPorts.clear();
    for (const port of ports) port.disconnect();
  }

  private getReceiverName(): string | Promise<string> {
    const receiver = this.receiver!;
    const name =
      typeof receiver === "function"
        ? receiver().then(chromePortName.page)
        : chromePortName.page(receiver);
    if (!this.exclusiveReceiver) return name;
    if (typeof name === "string") {
      return this.acquireReceiverLock(name).then(() => name);
    }
    return name.then(async (resolved) => {
      await this.acquireReceiverLock(resolved);
      return resolved;
    });
  }

  private async acquireReceiverLock(name: string): Promise<void> {
    let acquired!: (ownsLock: boolean) => void;
    let rejectAcquisition!: (error: unknown) => void;
    const ownsLock = new Promise<boolean>((resolve, reject) => {
      acquired = resolve;
      rejectAcquisition = reject;
    });
    const released = new Promise<void>((resolve) => {
      this.releaseReceiverLock = resolve;
    });
    void navigator.locks
      .request(name, { ifAvailable: true }, async (lock) => {
        acquired(lock !== null);
        if (lock) await released;
      })
      .catch(rejectAcquisition);
    try {
      if (await ownsLock) return;
      this.releaseReceiverLock = undefined;
      throw new Error(`Chrome receiver '${name}' is already active.`);
    } catch (error) {
      this.releaseReceiverLock = undefined;
      throw error;
    }
  }
}

function isContentTarget(
  target: ChromeConnectionTarget,
): target is Extract<
  ChromeConnectionTarget,
  { kind: "content-frame" | "content-document" }
> {
  return target.kind === "content-frame" || target.kind === "content-document";
}
