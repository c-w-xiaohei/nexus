const runId = new URLSearchParams(location.search).get("runId");
const bridgeStatus = document.querySelector<HTMLDataElement>("#bridge-status");
let sequence = 0;
let lastResultSequence = 0;

for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe")) {
  const url = new URL(frame.src);
  if (runId) url.searchParams.set("runId", runId);
  frame.src = url.href;
}

document.addEventListener("click", (event) => {
  const command = (event.target as HTMLElement | null)?.dataset.command;
  if (!command || !runId) return;
  window.dispatchEvent(
    new CustomEvent("nexus-e2e-command", {
      detail: { kind: "command", runId, command, sequence: ++sequence },
    }),
  );
  if (bridgeStatus) bridgeStatus.value = `sent:${command}`;
});

window.addEventListener("nexus-e2e-result", (event) => {
  if (
    !(event instanceof CustomEvent) ||
    event.target !== window ||
    !bridgeStatus ||
    !isBridgeResult(event.detail, runId) ||
    event.detail.sequence <= lastResultSequence
  )
    return;
  lastResultSequence = event.detail.sequence;
  bridgeStatus.value = JSON.stringify(event.detail);
  bridgeStatus.dataset.sequence = String(event.detail.sequence);
});

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
