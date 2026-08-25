import { expect } from "@playwright/test";
import { diagnosticCursor, test } from "../harness/playwright-fixtures";

test("connects to the exact alpha route and records one provider invocation", async ({
  diagnostics,
  hostPage,
  waitForBarrier,
  waitForResult,
}) => {
  const runId = "security-connect-route";
  await hostPage.goto(`http://127.0.0.1:4173/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");
  await expect(hostPage.frameLocator("#alpha").locator("html")).toHaveAttribute(
    "data-nexus-e2e-ready",
    /^alpha:/,
  );

  const beforeFactsCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchFrameCommand(
    hostPage,
    "#alpha",
    runId,
    "document-route-facts",
    1,
  );
  const beforeFactsEvent = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:alpha" &&
      event.value.includes('"invocationCount"'),
    { after: beforeFactsCursor },
  );
  const beforeFacts = documentFacts(beforeFactsEvent.value);

  const createCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchFrameCommand(hostPage, "#alpha", runId, "create-frame", 2);
  const created = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:alpha" &&
      event.value.includes('"identity"'),
    { after: createCursor },
  );
  const createdValue = result(created.value);
  expect(createdValue).toMatchObject({
    identity: {
      label: "alpha",
      sessionId: beforeFacts.sessionId,
      nonce: beforeFacts.nonce,
    },
  });

  const afterFactsCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchFrameCommand(
    hostPage,
    "#alpha",
    runId,
    "document-route-facts",
    3,
  );
  const afterFactsEvent = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:alpha" &&
      event.value.includes('"invocationCount"'),
    { after: afterFactsCursor },
  );
  const afterFacts = documentFacts(afterFactsEvent.value);
  expect(afterFacts.sessionId).toBe(beforeFacts.sessionId);
  expect(afterFacts.nonce).toBe(beforeFacts.nonce);
  expect(afterFacts.invocationCount).toBe(beforeFacts.invocationCount + 1);
});

test("rejects content-initiated ports when declared and observed frames differ", async ({
  diagnostics,
  dispatchHostCommand,
  hostPage,
  waitForBarrier,
  waitForEvent,
  waitForDomValue,
  waitForResult,
}) => {
  const runId = "security-declared-frame-mismatch";
  await hostPage.goto(`http://127.0.0.1:4173/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");
  const alphaRoot = hostPage.frameLocator("#alpha").locator("html");
  await expect(alphaRoot).toHaveAttribute("data-nexus-e2e-ready", /^alpha:/);
  const initialReadyMarker = await alphaRoot.getAttribute(
    "data-nexus-e2e-ready",
  );

  const counterBaselineCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchFrameCommand(
    hostPage,
    "#alpha",
    runId,
    "background-increment",
    1,
  );
  const counterBaseline = await waitForResult(
    runId,
    (event) => event.participant === "content:alpha" && event.value === "1",
    { after: counterBaselineCursor },
  );
  expect(counterBaseline.value).toBe("1");

  const baselineCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchFrameCommand(hostPage, "#alpha", runId, "content-connect", 2);
  const baselineConnection = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:alpha" &&
      event.value.startsWith("background:"),
    { after: baselineCursor },
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
  const rejected = await waitForEvent(
    runId,
    (event) =>
      event.participant === "content:alpha" &&
      event.kind === "error" &&
      event.value === JSON.stringify({ code: "E_HANDSHAKE_REJECTED" }),
    { after: rejectedCursor },
  );
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toMatchObject({ kind: "error" });

  const rejectedInvocationEvents = (await diagnostics(runId)).filter(
    (event) =>
      !rejectedCursor.has(eventIdentity(event)) &&
      event.participant === "background" &&
      workspaceInvocationCount(event) !== undefined,
  );
  expect(rejectedInvocationEvents).toHaveLength(0);

  const summaryBefore = await domValue(hostPage);
  await dispatchHostCommand(hostPage, runId, "background-summary");
  const summary = await commandEnvelope(
    hostPage,
    waitForDomValue,
    summaryBefore,
    runId,
    "background-summary",
  );
  expect(result(summary.value)).toMatchObject({ counter: 1 });
});

test("ignores malformed, foreign-run, unknown, duplicate, and non-window bridge commands", async ({
  diagnostics,
  hostPage,
  waitForBarrier,
  waitForResult,
}) => {
  const runId = "security-bridge";
  await hostPage.goto(`http://127.0.0.1:4173/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");
  const before = diagnosticCursor(await diagnostics(runId));

  await hostPage.evaluate((currentRunId) => {
    const commands = [
      null,
      "forged-primitive",
      { runId: currentRunId, command: "security-counter", sequence: 1 },
      {
        kind: "command",
        runId: currentRunId,
        command: "security-counter",
        sequence: "1",
      },
      {
        kind: "command",
        runId: currentRunId,
        command: 42,
        sequence: 1,
      },
      {
        kind: "command",
        runId: "other-run",
        command: "security-counter",
        sequence: 1,
      },
      {
        kind: "result",
        runId: currentRunId,
        command: "security-counter",
        sequence: 1,
      },
      { kind: "command", runId: currentRunId, command: "unknown", sequence: 1 },
      {
        kind: "command",
        runId: currentRunId,
        command: "security-counter",
        sequence: 0,
      },
      {
        kind: "command",
        runId: currentRunId,
        command: "security-counter",
        sequence: 1,
      },
      {
        kind: "command",
        runId: currentRunId,
        command: "security-counter",
        sequence: 1,
      },
    ];
    for (const detail of commands) {
      window.dispatchEvent(new CustomEvent("nexus-e2e-command", { detail }));
    }
    document.dispatchEvent(
      new CustomEvent("nexus-e2e-command", {
        bubbles: true,
        detail: {
          kind: "command",
          runId: currentRunId,
          command: "security-counter",
          sequence: 2,
        },
      }),
    );
  }, runId);

  const observed = await waitForResult(
    runId,
    (event) => event.value.includes('"counter":0'),
    { after: before },
  );
  expect(result(observed.value)).toMatchObject({ counter: 0 });
  expect(
    (await diagnostics(runId)).filter(
      (event) =>
        event.kind === "result" &&
        event.participant === "content:main" &&
        !before.has(eventIdentity(event)),
    ),
  ).toHaveLength(1);
});

test("denies calls without incrementing, then permits one call after policy allows", async ({
  dispatchHostCommand,
  hostPage,
  waitForBarrier,
  waitForDomValue,
  waitForResult,
}) => {
  const runId = "security-call-policy";
  await hostPage.goto(`http://127.0.0.1:4173/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");

  const deniedBefore = await domValue(hostPage);
  await dispatchHostCommand(hostPage, runId, "policy-deny");
  const deniedPolicy = await commandEnvelope(
    hostPage,
    waitForDomValue,
    deniedBefore,
    runId,
    "policy-deny",
  );
  expect(result(deniedPolicy.value)).toMatchObject({
    counter: 0,
    denyCalls: true,
  });

  const deniedCallBefore = await domValue(hostPage);
  const deniedCallCursor = await dispatchHostCommand(
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
  expect(result(providerDenied.value)).toEqual({
    type: "policy-denied",
    code: "E_AUTH_CALL_DENIED",
    counter: 0,
  });
  const denied = await commandEnvelope(
    hostPage,
    waitForDomValue,
    deniedCallBefore,
    runId,
    "background-increment",
  );
  expect(denied.kind).toBe("error");
  expect(result(denied.value)).toEqual({ code: "E_REMOTE_EXCEPTION" });

  const allowedBefore = await domValue(hostPage);
  await dispatchHostCommand(hostPage, runId, "policy-allow");
  const allowedPolicy = await commandEnvelope(
    hostPage,
    waitForDomValue,
    allowedBefore,
    runId,
    "policy-allow",
  );
  expect(result(allowedPolicy.value)).toMatchObject({
    counter: 0,
    denyCalls: false,
  });

  const incrementBefore = await domValue(hostPage);
  await dispatchHostCommand(hostPage, runId, "background-increment");
  const incremented = await commandEnvelope(
    hostPage,
    waitForDomValue,
    incrementBefore,
    runId,
    "background-increment",
  );
  expect(incremented).toMatchObject({ kind: "result", value: "1" });

  const counterBefore = await domValue(hostPage);
  await dispatchHostCommand(hostPage, runId, "security-counter");
  const counter = await commandEnvelope(
    hostPage,
    waitForDomValue,
    counterBefore,
    runId,
    "security-counter",
  );
  expect(result(counter.value)).toMatchObject({ counter: 1 });
});

test("reports local acquisition abort separately from worker port loss", async ({
  controller,
  diagnostics,
  dispatchHostCommand,
  extensionId,
  hostPage,
  waitForBarrier,
  waitForDomValue,
  waitForResult,
}) => {
  const abortRunId = "security-local-abort";
  await hostPage.goto(`http://127.0.0.1:4173/host.html?runId=${abortRunId}`);
  await waitForBarrier(abortRunId, "background-ready");
  const abortCursor = await dispatchHostCommand(
    hostPage,
    abortRunId,
    "abort-acquire",
  );
  const aborted = await waitForResult(
    abortRunId,
    (event) => event.value.includes("E_ABORTED"),
    { after: abortCursor },
  );
  expect(result(aborted.value)).toEqual({ code: "E_ABORTED" });

  const lossRunId = "security-port-loss";
  await hostPage.goto(`http://127.0.0.1:4173/host.html?runId=${lossRunId}`);
  await waitForBarrier(lossRunId, "background-ready");
  const target = await controller.capture(extensionId);
  const lossBefore = await domValue(hostPage);
  const lossStartedAt = performance.now();
  const lossCursor = await dispatchHostCommand(
    hostPage,
    lossRunId,
    "worker-pending",
  );
  await waitForBarrier(lossRunId, "worker-pending-call-started");
  expect(
    (await diagnostics(lossRunId)).some(
      (event) =>
        !lossCursor.has(eventIdentity(event)) &&
        event.kind === "result" &&
        event.value.includes("E_CONN_CLOSED"),
    ),
  ).toBe(false);
  await controller.closeAfterPending(target);
  const closed = await commandEnvelope(
    hostPage,
    waitForDomValue,
    lossBefore,
    lossRunId,
    "worker-pending",
  );
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

function eventIdentity(event: {
  readonly runId: string;
  readonly participant: string;
  readonly sessionId?: string;
  readonly sequence: number;
  readonly kind: string;
}): string {
  return [
    event.runId,
    event.participant,
    event.sessionId ?? "none",
    event.sequence,
    event.kind,
  ].join(":");
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

async function domValue(
  page: import("@playwright/test").Page,
): Promise<string> {
  return page
    .locator("#bridge-status")
    .evaluate((element) => (element as HTMLDataElement).value);
}

async function commandEnvelope(
  page: import("@playwright/test").Page,
  waitForDomValue: (
    page: import("@playwright/test").Page,
    selector: string,
    before: string | null,
  ) => Promise<string>,
  before: string,
  runId: string,
  command: string,
): Promise<CommandEnvelope> {
  const envelope = JSON.parse(
    await waitForDomValue(page, "#bridge-status", before),
  ) as CommandEnvelope;
  expect(envelope).toMatchObject({
    runId,
    command,
    participant: "content:main",
  });
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
