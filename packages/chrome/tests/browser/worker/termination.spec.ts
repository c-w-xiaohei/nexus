import { expect } from "@playwright/test";
import { test } from "../harness/playwright-fixtures";

test("CW-01 @worker-gate @worker-p0 closes an old worker target and wakes a replacement", async ({
  controller,
  dispatchHostCommandAndResult,
  extensionId,
  hostPage,
  openExtensionPage,
  waitForBarrier,
  waitForResult,
}) => {
  const runId = "cw01-worker-close";
  await hostPage.goto(`http://127.0.0.1:4173/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");

  const previous = await controller.capture(extensionId);
  const previousSummary = summary(
    result(
      await dispatchHostCommandAndResult(hostPage, runId, "background-summary"),
    ),
  );
  const pending = dispatchHostCommandAndResult(
    hostPage,
    runId,
    "worker-pending",
  );
  await waitForBarrier(runId, "pending-started");
  await controller.closeAfterPending(previous);
  expect(result(await pending)).toMatchObject({ code: "E_CONN_CLOSED" });

  const fresh = summary(
    result(
      await dispatchHostCommandAndResult(hostPage, runId, "background-summary"),
    ),
  );
  const replacement = await controller.capture(extensionId);
  expect(replacement.url).toBe(previous.url);
  expect(fresh.sessionId).not.toBe(previousSummary.sessionId);
  expect(fresh.nonce).not.toBe(previousSummary.nonce);

  await openExtensionPage("popup", runId);
  const popupSummary = await waitForResult(
    runId,
    (event) => event.participant === "popup",
  );
  expect(summary(JSON.parse(popupSummary.value))).toEqual(fresh);
});

test("CW-02 @worker-p0 settles a pending worker call as closed before its larger timeout", async ({
  controller,
  dispatchHostCommandAndResult,
  extensionId,
  hostPage,
  waitForBarrier,
}) => {
  const runId = "cw02-worker-pending";
  await hostPage.goto(`http://127.0.0.1:4173/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");
  const previous = await controller.capture(extensionId);

  const pendingDispatchedAt = performance.now();
  const pendingResult = dispatchHostCommandAndResult(
    hostPage,
    runId,
    "worker-pending",
  );
  await waitForBarrier(runId, "pending-started");
  const closeStartedAt = performance.now();
  await controller.closeAfterPending(previous);

  const pending = await pendingResult;
  const pendingSettledAt = performance.now();
  const pendingMetadata = pendingTerminal(result(pending));
  expect(pendingMetadata.code).toBe("E_CONN_CLOSED");
  expect(pendingMetadata.callTimeoutMs).toBe(30_000);
  expect(pendingMetadata.settled).toBeGreaterThanOrEqual(
    pendingMetadata.started,
  );
  const producerElapsed = pendingMetadata.settled - pendingMetadata.started;
  const browserElapsed = pendingSettledAt - pendingDispatchedAt;
  expect(pendingSettledAt).toBeGreaterThanOrEqual(closeStartedAt);
  expect(pendingSettledAt).toBeGreaterThanOrEqual(pendingDispatchedAt);
  expect(producerElapsed).toBeLessThan(pendingMetadata.callTimeoutMs / 2);
  expect(browserElapsed).toBeLessThan(pendingMetadata.callTimeoutMs / 2);
});

function result(event: { readonly value: string }): Record<string, unknown> {
  return JSON.parse(event.value) as Record<string, unknown>;
}

function summary(value: unknown): {
  readonly nonce: string;
  readonly sessionId: string;
} {
  if (!isRecord(value)) throw new Error("Workspace summary is not an object");
  const { nonce, sessionId } = value;
  if (typeof nonce !== "string" || typeof sessionId !== "string") {
    throw new Error("Workspace summary lacks nonce/sessionId strings");
  }
  return { nonce, sessionId };
}

function pendingTerminal(value: unknown): {
  readonly code: string;
  readonly callTimeoutMs: number;
  readonly started: number;
  readonly settled: number;
} {
  if (!isRecord(value)) {
    throw new Error("Pending call metadata is not an object");
  }
  const { callTimeoutMs, code, settled, started } = value;
  if (
    code !== "E_CONN_CLOSED" ||
    typeof callTimeoutMs !== "number" ||
    typeof started !== "number" ||
    typeof settled !== "number"
  ) {
    throw new Error(
      "Pending call metadata lacks code/callTimeoutMs/started/settled",
    );
  }
  return { callTimeoutMs, code, settled, started };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
