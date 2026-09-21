import type { WebSocketLimits } from "../types/options.js";

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
    throw new Error("WebSocket limits must be positive safe integers");
  }
  return limit;
}

export function normalizeLimits(options: WebSocketLimits) {
  return {
    maxConnections: normalizeLimit(options.maxConnections, 64),
    maxPayloadBytes: normalizeLimit(options.maxPayloadBytes, 1024 * 1024),
    maxBufferedAmountBytes: normalizeLimit(
      options.maxBufferedAmountBytes,
      1024 * 1024,
    ),
    maxEarlyPackets: normalizeLimit(options.maxEarlyPackets, 32),
    maxEarlyBytes: normalizeLimit(options.maxEarlyBytes, 1024 * 1024),
  };
}
