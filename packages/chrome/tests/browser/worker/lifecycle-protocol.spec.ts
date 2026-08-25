import { expect, type Page } from "@playwright/test";
import { diagnosticCursor, test } from "../harness/playwright-fixtures";

test("CW-03 @worker-p0 loses old volatile State while durable worker storage survives", async ({
  controller,
  diagnostics,
  dispatchHostCommand,
  extensionId,
  hostPage,
  waitForBarrier,
  waitForDomValue,
  waitForResult,
}) => {
  const runId = "cw03-worker-state";
  let retainedCreated = false;
  let freshCreated = false;
  let cleanupStarted = false;
  const cleanupErrors: unknown[] = [];
  let primaryError: unknown;

  try {
    await hostPage.goto(`http://127.0.0.1:4173/host.html?runId=${runId}`);
    await waitForBarrier(runId, "background-ready");

    const retainedCursor = await dispatchHostCommand(
      hostPage,
      runId,
      "worker-state-retain",
    );
    const retained = result(
      await waitForResult(runId, hasKey("state"), { after: retainedCursor }),
    );
    retainedCreated = true;
    const oldStoreInstanceId = storeInstanceId(retained.status);

    const writeCursor = await dispatchHostCommand(
      hostPage,
      runId,
      "worker-state-write",
    );
    expect(
      result(
        await waitForResult(runId, hasKey("value"), { after: writeCursor }),
      ),
    ).toMatchObject({
      value: 1,
      status: { type: "ready" },
    });

    const storageWriteCursor = await dispatchHostCommand(
      hostPage,
      runId,
      "worker-storage-write",
    );
    expect(
      result(
        await waitForResult(runId, () => true, { after: storageWriteCursor }),
      ),
    ).toEqual({ durable: "worker-durable" });

    const oldSummaryCursor = await dispatchHostCommand(
      hostPage,
      runId,
      "background-summary",
    );
    const oldSummary = summary(
      result(
        await waitForResult(runId, hasKey("sessionId"), {
          after: oldSummaryCursor,
        }),
      ),
    );

    const previous = await controller.capture(extensionId);
    const pendingBefore = await bridgeStatus(hostPage);
    await dispatchHostCommand(hostPage, runId, "worker-pending");
    await waitForBarrier(runId, "pending-started");
    const preCloseCursor = diagnosticCursor(await diagnostics(runId));
    await controller.closeAfterPending(previous);

    const pending = await waitForHostResult(
      waitForDomValue,
      hostPage,
      pendingBefore,
    );
    expect(pending.command).toBe("worker-pending");
    expect(pendingTerminal(result(pending)).code).toBe("E_CONN_CLOSED");

    const oldStatusBefore = await bridgeStatus(hostPage);
    await dispatchHostCommand(hostPage, runId, "worker-state-status", {
      after: preCloseCursor,
    });
    expect(
      result(
        await waitForHostResult(waitForDomValue, hostPage, oldStatusBefore),
      ),
    ).toMatchObject({ type: "disconnected" });

    const freshBefore = await bridgeStatus(hostPage);
    await dispatchHostCommand(hostPage, runId, "worker-state-fresh", {
      after: preCloseCursor,
    });
    const fresh = result(
      await waitForHostResult(waitForDomValue, hostPage, freshBefore),
    );
    freshCreated = true;
    expect(fresh.state).toEqual({ count: 0 });
    expect(storeInstanceId(fresh.status)).not.toBe(oldStoreInstanceId);

    const freshSummaryBefore = await bridgeStatus(hostPage);
    await dispatchHostCommand(hostPage, runId, "background-summary");
    const freshSummary = summary(
      result(
        await waitForHostResult(waitForDomValue, hostPage, freshSummaryBefore),
      ),
    );
    expect(freshSummary.sessionId).not.toBe(oldSummary.sessionId);
    expect(freshSummary.nonce).not.toBe(oldSummary.nonce);

    const storageReadBefore = await bridgeStatus(hostPage);
    await dispatchHostCommand(hostPage, runId, "worker-storage-read");
    expect(
      result(
        await waitForHostResult(waitForDomValue, hostPage, storageReadBefore),
      ),
    ).toEqual({ durable: "worker-durable" });
  } catch (error) {
    primaryError = error;
  } finally {
    if ((retainedCreated || freshCreated) && !cleanupStarted) {
      cleanupStarted = true;
      try {
        const cleanupBefore = await bridgeStatus(hostPage);
        await dispatchHostCommand(hostPage, runId, "worker-state-cleanup");
        const cleanup = result(
          await waitForHostResult(waitForDomValue, hostPage, cleanupBefore),
        );
        expect(cleanup).toEqual({
          result: "worker-state-cleanup-result",
          retained: retainedCreated
            ? { status: { type: "destroyed" }, error: null }
            : { status: null, error: "E_STATE_CLIENT_ABSENT" },
          fresh: freshCreated
            ? { status: { type: "destroyed" }, error: null }
            : { status: null, error: "E_STATE_CLIENT_ABSENT" },
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new Error(`Worker State cleanup failed: ${String(cleanupErrors[0])}`);
  }
});

test("CW-05 reacquires and releases fresh worker resource and callback capabilities", async ({
  controller,
  diagnostics,
  dispatchHostCommand,
  extensionId,
  hostPage,
  waitForBarrier,
  waitForDomValue,
}) => {
  const runId = "cw05-worker-capability";
  await hostPage.goto(`http://127.0.0.1:4173/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");

  const retainedBefore = await bridgeStatus(hostPage);
  await dispatchHostCommand(hostPage, runId, "worker-capability-retain");
  const retained = result(
    await waitForHostResult(waitForDomValue, hostPage, retainedBefore),
  );
  expect(retained.callback).toBe("callback-ok");
  const oldCapability = capability(retained.capability);

  const previous = await controller.capture(extensionId);
  const pendingBefore = await bridgeStatus(hostPage);
  await dispatchHostCommand(hostPage, runId, "worker-pending");
  await waitForBarrier(runId, "pending-started");
  const preCloseCursor = diagnosticCursor(await diagnostics(runId));
  await controller.closeAfterPending(previous);

  const pending = await waitForHostResult(
    waitForDomValue,
    hostPage,
    pendingBefore,
  );
  expect(pending.command).toBe("worker-pending");
  expect(pendingTerminal(result(pending)).code).toBe("E_CONN_CLOSED");

  const oldBefore = await bridgeStatus(hostPage);
  await dispatchHostCommand(hostPage, runId, "worker-capability-invoke", {
    after: preCloseCursor,
  });
  expect(
    result(await waitForHostResult(waitForDomValue, hostPage, oldBefore)),
  ).toEqual({
    code: "E_CONN_CLOSED",
  });

  const freshBefore = await bridgeStatus(hostPage);
  await dispatchHostCommand(hostPage, runId, "worker-capability-fresh", {
    after: preCloseCursor,
  });
  const fresh = result(
    await waitForHostResult(waitForDomValue, hostPage, freshBefore),
  );
  expect(fresh.callback).toBe("callback-fresh");
  const freshCapability = capability(fresh.capability);
  const freshSummary = summary(fresh.summary);
  expect(freshCapability.resourceLabel).toBe(oldCapability.resourceLabel);
  expect(freshCapability.sessionId).not.toBe(oldCapability.sessionId);
  expect(freshCapability.nonce).not.toBe(oldCapability.nonce);
  expect(freshSummary.sessionId).not.toBe(oldCapability.sessionId);
  expect(freshSummary.nonce).not.toBe(oldCapability.nonce);

  const releaseBefore = await bridgeStatus(hostPage);
  await dispatchHostCommand(hostPage, runId, "worker-capability-fresh-release");
  expect(
    result(await waitForHostResult(waitForDomValue, hostPage, releaseBefore)),
  ).toEqual({ released: true });

  const terminalBefore = await bridgeStatus(hostPage);
  await dispatchHostCommand(hostPage, runId, "worker-capability-fresh-invoke");
  expect(
    result(await waitForHostResult(waitForDomValue, hostPage, terminalBefore)),
  ).toEqual({ code: "E_RESOURCE_ACCESS_DENIED" });
});

function result(event: { readonly value: string }): Record<string, unknown> {
  return JSON.parse(event.value) as Record<string, unknown>;
}

function storeInstanceId(status: unknown): string {
  expect(status).toMatchObject({
    type: "ready",
    storeInstanceId: expect.any(String),
  });
  return (status as { readonly storeInstanceId: string }).storeInstanceId;
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

function capability(value: unknown): {
  readonly resourceLabel: string;
  readonly sessionId: string;
  readonly nonce: string;
} {
  if (typeof value !== "string") {
    throw new Error("Capability identity is not a string");
  }
  const parts = value.split(":");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid capability identity: ${value}`);
  }
  const [resourceLabel, sessionId, nonce] = parts;
  return { resourceLabel, sessionId, nonce };
}

function pendingTerminal(value: unknown): {
  readonly callTimeoutMs: number;
  readonly code: string;
  readonly settled: number;
  readonly started: number;
} {
  if (!isRecord(value)) {
    throw new Error("Pending call metadata is not an object");
  }
  const { callTimeoutMs, code, settled, started } = value;
  if (
    code !== "E_CONN_CLOSED" ||
    typeof callTimeoutMs !== "number" ||
    typeof settled !== "number" ||
    typeof started !== "number"
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
