import { expect } from "@playwright/test";
import {
  diagnosticCursor,
  diagnosticEventIdentity,
  test,
  waitForHostBridgeResult,
} from "../harness/playwright-fixtures";
import { fixtureOrigins } from "../harness/targets";

test("connects to the exact alpha route and records one provider invocation", async ({
  hostPage,
  waitForBarrier,
}) => {
  const runId = "security-connect-route";
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");
  await expect(hostPage.frameLocator("#alpha").locator("html")).toHaveAttribute(
    "data-nexus-e2e-ready",
    /^alpha:/,
  );

  await dispatchFrameCommand(
    hostPage,
    "#alpha",
    runId,
    "document-route-facts",
    1,
  );
  const beforeFactsEvent = await commandEnvelope(
    hostPage,
    runId,
    "document-route-facts",
    1,
    "content:alpha",
  );
  const beforeFacts = documentFacts(beforeFactsEvent.value);

  await dispatchFrameCommand(hostPage, "#alpha", runId, "create-frame", 2);
  const created = await commandEnvelope(
    hostPage,
    runId,
    "create-frame",
    2,
    "content:alpha",
  );
  const createdValue = result(created.value);
  expect(createdValue).toMatchObject({
    identity: {
      label: "alpha",
      sessionId: beforeFacts.sessionId,
      nonce: beforeFacts.nonce,
    },
  });

  await dispatchFrameCommand(
    hostPage,
    "#alpha",
    runId,
    "document-route-facts",
    3,
  );
  const afterFactsEvent = await commandEnvelope(
    hostPage,
    runId,
    "document-route-facts",
    3,
    "content:alpha",
  );
  const afterFacts = documentFacts(afterFactsEvent.value);
  expect(afterFacts.sessionId).toBe(beforeFacts.sessionId);
  expect(afterFacts.nonce).toBe(beforeFacts.nonce);
  expect(afterFacts.invocationCount).toBe(beforeFacts.invocationCount + 1);
});

test("rejects content-initiated ports when declared and observed frames differ", async ({
  diagnostics,
  dispatchHostCommandAndResult,
  hostPage,
  waitForBarrier,
  waitForEvent,
}) => {
  const runId = "security-declared-frame-mismatch";
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");
  const alphaRoot = hostPage.frameLocator("#alpha").locator("html");
  await expect(alphaRoot).toHaveAttribute("data-nexus-e2e-ready", /^alpha:/);
  const initialReadyMarker = await alphaRoot.getAttribute(
    "data-nexus-e2e-ready",
  );

  await dispatchFrameCommand(
    hostPage,
    "#alpha",
    runId,
    "background-increment",
    1,
  );
  const counterBaseline = await commandEnvelope(
    hostPage,
    runId,
    "background-increment",
    1,
    "content:alpha",
  );
  expect(counterBaseline.value).toBe("1");

  const baselineCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchFrameCommand(hostPage, "#alpha", runId, "content-connect", 2);
  const baselineConnection = await commandEnvelope(
    hostPage,
    runId,
    "content-connect",
    2,
    "content:alpha",
  );
  expect(baselineConnection.value).toMatch(/^background:\d+:[a-zA-Z0-9-]{36}$/);
  const baselineInvocationEvents = await waitForEvent(
    runId,
    (event) =>
      event.participant === "background" &&
      workspaceInvocationCount(event) !== undefined,
    { after: baselineCursor },
  );
  expect(baselineInvocationEvents).toHaveLength(1);
  const baselineInvocationCount = workspaceInvocationCount(
    baselineInvocationEvents[0],
  );
  expect(baselineInvocationCount).toBe(1);

  const navigationCursor = diagnosticCursor(await diagnostics(runId));
  await hostPage.locator("#alpha").evaluate((element, currentRunId) => {
    const frame = element as HTMLIFrameElement;
    const url = new URL(frame.src, location.href);
    url.searchParams.set("runId", currentRunId);
    url.searchParams.set("declared-frame", "999999");
    frame.src = url.href;
  }, runId);
  const replacementReady = await waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.participant === "content:alpha" &&
      event.name === "provider-live",
    { after: navigationCursor },
  );
  expect(replacementReady).toHaveLength(1);
  await expect(alphaRoot).toHaveAttribute("data-nexus-e2e-ready", /^alpha:/);
  const replacementReadyMarker = await alphaRoot.getAttribute(
    "data-nexus-e2e-ready",
  );
  expect(initialReadyMarker).not.toBeNull();
  expect(replacementReadyMarker).not.toBe(initialReadyMarker);

  const rejectedCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchFrameCommand(hostPage, "#alpha", runId, "content-connect", 1);
  const rejected = await commandEnvelope(
    hostPage,
    runId,
    "content-connect",
    1,
    "content:alpha",
  );
  expect(rejected).toMatchObject({
    kind: "error",
    value: JSON.stringify({ code: "E_HANDSHAKE_REJECTED" }),
  });

  const rejectedInvocationEvents = (await diagnostics(runId)).filter(
    (event) =>
      !rejectedCursor.has(diagnosticEventIdentity(event)) &&
      event.participant === "background" &&
      workspaceInvocationCount(event) !== undefined,
  );
  expect(rejectedInvocationEvents).toHaveLength(0);

  const summary = await dispatchHostCommandAndResult(
    hostPage,
    runId,
    "background-summary",
  );
  expect(result(summary.value)).toMatchObject({ counter: 1 });
});

test("denies calls without incrementing, then permits one call after policy allows", async ({
  diagnostics,
  dispatchHostCommandAndResult,
  hostPage,
  waitForBarrier,
  waitForResult,
}) => {
  const runId = "security-call-policy";
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");

  await dispatchHostCommandAndResult(hostPage, runId, "policy-deny");

  const deniedCallCursor = diagnosticCursor(await diagnostics(runId));
  const deniedCall = dispatchHostCommandAndResult(
    hostPage,
    runId,
    "background-increment",
  );
  const providerDenied = await waitForResult(
    runId,
    (event) =>
      event.participant === "background" &&
      event.value.includes('"type":"policy-denied"'),
    { after: deniedCallCursor },
  );
  const denied = await deniedCall;
  expect(result(providerDenied.value)).toEqual({
    type: "policy-denied",
    code: "E_AUTH_CALL_DENIED",
    counter: 0,
  });
  expect(denied.kind).toBe("error");
  expect(result(denied.value)).toEqual({ code: "E_REMOTE_EXCEPTION" });

  await dispatchHostCommandAndResult(hostPage, runId, "policy-allow");

  const incremented = await dispatchHostCommandAndResult(
    hostPage,
    runId,
    "background-increment",
  );
  expect(incremented).toMatchObject({ kind: "result", value: "1" });

  const counter = await dispatchHostCommandAndResult(
    hostPage,
    runId,
    "security-counter",
  );
  expect(result(counter.value)).toMatchObject({ counter: 1 });
});

test("reports local acquisition abort separately from worker port loss", async ({
  controller,
  diagnostics,
  dispatchHostCommandAndResult,
  extensionId,
  hostPage,
  waitForBarrier,
}) => {
  const abortRunId = "security-local-abort";
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${abortRunId}`);
  await waitForBarrier(abortRunId, "background-ready");
  const aborted = await dispatchHostCommandAndResult(
    hostPage,
    abortRunId,
    "abort-acquire",
  );
  expect(result(aborted.value)).toEqual({ code: "E_ABORTED" });

  const lossRunId = "security-port-loss";
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${lossRunId}`);
  await waitForBarrier(lossRunId, "background-ready");
  const target = await controller.capture(extensionId);
  const lossCursor = diagnosticCursor(await diagnostics(lossRunId));
  const lossStartedAt = performance.now();
  const pendingResult = dispatchHostCommandAndResult(
    hostPage,
    lossRunId,
    "worker-pending",
  );
  await waitForBarrier(lossRunId, "worker-pending-call-started");
  expect(
    (await diagnostics(lossRunId)).some(
      (event) =>
        !lossCursor.has(diagnosticEventIdentity(event)) &&
        event.kind === "result" &&
        event.value.includes("E_CONN_CLOSED"),
    ),
  ).toBe(false);
  await controller.closeAfterPending(target);
  const closed = await pendingResult;
  expect(closed).toMatchObject({ kind: "result" });
  const pending = pendingTerminal(closed.value);
  expect(pending.code).toBe("E_CONN_CLOSED");
  expect(pending.callTimeoutMs).toBe(30_000);
  expect(pending.settled).toBeGreaterThanOrEqual(pending.started);
  expect(pending.settled - pending.started).toBeLessThan(
    pending.callTimeoutMs / 2,
  );
  const lossSettledAt = performance.now();
  expect(lossSettledAt - lossStartedAt).toBeLessThan(pending.callTimeoutMs / 2);
});

function result(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function documentFacts(value: string): {
  readonly invocationCount: number;
  readonly sessionId: string;
  readonly nonce: string;
} {
  const facts = result(value);
  expect(typeof facts.invocationCount).toBe("number");
  expect(typeof facts.sessionId).toBe("string");
  expect(typeof facts.nonce).toBe("string");
  return {
    invocationCount: facts.invocationCount as number,
    sessionId: facts.sessionId as string,
    nonce: facts.nonce as string,
  };
}

function pendingTerminal(value: string): {
  readonly code: string;
  readonly callTimeoutMs: number;
  readonly started: number;
  readonly settled: number;
} {
  const pending = result(value);
  if (
    typeof pending.code !== "string" ||
    typeof pending.callTimeoutMs !== "number" ||
    typeof pending.started !== "number" ||
    typeof pending.settled !== "number"
  ) {
    throw new Error(
      "worker-pending terminal result has an invalid timeout/timing shape",
    );
  }
  return {
    code: pending.code,
    callTimeoutMs: pending.callTimeoutMs,
    started: pending.started,
    settled: pending.settled,
  };
}

function workspaceInvocationCount(event: unknown): number | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = (event as { readonly value?: unknown }).value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed.type === "workspace-invocation" &&
      parsed.operation === "summary" &&
      typeof parsed.invocationCount === "number"
      ? parsed.invocationCount
      : undefined;
  } catch {
    return undefined;
  }
}

type CommandEnvelope = {
  readonly kind: "result" | "error";
  readonly runId: string;
  readonly command: string;
  readonly sequence: number;
  readonly participant: string;
  readonly sessionId: string;
  readonly value: string;
};

async function commandEnvelope(
  page: import("@playwright/test").Page,
  runId: string,
  command: string,
  sequence?: number,
  participant = "content:main",
): Promise<CommandEnvelope> {
  if (sequence === undefined) throw new Error("Missing command sequence");
  const envelope = (await waitForHostBridgeResult(page, {
    runId,
    command,
    sequence,
    participant,
  })) as CommandEnvelope;
  expect(envelope).toMatchObject({
    runId,
    command,
    participant,
  });
  if (sequence !== undefined) expect(envelope.sequence).toBe(sequence);
  expect(envelope.sessionId).toMatch(/^[a-zA-Z0-9-]{36}$/);
  return envelope;
}

async function dispatchFrameCommand(
  page: import("@playwright/test").Page,
  frameSelector: string,
  runId: string,
  command: string,
  sequence: number,
): Promise<void> {
  await page
    .frameLocator(frameSelector)
    .locator("html")
    .evaluate(
      (element, detail) => {
        element.ownerDocument.defaultView?.dispatchEvent(
          new CustomEvent("nexus-e2e-command", { detail }),
        );
      },
      { kind: "command", runId, command, sequence },
    );
}
