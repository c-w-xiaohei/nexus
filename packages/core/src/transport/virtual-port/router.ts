import { Result } from "better-result";
import type { IPort } from "../types/port.js";
import {
  VirtualPortCloseError,
  VirtualPortConnectError,
  VirtualPortListenError,
} from "./errors.js";
import { VirtualPortProtocol } from "./protocol.js";
import { VirtualPort, type VirtualPortOptions } from "./virtual-port.js";

/** Owns a bus subscription and its virtual channels. Close when the bus owner ends. */
export class VirtualPortRouter {
  private readonly channels = new Map<string, VirtualPort>();
  private readonly closedChannels = new Set<string>();
  private readonly localId: string;
  private readonly portOptions: VirtualPortOptions;
  private unsubscribe: (() => void) | undefined;
  private onConnect: ((port: IPort) => void) | undefined;
  private isClosed = false;

  /** Subscribes immediately; a bus subscription failure propagates to the caller. */
  constructor(options: VirtualPortRouter.Options) {
    this.localId = options.localId ?? createId("vp-local");
    this.portOptions = {
      bus: options.bus,
      heartbeat: {
        enabled: options.heartbeat?.enabled ?? true,
        intervalMs: options.heartbeat?.intervalMs ?? 5000,
        maxMisses: options.heartbeat?.maxMisses ?? 3,
      },
      connectTimeoutMs: options.connectTimeoutMs ?? 5000,
    };
    this.unsubscribe = options.bus.subscribe((message) => {
      try {
        this.handleMessage(message);
      } catch (error) {
        console.error(
          "Nexus DEV: unhandled virtual port bus message error",
          error,
        );
      }
    });
  }

  get listening(): boolean {
    return this.onConnect !== undefined;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Accept future channels with this callback, replacing any previous listener. */
  safeListen(
    onConnect: (port: IPort) => void,
  ): Result<void, VirtualPortListenError> {
    if (this.isClosed)
      return Result.err(
        new VirtualPortListenError("Virtual port router is closed"),
      );
    this.onConnect = onConnect;
    return Result.ok(undefined);
  }

  /**
   * Open a virtual channel, resolving on ACCEPT or with Err on rejection/timeout.
   * The returned port retains startup data until its first message subscription.
   */
  async safeConnect(): Promise<Result<IPort, VirtualPortConnectError>> {
    if (this.isClosed)
      return Result.err(
        new VirtualPortConnectError("Virtual port router is closed"),
      );
    return this.createPort(
      createId("vp-channel"),
      createId("vp-nonce"),
    ).connect();
  }

  /** Idempotently release channels, timers and replay history despite observer errors. */
  safeClose(): Result<void, VirtualPortCloseError> {
    if (this.isClosed) return Result.ok(undefined);
    this.isClosed = true;
    this.onConnect = undefined;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    let result = Result.try({
      try: () => unsubscribe?.(),
      catch: (error) => error,
    });
    // Closing forbids new admission; deleting current/other entries is safe.
    for (const port of this.channels.values()) {
      const closed = port.disconnect(true);
      if (closed.isErr() && result.isOk()) result = closed;
    }
    // Live routers retain tombstones for replay safety. Closed routers admit no
    // packets, so their history can be released even while the router is retained.
    this.closedChannels.clear();
    return result.mapError(
      (error) =>
        new VirtualPortCloseError("Failed to close virtual port router", {
          originalError: error,
        }),
    );
  }

  // ===== Routing (Private) =====

  private handleMessage(rawMessage: unknown): void {
    if (this.isClosed) return;
    const result = VirtualPortProtocol.safeClassify(rawMessage);
    if (result.isErr()) return;
    const message = result.value;
    if (message.from === this.localId) return;
    const existing = this.channels.get(message.channelId);

    if (message.type !== "connect") {
      if (existing?.base.nonce === message.nonce) existing.receive(message);
      return;
    }
    if (existing) {
      if (existing.isOpen && existing.base.nonce === message.nonce)
        existing.accept();
      return;
    }
    if (!this.onConnect || this.closedChannels.has(message.channelId)) {
      // No admitted channel owns this rejection; sending is best-effort.
      Result.try({
        try: () =>
          this.portOptions.bus.send({
            ...VirtualPortProtocol.createBase({
              channelId: message.channelId,
              from: this.localId,
              nonce: message.nonce,
            }),
            type: "reject",
            reason: "listener-unavailable",
          }),
        catch: (error) => error,
      });
      return;
    }

    // Install routing before ACCEPT can synchronously deliver data or close.
    const port = this.createPort(message.channelId, message.nonce);
    if (port.accept().isErr()) {
      port.disconnect(false);
      return;
    }
    if (!port.isOpen) return;
    try {
      this.onConnect(port);
    } catch (error) {
      port.disconnect(true);
      console.error(
        "Nexus DEV: unhandled error in VirtualPortRouter.safeListen onConnect callback",
        error,
      );
    }
  }

  private createPort(channelId: string, nonce: string): VirtualPort {
    const port = new VirtualPort(
      VirtualPortProtocol.createBase({ channelId, from: this.localId, nonce }),
      this.portOptions,
      () => {
        this.channels.delete(channelId);
        if (!this.isClosed) this.closedChannels.add(channelId);
      },
    );
    this.channels.set(channelId, port);
    return port;
  }
}

// Types only; lifecycle operations belong to the router instance.
export namespace VirtualPortRouter {
  export interface Bus {
    /** Send a protocol envelope; implementations may synchronously reenter subscribers. */
    send(
      message: unknown,
      transfer?: Transferable[],
    ): void | Result<void, unknown>;
    /** Subscribe to bus envelopes and return the corresponding unsubscribe function. */
    subscribe(handler: (message: unknown) => void): () => void;
  }

  export interface HeartbeatOptions {
    readonly enabled?: boolean;
    readonly intervalMs?: number;
    readonly maxMisses?: number;
  }

  export interface Options {
    readonly bus: Bus;
    readonly localId?: string;
    readonly heartbeat?: HeartbeatOptions;
    readonly connectTimeoutMs?: number;
  }
}

const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
