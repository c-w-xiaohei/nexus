import { nexus, type NexusConfig, type NexusInstance } from "@nexus-js/core";
import { WebSocketClientEndpoint } from "./endpoints/websocket-client-endpoint.js";
import type { WebSocketAdapterModel } from "./types/meta.js";
import type {
  WebSocketClientConfigOptions,
  WebSocketClientInstanceOptions,
} from "./types/options.js";

export function usingWebSocketClient(
  options: WebSocketClientConfigOptions,
): NexusConfig<WebSocketAdapterModel>;
export function usingWebSocketClient(
  options?: WebSocketClientInstanceOptions,
): NexusInstance<WebSocketAdapterModel>;
export function usingWebSocketClient(
  options: WebSocketClientConfigOptions | WebSocketClientInstanceOptions = {},
) {
  const { configure, connectTo, providers, policy, callTimeout } = options;
  const config: NexusConfig<WebSocketAdapterModel> = {
    providers,
    policy,
    callTimeout,
    endpoint: {
      meta: { context: "websocket-client" },
      implementation: new WebSocketClientEndpoint(options),
      ...(connectTo ? { connectTo } : {}),
    },
  };

  return configure === false
    ? config
    : (nexus as unknown as NexusInstance<WebSocketAdapterModel>).configure(
        config,
      );
}
