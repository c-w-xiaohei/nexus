import { resolveTransportConfig } from "@nexus-js/core/transport/config";
import type { WebSocketLimits } from "../types/options.js";
import { WebSocketAdapterError } from "../errors.js";

function invalidConfig(message: string): WebSocketAdapterError {
  return new WebSocketAdapterError(message, "E_WEBSOCKET_CONFIG_INVALID");
}

export function normalizeTargetUrl(value: string): string {
  const url = new globalThis.URL(value);
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Invalid WebSocket URL");
  }
  return url.href;
}

export function normalizeLimit(
  value: number | undefined,
  fallback: number,
): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw invalidConfig("WebSocket limits must be positive safe integers");
  }
  return limit;
}

export function normalizeLimits(options: WebSocketLimits) {
  if ("maxPayloadBytes" in options)
    throw invalidConfig("Use transport.maxFrameBytes for WebSocket frames");
  let config;
  try {
    config = resolveTransportConfig(options.transport, true);
  } catch (error) {
    throw invalidConfig(
      error instanceof Error ? error.message : "Invalid transport limits",
    );
  }
  if (config.maxFrameBytes > 1024 * 1024) {
    throw invalidConfig(
      "WebSocket transport config exceeds native packet limit",
    );
  }
  return {
    maxConnections: normalizeLimit(options.maxConnections, 64),
    config,
    maxBufferedAmountBytes: normalizeLimit(
      options.maxBufferedAmountBytes,
      1024 * 1024,
    ),
    sendTimeoutMs: 30_000,
    maxEarlyPackets: normalizeLimit(options.maxEarlyPackets, 32),
    maxEarlyBytes: normalizeLimit(options.maxEarlyBytes, 1024 * 1024),
  };
}
