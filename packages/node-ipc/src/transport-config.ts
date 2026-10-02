import { resolveTransportConfig } from "@nexus-js/core/transport/config";
import type {
  ResolvedTransportConfig,
  TransportLimits,
} from "@nexus-js/core/transport/config";
import { NodeIpcError } from "./errors.js";
import { MAX_FRAME_SIZE } from "./framing/binary-frame.js";

export function resolveNodeIpcTransport(
  input: TransportLimits | undefined,
): Readonly<ResolvedTransportConfig> {
  let config: Readonly<ResolvedTransportConfig>;
  try {
    config = resolveTransportConfig(input, true);
  } catch (error) {
    throw new NodeIpcError(
      error instanceof Error
        ? error.message
        : "Invalid Node IPC transport limits",
      "E_IPC_CONFIG_INVALID",
    );
  }
  if (
    config.maxFrameBytes > MAX_FRAME_SIZE ||
    config.maxFrameBytes > config.maxMessageBytes ||
    config.maxMessageBytes > MAX_FRAME_SIZE ||
    config.maxBufferedBytes < config.maxMessageBytes * 2
  ) {
    throw new NodeIpcError(
      "Invalid Node IPC transport limits",
      "E_IPC_CONFIG_INVALID",
    );
  }
  return config;
}
