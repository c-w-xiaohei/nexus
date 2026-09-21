import { Result } from "better-result";
import type { IEndpoint, IPort } from "@nexus-js/core";
import { WebSocketAdapterError } from "../errors.js";
import { WebSocketPort } from "../ports/websocket-port.js";
import {
  normalizeLimit,
  normalizeLimits,
  normalizeTargetUrl,
} from "../runtime/validation.js";
import type {
  WebSocketAdapterModel,
  WebSocketClientConnectionMeta,
  WebSocketTarget,
} from "../types/meta.js";
import type { WebSocketClientOptions } from "../types/options.js";

export class WebSocketClientEndpoint implements IEndpoint<WebSocketAdapterModel> {
  readonly capabilities = { binaryPackets: true };
  private closed = false;
  private readonly ports = new Set<WebSocketPort>();
  private readonly limits;
  private readonly connectTimeoutMs;
  private readonly protocols;

  constructor(options: WebSocketClientOptions = {}) {
    this.limits = normalizeLimits(options);
    this.connectTimeoutMs = normalizeLimit(options.connectTimeoutMs, 5_000);
    this.protocols = options.protocols ? [...options.protocols] : undefined;
  }

  /** IEndpoint is a throw-style boundary; internal dial completion uses Result. */
  async connect(target: WebSocketTarget): Promise<{
    port: IPort;
    connectionMeta: WebSocketClientConnectionMeta;
  }> {
    if (this.closed) throw this.error("E_WEBSOCKET_ENDPOINT_CLOSED");
    if (!globalThis.WebSocket)
      throw this.error("E_WEBSOCKET_CLIENT_UNAVAILABLE");
    if (this.ports.size >= this.limits.maxConnections)
      throw this.error("E_WEBSOCKET_CAPACITY");
    const selectedUrl = normalizeTargetUrl(target.url);
    const created = Result.try({
      try: () => new globalThis.WebSocket(selectedUrl, this.protocols),
      catch: () => this.error("E_WEBSOCKET_CONNECTION_FAILED"),
    });
    if (created.isErr()) throw created.error;
    const socket = created.value;
    const result = await new Promise<
      Result<WebSocketPort, WebSocketAdapterError>
    >((resolve) => {
      let settled = false;
      const finish = (result: Result<WebSocketPort, WebSocketAdapterError>) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        socket.removeEventListener("open", opened);
        resolve(result);
      };
      const port = new WebSocketPort(socket, this.limits, () => {
        this.ports.delete(port);
        finish(
          Result.err(
            this.error(
              this.closed
                ? "E_WEBSOCKET_ENDPOINT_CLOSED"
                : "E_WEBSOCKET_CONNECTION_FAILED",
            ),
          ),
        );
      });
      const opened = () => finish(Result.ok(port));
      const timeout = globalThis.setTimeout(
        () => port.close(),
        this.connectTimeoutMs,
      );
      this.ports.add(port);
      socket.addEventListener("open", opened, { once: true });
    });
    if (result.isErr()) throw result.error;
    return {
      port: result.value,
      connectionMeta: {
        role: "client",
        selectedUrl,
        protocol: socket.protocol,
      },
    };
  }

  targetKey(target: WebSocketTarget): string {
    return normalizeTargetUrl(target.url);
  }

  matchesTarget(
    target: WebSocketTarget,
    _context?: unknown,
    meta?: WebSocketAdapterModel["connectionMeta"],
  ): boolean {
    return (
      target.context === "websocket-server" &&
      meta?.role === "client" &&
      meta.selectedUrl === normalizeTargetUrl(target.url)
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const port of this.ports) port.close();
  }

  private error(code: WebSocketAdapterError["code"]): WebSocketAdapterError {
    return new WebSocketAdapterError(
      "WebSocket connection could not be established",
      code,
    );
  }
}
