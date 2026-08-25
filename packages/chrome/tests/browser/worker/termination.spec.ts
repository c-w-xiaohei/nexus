import { expect, type Page } from "@playwright/test";
import { diagnosticCursor, test } from "../harness/playwright-fixtures";

test("CW-01 @worker-p0 closes an old worker proxy before wake and fresh acquire", async ({
  controller,
  diagnostics,
  dispatchHostCommand,
  extensionId,
  hostPage,
  waitForBarrier,
  waitForDomValue,
  waitForResult,
}) => {
  const runId = "cw01-worker-close";
  await hostPage.goto(`http://127.0.0.1:4173/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");

  const retainedCursor = await dispatchHostCommand(
    hostPage,
    runId,
    "worker-proxy-retain",
  );
  const retained = result(
    await waitForResult(runId, hasKey("retained"), { after: retainedCursor }),
  );
  const oldSummary = summary(retained.retained);
  const previous = await controller.capture(extensionId);

  const pendingBefore = await bridgeStatus(hostPage);
  const pendingDispatchedAt = performance.now();
  await dispatchHostCommand(hostPage, runId, "worker-pending");
  await waitForBarrier(runId, "pending-started");
  const preCloseCursor = diagnosticCursor(await diagnostics(runId));
  const closeStartedAt = performance.now();
  await controller.closeAfterPending(previous);

  const pending = await waitForHostResult(
    waitForDomValue,
    hostPage,
    pendingBefore,
  );
  const pendingSettledAt = performance.now();
  expect(pending.command).toBe("worker-pending");
  const pendingOutcome = pendingTerminal(result(pending));
  expect(pendingOutcome.code).toBe("E_CONN_CLOSED");

  const oldBefore = await bridgeStatus(hostPage);
  await dispatchHostCommand(hostPage, runId, "worker-proxy-invoke", {
    after: preCloseCursor,
  });
  const old = await waitForHostResult(waitForDomValue, hostPage, oldBefore);
  expect(old.command).toBe("worker-proxy-invoke");
  expect(result(old)).toEqual({ code: "E_CONN_CLOSED" });

  const freshBefore = await bridgeStatus(hostPage);
  await dispatchHostCommand(hostPage, runId, "worker-proxy-fresh", {
    after: preCloseCursor,
  });
  const fresh = result(
    await waitForHostResult(waitForDomValue, hostPage, freshBefore),
  );
  const freshSummary = summary(fresh.fresh);
  expect(freshSummary.sessionId).not.toBe(oldSummary.sessionId);
  expect(freshSummary.nonce).not.toBe(oldSummary.nonce);

  expect(pendingSettledAt).toBeGreaterThanOrEqual(closeStartedAt);
  expect(pendingSettledAt).toBeGreaterThanOrEqual(pendingDispatchedAt);
  expect(pendingSettledAt - closeStartedAt).toBeLessThan(15_000);
});

test("CW-02 @worker-p0 settles a pending worker call as closed before its larger timeout", async ({
  controller,
  dispatchHostCommand,
  extensionId,
  hostPage,
  waitForBarrier,
  waitForDomValue,
}) => {
  const runId = "cw02-worker-pending";
  await hostPage.goto(`http://127.0.0.1:4173/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");
  const previous = await controller.capture(extensionId);

  const pendingBefore = await bridgeStatus(hostPage);
  const pendingDispatchedAt = performance.now();
  await dispatchHostCommand(hostPage, runId, "worker-pending");
  await waitForBarrier(runId, "pending-started");
  const closeStartedAt = performance.now();
  await controller.closeAfterPending(previous);

  const pending = await waitForHostResult(
    waitForDomValue,
    hostPage,
    pendingBefore,
  );
  const pendingSettledAt = performance.now();
  expect(pending.command).toBe("worker-pending");
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

function hasKey(key: string): (event: { readonly value: string }) => boolean {
  return (event) => key in result(event);
}

async function bridgeStatus(hostPage: Page): Promise<string> {
  return hostPage
    .locator("#bridge-status")
    .evaluate((element) => (element as HTMLDataElement).value);
}

async function waitForHostResult(
  waitForDomValue: (
    page: Page,
    selector: string,
    before: string | null,
  ) => Promise<string>,
  hostPage: Page,
  before: string,
): Promise<{ readonly command: string; readonly value: string }> {
  const value = await waitForDomValue(hostPage, "#bridge-status", before);
  return JSON.parse(value) as {
    readonly command: string;
    readonly value: string;
  };
}
