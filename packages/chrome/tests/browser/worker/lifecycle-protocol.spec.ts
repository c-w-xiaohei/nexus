import { expect } from "@playwright/test";
import { test } from "../harness/playwright-fixtures";

test("CW-03 @worker-p0 loses old volatile State while durable worker storage survives", async ({
  controller,
  dispatchHostCommandAndResult,
  extensionId,
  hostPage,
  waitForBarrier,
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

    const retained = result(
      await dispatchHostCommandAndResult(
        hostPage,
        runId,
        "worker-state-retain",
      ),
    );
    retainedCreated = true;
    const oldStoreInstanceId = storeInstanceId(retained.status);

    expect(
      result(
        await dispatchHostCommandAndResult(
          hostPage,
          runId,
          "worker-state-write",
        ),
      ),
    ).toMatchObject({
      value: 1,
      status: { type: "ready" },
    });

    expect(
      result(
        await dispatchHostCommandAndResult(
          hostPage,
          runId,
          "worker-storage-write",
        ),
      ),
    ).toEqual({ durable: "worker-durable" });

    const oldSummary = summary(
      result(
        await dispatchHostCommandAndResult(
          hostPage,
          runId,
          "background-summary",
        ),
      ),
    );

    const previous = await controller.capture(extensionId);
    const pendingResult = dispatchHostCommandAndResult(
      hostPage,
      runId,
      "worker-pending",
    );
    await waitForBarrier(runId, "pending-started");
    await controller.closeAfterPending(previous);

    const pending = await pendingResult;
    expect(pendingTerminal(result(pending)).code).toBe("E_CONN_CLOSED");

    expect(
      result(
        await dispatchHostCommandAndResult(
          hostPage,
          runId,
          "worker-state-status",
        ),
      ),
    ).toMatchObject({ type: "disconnected" });

    const fresh = result(
      await dispatchHostCommandAndResult(hostPage, runId, "worker-state-fresh"),
    );
    freshCreated = true;
    expect(fresh.state).toEqual({ count: 0 });
    expect(storeInstanceId(fresh.status)).not.toBe(oldStoreInstanceId);

    const freshSummary = summary(
      result(
        await dispatchHostCommandAndResult(
          hostPage,
          runId,
          "background-summary",
        ),
      ),
    );
    expect(freshSummary.sessionId).not.toBe(oldSummary.sessionId);
    expect(freshSummary.nonce).not.toBe(oldSummary.nonce);

    expect(
      result(
        await dispatchHostCommandAndResult(
          hostPage,
          runId,
          "worker-storage-read",
        ),
      ),
    ).toEqual({ durable: "worker-durable" });
  } catch (error) {
    primaryError = error;
  } finally {
    if ((retainedCreated || freshCreated) && !cleanupStarted) {
      cleanupStarted = true;
      try {
        const cleanup = result(
          await dispatchHostCommandAndResult(
            hostPage,
            runId,
            "worker-state-cleanup",
          ),
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
  dispatchHostCommandAndResult,
  extensionId,
  hostPage,
  waitForBarrier,
}) => {
  const runId = "cw05-worker-capability";
  await hostPage.goto(`http://127.0.0.1:4173/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");

  const retained = result(
    await dispatchHostCommandAndResult(
      hostPage,
      runId,
      "worker-capability-retain",
    ),
  );
  expect(retained.callback).toBe("callback-ok");
  const oldCapability = capability(retained.capability);

  const previous = await controller.capture(extensionId);
  const pendingResult = dispatchHostCommandAndResult(
    hostPage,
    runId,
    "worker-pending",
  );
  await waitForBarrier(runId, "pending-started");
  await controller.closeAfterPending(previous);

  const pending = await pendingResult;
  expect(pendingTerminal(result(pending)).code).toBe("E_CONN_CLOSED");

  expect(
    result(
      await dispatchHostCommandAndResult(
        hostPage,
        runId,
        "worker-capability-invoke",
      ),
    ),
  ).toEqual({
    code: "E_CONN_CLOSED",
  });

  const fresh = result(
    await dispatchHostCommandAndResult(
      hostPage,
      runId,
      "worker-capability-fresh",
    ),
  );
  expect(fresh.callback).toBe("callback-fresh");
  const freshCapability = capability(fresh.capability);
  const freshSummary = summary(fresh.summary);
  expect(freshCapability.resourceLabel).toBe(oldCapability.resourceLabel);
  expect(freshCapability.sessionId).not.toBe(oldCapability.sessionId);
  expect(freshCapability.nonce).not.toBe(oldCapability.nonce);
  expect(freshSummary.sessionId).not.toBe(oldCapability.sessionId);
  expect(freshSummary.nonce).not.toBe(oldCapability.nonce);

  expect(
    result(
      await dispatchHostCommandAndResult(
        hostPage,
        runId,
        "worker-capability-fresh-release",
      ),
    ),
  ).toEqual({ released: true });

  expect(
    result(
      await dispatchHostCommandAndResult(
        hostPage,
        runId,
        "worker-capability-fresh-invoke",
      ),
    ),
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
