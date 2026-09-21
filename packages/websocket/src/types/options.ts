import type { NexusConfig } from "@nexus-js/core";
import type { WebSocketAdapterModel, WebSocketTarget } from "./meta.js";

export type WebSocketLimits = {
  readonly maxConnections?: number;
  readonly maxPayloadBytes?: number;
  readonly maxBufferedAmountBytes?: number;
  readonly maxEarlyPackets?: number;
  readonly maxEarlyBytes?: number;
};

export type WebSocketClientOptions = WebSocketLimits & {
  /** Standard WebSocket subprotocols; omitted by default. */
  readonly protocols?: readonly string[];
  /** Bounds the native dial, independently of Core's shared acquisition wait. */
  readonly connectTimeoutMs?: number;
};

export type WebSocketServerOptions = WebSocketLimits;

type ClientConfig = WebSocketClientOptions &
  Omit<NexusConfig<WebSocketAdapterModel>, "endpoint"> & {
    readonly connectTo?: readonly WebSocketTarget[];
  };

export type WebSocketClientConfigOptions = ClientConfig & {
  readonly configure: false;
};

export type WebSocketClientInstanceOptions = ClientConfig & {
  readonly configure?: true;
};
