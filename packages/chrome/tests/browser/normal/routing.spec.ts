import type { Frame, Page } from "@playwright/test";
import type { DiagnosticCursor } from "../harness/playwright-fixtures";
import { fixtureOrigins } from "../harness/targets";
import { expect, test } from "../harness/playwright-fixtures";

test("CE-07/09 keeps background selection passive until content actively creates its default route", async ({
  diagnostics,
  dispatchHostCommand,
  hostPage,
  waitForEvent,
  waitForResult,
}) => {
  const runId = "routing-passive-select";
  const navigationCursor = new Set(
    (await diagnostics(runId)).map(eventIdentity),
  );
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  const readyEvents = await waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "content-listener-ready without route" &&
      (event.participant === "content:main" ||
        event.participant === "content:alpha" ||
        event.participant === "content:beta"),
    { after: navigationCursor, count: 3 },
  );
  expect(new Set(readyEvents.map((event) => event.participant))).toEqual(
    new Set(["content:main", "content:alpha", "content:beta"]),
  );
  expect(
    (await diagnostics(runId)).filter(
      (event) => event.kind === "barrier" && event.name === "content-connect",
    ),
  ).toEqual([]);

  const selectCursor = new Set((await diagnostics(runId)).map(eventIdentity));
  await dispatchToFrame(frameByName(hostPage, "alpha"), runId, "select-start");
  await waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "select-started" &&
      event.participant === "background",
    { after: selectCursor },
  );
  expect(
    (await diagnostics(runId)).filter(
      (event) =>
        !selectCursor.has(eventIdentity(event)) &&
        event.kind === "barrier" &&
        event.name === "content-connect",
    ),
  ).toEqual([]);
  const connectCursor = await dispatchHostCommand(
    hostPage,
    runId,
    "content-connect",
  );
  const resolved = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:alpha" && hasIdentity(event.value, "main"),
    { after: selectCursor },
  );
  const connected = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:main" &&
      event.value.startsWith("background:"),
    { after: connectCursor },
  );

  expect(identity(resolved.value)).toMatchObject({ label: "main" });
  expect(connected.value).toMatch(/^background:\d+:/);
});

test("CE-09 reports no-route selection before any content connection", async ({
  diagnostics,
  hostPage,
  waitForEvent,
}) => {
  const runId = "routing-no-route-terminal";
  const navigationCursor = new Set(
    (await diagnostics(runId)).map(eventIdentity),
  );
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  const readyEvents = await waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "content-listener-ready without route" &&
      (event.participant === "content:main" ||
        event.participant === "content:alpha" ||
        event.participant === "content:beta"),
    { after: navigationCursor, count: 3 },
  );
  expect(new Set(readyEvents.map((event) => event.participant))).toEqual(
    new Set(["content:main", "content:alpha", "content:beta"]),
  );
  expect(
    (await diagnostics(runId)).filter(
      (event) => event.kind === "barrier" && event.name === "content-connect",
    ),
  ).toEqual([]);

  const alpha = frameByName(hostPage, "alpha");
  const cursor = new Set((await diagnostics(runId)).map(eventIdentity));
  const selectStartedWait = waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "select-started" &&
      event.participant === "background",
    { after: cursor },
  );
  const terminalResultWait = waitForEvent(
    runId,
    (event) =>
      event.kind === "result" &&
      event.participant === "content:alpha" &&
      isPassiveSelectTimeoutResult(event.value),
    { after: cursor },
  );
  const dispatch = dispatchToFrame(alpha, runId, "select-start");
  const [, selectStartedEvents, terminalResults] = await Promise.all([
    dispatch,
    selectStartedWait,
    terminalResultWait,
  ]);
  const selectStarted = selectStartedEvents[0];
  const result = terminalResults[0];
  if (!result || result.kind !== "result")
    throw new Error("Missing terminal result");
  const terminal = JSON.parse(result.value) as {
    readonly code: string;
    readonly waitTimeoutMs: number;
    readonly started: number;
    readonly settled: number;
  };
  expect(terminal).toMatchObject({
    code: "E_SERVICE_WAIT_TIMEOUT",
    waitTimeoutMs: 1000,
    started: expect.any(Number),
    settled: expect.any(Number),
  });
  expect(terminal.settled).toBeGreaterThanOrEqual(terminal.started);
  const postCommandEvents = (await diagnostics(runId)).filter(
    (event) => !cursor.has(eventIdentity(event)),
  );
  const pending = postCommandEvents.find(
    (event) =>
      event.kind === "barrier" &&
      event.name === "select-pending-no-route" &&
      event.participant === "background",
  );
  expect(pending).toBeDefined();
  expect(selectStarted?.sequence).toBeLessThan(pending?.sequence ?? Infinity);
  expect(
    postCommandEvents.filter(
      (event) => event.kind === "barrier" && event.name === "content-connect",
    ),
  ).toEqual([]);
});

function isPassiveSelectTimeoutResult(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return (
      parsed.code === "E_SERVICE_WAIT_TIMEOUT" &&
      parsed.waitTimeoutMs === 1000 &&
      typeof parsed.started === "number" &&
      typeof parsed.settled === "number" &&
      parsed.settled >= parsed.started
    );
  } catch {
    return false;
  }
}

test("CE-07 provider-first selection resolves without a pending barrier", async ({
  diagnostics,
  hostPage,
  waitForEvent,
  waitForResult,
}) => {
  const runId = "routing-provider-first-fresh";
  const navigationCursor = new Set(
    (await diagnostics(runId)).map(eventIdentity),
  );
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  const readyEvents = await waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "content-listener-ready without route" &&
      (event.participant === "content:main" ||
        event.participant === "content:alpha" ||
        event.participant === "content:beta"),
    { after: navigationCursor, count: 3 },
  );
  expect(new Set(readyEvents.map((event) => event.participant))).toEqual(
    new Set(["content:main", "content:alpha", "content:beta"]),
  );
  const alpha = frameByName(hostPage, "alpha");
  const connectCursor = new Set((await diagnostics(runId)).map(eventIdentity));
  const connectResult = waitForResult(
    runId,
    (event) =>
      event.participant === "content:alpha" &&
      event.value.startsWith("background:"),
    { after: connectCursor },
  );
  const connect = waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "content-connect" &&
      event.participant === "content:alpha",
    { after: connectCursor },
  );
  await dispatchToFrame(alpha, runId, "content-connect");
  await Promise.all([connect, connectResult]);
  const cursor = new Set((await diagnostics(runId)).map(eventIdentity));
  await dispatchToFrame(alpha, runId, "provider-first-select");

  const result = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:alpha" &&
      hasIdentity(event.value, "alpha"),
    { after: cursor },
  );
  expect(identity(result.value)).toMatchObject({ label: "alpha" });
  const postSelectEvents = (await diagnostics(runId)).filter(
    (event) => !cursor.has(eventIdentity(event)),
  );
  expect(
    postSelectEvents.filter(
      (event) =>
        event.kind === "barrier" &&
        event.name === "select-pending-no-route" &&
        event.participant === "background",
    ),
  ).toEqual([]);
});

test("CE-08 routes exact main and alpha frame creates to their invoking documents", async ({
  diagnostics,
  hostPage,
  waitForResult,
}) => {
  const runId = "routing-exact-targets";
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  const commands = commandDispatcher();
  const main = hostPage.mainFrame();
  const alpha = frameByName(hostPage, "alpha");

  const mainResult = await commandAndResult({
    commands,
    diagnostics,
    frame: main,
    runId,
    command: "create-frame",
    label: "main",
    waitForResult,
  });
  const alphaResult = await commandAndResult({
    commands,
    diagnostics,
    frame: alpha,
    runId,
    command: "create-frame",
    label: "alpha",
    waitForResult,
  });
  expect(identity(mainResult)).toMatchObject({ label: "main" });
  expect(identity(alphaResult)).toMatchObject({ label: "alpha" });
  expect(
    new Set([identity(mainResult).nonce, identity(alphaResult).nonce]).size,
  ).toBe(2);
});

test("CE-10 concurrent public creates share the beta identity", async ({
  diagnostics,
  hostPage,
  waitForResult,
}) => {
  const runId = "routing-concurrent";
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  const beta = frameByName(hostPage, "beta");
  const before = routeFacts(
    await commandAndResult({
      commands: commandDispatcher(),
      diagnostics,
      frame: beta,
      runId,
      command: "document-route-facts",
      label: "beta",
      waitForResult,
    }),
  );
  const result = await commandAndResult({
    commands: commandDispatcher(),
    diagnostics,
    frame: beta,
    runId,
    command: "create-concurrent",
    label: "beta",
    waitForResult,
  });
  const value = JSON.parse(result) as {
    readonly first: DocumentIdentity;
    readonly second: DocumentIdentity;
    readonly acceptedRoute: RouteFacts;
  };

  expect(value.first).toMatchObject({ label: "beta" });
  expect(value.second).toEqual(value.first);
  expect(value.acceptedRoute).toMatchObject({
    sessionId: value.first.sessionId,
    nonce: value.first.nonce,
  });
  expect(value.acceptedRoute.accepted - before.accepted).toBe(1);
});

test("CE-11 exact document creates reuse the beta identity", async ({
  diagnostics,
  hostPage,
  waitForEvent,
  waitForResult,
}) => {
  const runId = "routing-document-reuse";
  const beforeNavigation = new Set(
    (await diagnostics(runId)).map(eventIdentity),
  );
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  const beta = frameByName(hostPage, "beta");
  await waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "navigation-committed" &&
      event.participant === "background",
    { after: beforeNavigation },
  );
  await waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "content-listener-ready without route" &&
      event.participant === "content:beta",
    { after: beforeNavigation },
  );

  const before = routeFacts(
    await commandAndResult({
      commands: commandDispatcher(),
      diagnostics,
      frame: beta,
      runId,
      command: "document-route-facts",
      label: "beta",
      waitForResult,
    }),
  );
  const firstCursor = new Set((await diagnostics(runId)).map(eventIdentity));
  await dispatchToFrame(beta, runId, "create-document");
  await waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "route-absent" &&
      event.participant === "background",
    { after: firstCursor },
  );
  const first = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:beta" && event.value.startsWith("{"),
    { after: firstCursor },
  );
  const secondCursor = new Set((await diagnostics(runId)).map(eventIdentity));
  await dispatchToFrame(beta, runId, "create-document");
  await waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "route-absent" &&
      event.participant === "background",
    { after: secondCursor },
  );
  const second = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:beta" && event.value.startsWith("{"),
    { after: secondCursor },
  );
  const after = routeFacts(
    await commandAndResult({
      commands: commandDispatcher(),
      diagnostics,
      frame: beta,
      runId,
      command: "document-route-facts",
      label: "beta",
      waitForResult,
    }),
  );

  expect(identity(first.value)).toMatchObject({ label: "beta" });
  expect(identity(second.value)).toEqual(identity(first.value));
  expect(identity(second.value)).toMatchObject({
    sessionId: after.sessionId,
    nonce: after.nonce,
  });
  expect(after.accepted - before.accepted).toBe(1);
});

test("CE-12 closes the pre-ready native port without a proxy or provider call", async ({
  diagnostics,
  hostPage,
  waitForEvent,
  waitForResult,
}) => {
  const runId = "routing-pre-ready-port-close";
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  const alpha = frameByName(hostPage, "alpha");
  const before = routeFacts(
    await commandAndResult({
      commands: commandDispatcher(),
      diagnostics,
      frame: alpha,
      runId,
      command: "document-route-facts",
      label: "alpha",
      waitForResult,
    }),
  );
  const cursor = new Set((await diagnostics(runId)).map(eventIdentity));

  await dispatchToFrame(alpha, runId, "pre-ready-port-close");
  await waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "pre-ready-port-open" &&
      event.participant === "content:alpha",
    { after: cursor },
  );
  const result = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:alpha" && event.value.startsWith("{"),
    { after: cursor },
  );
  const after = routeFacts(
    await commandAndResult({
      commands: commandDispatcher(),
      diagnostics,
      frame: alpha,
      runId,
      command: "document-route-facts",
      label: "alpha",
      waitForResult,
    }),
  );
  const terminal = JSON.parse(result.value) as { readonly code?: unknown };

  expect(terminal.code).toEqual(expect.any(String));
  expect(terminal.code).not.toBe("E_FIXTURE_UNEXPECTED_PROXY");
  expect(after.invocationCount).toBe(before.invocationCount);
});

const frameSequences = new WeakMap<Frame, number>();

async function dispatchToFrame(
  frame: Frame,
  runId: string,
  command: string,
): Promise<void> {
  const sequence = (frameSequences.get(frame) ?? 0) + 1;
  frameSequences.set(frame, sequence);
  await frame.evaluate(
    ({ command, runId, sequence }) =>
      window.dispatchEvent(
        new CustomEvent("nexus-e2e-command", {
          detail: { kind: "command", runId, command, sequence },
        }),
      ),
    { command, runId, sequence },
  );
}

function commandDispatcher(): (
  frame: Frame,
  runId: string,
  command: string,
) => Promise<void> {
  return dispatchToFrame;
}

async function commandAndResult({
  commands,
  diagnostics,
  frame,
  runId,
  command,
  label,
  waitForResult,
}: {
  readonly commands: (
    frame: Frame,
    runId: string,
    command: string,
  ) => Promise<void>;
  readonly diagnostics: (
    runId: string,
  ) => Promise<readonly Parameters<typeof eventIdentity>[0][]>;
  readonly frame: Frame;
  readonly runId: string;
  readonly command: string;
  readonly label: string;
  readonly waitForResult: (
    runId: string,
    predicate: (event: {
      readonly participant: string;
      readonly value: string;
    }) => boolean,
    options: { readonly after: DiagnosticCursor },
  ) => Promise<{ readonly value: string }>;
}): Promise<string> {
  const cursor = new Set((await diagnostics(runId)).map(eventIdentity));
  await commands(frame, runId, command);
  const result = await waitForResult(
    runId,
    (event) =>
      event.participant === `content:${label}` && event.value.startsWith("{"),
    { after: cursor },
  );
  return result.value;
}

function frameByName(page: Page, name: string): Frame {
  const frame = page
    .frames()
    .find((candidate) => candidate.url().includes(`frame=${name}`));
  if (!frame) throw new Error(`Fixture frame ${name} was not found`);
  return frame;
}

type DocumentIdentity = {
  readonly label: string;
  readonly nonce: string;
  readonly sessionId: string;
};

type RouteFacts = {
  readonly accepted: number;
  readonly invocationCount: number;
  readonly sessionId: string;
  readonly nonce: string;
};

function identity(value: string): DocumentIdentity {
  return (
    JSON.parse(value) as {
      readonly identity: DocumentIdentity;
    }
  ).identity;
}

function routeFacts(value: string): RouteFacts {
  return JSON.parse(value) as RouteFacts;
}

function hasIdentity(value: string, label: string): boolean {
  try {
    return identity(value).label === label;
  } catch {
    return false;
  }
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
