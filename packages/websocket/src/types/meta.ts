import type { AdapterModel } from "@nexus-js/core";

export type WebSocketContextMeta = {
  readonly context: "websocket-client" | "websocket-server";
};

export type WebSocketTarget = {
  readonly context: "websocket-server";
  readonly url: string;
};

/** Host-supplied local facts. They are not authenticated by the adapter. */
export type WebSocketServerConnectionMeta<Facts extends object> = Readonly<
  Omit<Facts, "role">
> & { readonly role: "server" };

export type WebSocketClientConnectionMeta = {
  readonly role: "client";
  readonly selectedUrl: string;
  readonly protocol: string;
};

export type WebSocketConnectionMeta<Facts extends object = object> =
  | WebSocketServerConnectionMeta<Facts>
  | WebSocketClientConnectionMeta;

export interface WebSocketAdapterModel<
  Facts extends object = object,
> extends AdapterModel {
  contextMeta: WebSocketContextMeta;
  connectionMeta: WebSocketConnectionMeta<Facts>;
  connectionTarget: WebSocketTarget;
}
