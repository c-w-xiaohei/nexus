export {};

const runId = new URLSearchParams(location.search).get("runId");
const bridgeStatus = document.querySelector<HTMLDataElement>("#bridge-status");

type BridgeResult = {
  readonly kind: "result" | "error";
  readonly runId: string;
  readonly command: string;
  readonly sequence: number;
  readonly participant: string;
  readonly sessionId: string;
  readonly value: string;
};
const maxResultKeys = 256;
const maxResultsPerKey = 8;

declare global {
  interface Window {
    __nexusE2eResults?: Record<string, BridgeResult[]>;
  }
}

window.__nexusE2eResults ??= Object.create(null) as Record<
  string,
  BridgeResult[]
>;

for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe")) {
  const url = new URL(frame.src);
  if (runId) url.searchParams.set("runId", runId);
  frame.src = url.href;
}

window.addEventListener("nexus-e2e-result", (event) => {
  writeBridgeResult(event instanceof CustomEvent ? event.detail : undefined);
});

window.addEventListener("message", (event) => {
  if (!isCurrentFrameMessage(event, runId)) return;
  window.dispatchEvent(
    new CustomEvent("nexus-e2e-result", { detail: event.data }),
  );
});

function writeBridgeResult(value: unknown): void {
  if (!isBridgeResult(value, runId)) return;
  const results = window.__nexusE2eResults!;
  const key = bridgeResultKey(value);
  const entries = (results[key] ??= []);
  entries.push(value);
  if (entries.length > maxResultsPerKey) entries.shift();
  const keys = Object.keys(results);
  if (keys.length > maxResultKeys) delete results[keys[0]];
  if (!bridgeStatus) return;
  bridgeStatus.value = JSON.stringify(value);
  bridgeStatus.dataset.sequence = String(value.sequence);
}

function bridgeResultKey(result: BridgeResult): string {
  return JSON.stringify([
    result.runId,
    result.command,
    result.sequence,
    result.participant,
    result.sessionId,
  ]);
}

function isBridgeResult(
  value: unknown,
  expectedRunId: string | null,
): value is {
  readonly kind: "result" | "error";
  readonly runId: string;
  readonly command: string;
  readonly sequence: number;
  readonly participant: string;
  readonly sessionId: string;
  readonly value: string;
} {
  if (!value || typeof value !== "object" || !expectedRunId) return false;
  const result = value as Record<string, unknown>;
  return (
    (result.kind === "result" || result.kind === "error") &&
    result.runId === expectedRunId &&
    typeof result.command === "string" &&
    typeof result.participant === "string" &&
    typeof result.sessionId === "string" &&
    typeof result.value === "string" &&
    typeof result.sequence === "number" &&
    Number.isSafeInteger(result.sequence) &&
    result.sequence > 0
  );
}

function isCurrentFrameMessage(
  event: MessageEvent<unknown>,
  expectedRunId: string | null,
): boolean {
  if (!isBridgeResult(event.data, expectedRunId)) return false;
  for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe")) {
    const origin = new URL(frame.src, location.href).origin;
    const label = new URL(frame.src, location.href).searchParams.get("frame");
    if (
      event.origin === origin &&
      event.source === frame.contentWindow &&
      event.data.participant === `content:${label ?? "main"}`
    ) {
      return true;
    }
  }
  return false;
}
