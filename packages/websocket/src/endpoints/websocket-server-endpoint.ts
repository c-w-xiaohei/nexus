import { Result } from "better-result";
import type { IEndpoint, IPort } from "@nexus-js/core";
import type WebSocket from "ws";
import { WebSocketAdapterError } from "../errors.js";
import { WebSocketPort } from "../ports/websocket-port.js";
import { normalizeLimits } from "../runtime/validation.js";
import type {
  WebSocketAdapterModel,
  WebSocketServerConnectionMeta,
} from "../types/meta.js";
import type { WebSocketServerOptions } from "../types/options.js";

/** Adopts open Node ws connections; the HTTP/WS server remains application-owned. */
export class WebSocketServerEndpoint<
  Facts extends object = object,
> implements IEndpoint<WebSocketAdapterModel<Facts>> {
  readonly capabilities = { binaryPackets: true };
  private readonly ports = new Map<WebSocket, WebSocketPort>();
  private readonly limits;
  private closed = false;
  private accept?: (
    port: IPort,
    meta: WebSocketAdapterModel<Facts>["connectionMeta"],
  ) => void;

  constructor(options: WebSocketServerOptions = {}) {
    this.limits = normalizeLimits(options);
  }

  listen(
    accept: (
      port: IPort,
      meta: WebSocketAdapterModel<Facts>["connectionMeta"],
    ) => void,
  ): void {
    if (this.closed)
      throw new WebSocketAdapterError(
        "Endpoint is closed",
        "E_WEBSOCKET_ENDPOINT_CLOSED",
      );
    this.accept = accept;
  }

  /** Synchronously transfers ownership on success, before the host yields to another message. */
  safeAttach(
    socket: WebSocket,
    facts: Facts,
  ): Result<void, WebSocketAdapterError> {
    if (this.closed)
      return Result.err(
        new WebSocketAdapterError(
          "Endpoint is closed",
          "E_WEBSOCKET_ENDPOINT_CLOSED",
        ),
      );
    if (!this.accept)
      return Result.err(
        new WebSocketAdapterError(
          "Endpoint is not listening",
          "E_WEBSOCKET_NOT_LISTENING",
        ),
      );
    if (socket.readyState !== 1 || this.ports.has(socket)) {
      return Result.err(
        new WebSocketAdapterError(
          "Socket must be open and not already attached",
          "E_WEBSOCKET_ATTACH_REJECTED",
        ),
      );
    }
    if (this.ports.size >= this.limits.maxConnections) {
      return Result.err(
        new WebSocketAdapterError(
          "Endpoint capacity exceeded",
          "E_WEBSOCKET_CAPACITY",
        ),
      );
    }
    const meta: WebSocketServerConnectionMeta<Facts> = Object.freeze({
      ...facts,
      role: "server" as const,
    });
    const port = new WebSocketPort(socket, this.limits, () =>
      this.ports.delete(socket),
    );
    this.ports.set(socket, port);
    // A delivery exception is not a recoverable attach rejection: ownership has transferred.
    // Clean up before propagating constructor/callback misuse to the host.
    try {
      this.accept(port, meta);
    } catch (error) {
      port.close();
      throw error;
    }
    return Result.ok(undefined);
  }

  attach(socket: WebSocket, facts: Facts): void {
    const result = this.safeAttach(socket, facts);
    if (result.isErr()) throw result.error;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.accept = undefined;
    for (const port of this.ports.values()) port.close();
  }
}
