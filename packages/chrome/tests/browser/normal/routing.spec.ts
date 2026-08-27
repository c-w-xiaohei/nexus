import type { Frame, Page } from "@playwright/test";
import { parseBridgeResult } from "../protocol";
import { fixtureOrigins } from "../harness/targets";
import {
  diagnosticEventIdentity,
  expect,
  test,
  waitForHostBridgeResult,
} from "../harness/playwright-fixtures";

test("CE-07/09 keeps background selection passive until content actively creates its default route", async ({
  diagnostics,
  dispatchHostCommandAndResult,
  hostPage,
  waitForEvent,
}) => {
  const runId = "routing-passive-select";
  const navigationCursor = new Set(
    (await diagnostics(runId)).map(diagnosticEventIdentity),
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

  const selectCursor = new Set(
    (await diagnostics(runId)).map(diagnosticEventIdentity),
  );
  const alpha = frameByName(hostPage, "alpha");
  const resolvedPromise = commandAndResult({
    dispatch: dispatchToFrame,
    frame: alpha,
    hostPage,
    runId,
    command: "select-start",
    label: "alpha",
  });
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
        !selectCursor.has(diagnosticEventIdentity(event)) &&
        event.kind === "barrier" &&
        event.name === "content-connect",
    ),
  ).toEqual([]);
  const [resolved, connected] = await Promise.all([
    resolvedPromise,
    dispatchHostCommandAndResult(hostPage, runId, "content-connect"),
  ]);

  expect(identity(resolved)).toMatchObject({ label: "main" });
  expect(connected.value).toMatch(/^background:\d+:/);
});

test("CE-09 reports no-route selection before any content connection", async ({
  diagnostics,
  hostPage,
  waitForEvent,
}) => {
  const runId = "routing-no-route-terminal";
  const navigationCursor = new Set(
    (await diagnostics(runId)).map(diagnosticEventIdentity),
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
  const cursor = new Set(
    (await diagnostics(runId)).map(diagnosticEventIdentity),
  );
  const selectStartedWait = waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "select-started" &&
      event.participant === "background",
    { after: cursor },
  );
  const commandResult = commandAndResult({
    dispatch: dispatchToFrame,
    frame: alpha,
    hostPage,
    runId,
    command: "select-start",
    label: "alpha",
  });
  const [selectStartedEvents, result] = await Promise.all([
    selectStartedWait,
    commandResult,
  ]);
  const selectStarted = selectStartedEvents[0];
  const terminal = JSON.parse(result) as {
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
    (event) => !cursor.has(diagnosticEventIdentity(event)),
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

test("CE-07 provider-first selection resolves without a pending barrier", async ({
  diagnostics,
  hostPage,
  waitForEvent,
}) => {
  const runId = "routing-provider-first-fresh";
  const navigationCursor = new Set(
    (await diagnostics(runId)).map(diagnosticEventIdentity),
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
  const connectCursor = new Set(
    (await diagnostics(runId)).map(diagnosticEventIdentity),
  );
  const connect = waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "content-connect" &&
      event.participant === "content:alpha",
    { after: connectCursor },
  );
  const connected = commandAndResult({
    dispatch: dispatchToFrame,
    frame: alpha,
    hostPage,
    runId,
    command: "content-connect",
    label: "alpha",
  });
  await Promise.all([connect, connected]);
  const cursor = new Set(
    (await diagnostics(runId)).map(diagnosticEventIdentity),
  );
  const result = await commandAndResult({
    dispatch: dispatchToFrame,
    frame: alpha,
    hostPage,
    runId,
    command: "provider-first-select",
    label: "alpha",
    valueMatches: (value) => value.startsWith("{"),
  });
  expect(identity(result)).toMatchObject({ label: "alpha" });
  const postSelectEvents = (await diagnostics(runId)).filter(
    (event) => !cursor.has(diagnosticEventIdentity(event)),
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
  hostPage,
}) => {
  const runId = "routing-exact-targets";
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  const main = hostPage.mainFrame();
  const alpha = frameByName(hostPage, "alpha");

  const mainResult = await commandAndResult({
    dispatch: dispatchToFrame,
    frame: main,
    hostPage,
    runId,
    command: "create-frame",
    label: "main",
  });
  const alphaResult = await commandAndResult({
    dispatch: dispatchToFrame,
    frame: alpha,
    hostPage,
    runId,
    command: "create-frame",
    label: "alpha",
  });
  expect(identity(mainResult)).toMatchObject({ label: "main" });
  expect(identity(alphaResult)).toMatchObject({ label: "alpha" });
  expect(
    new Set([identity(mainResult).nonce, identity(alphaResult).nonce]).size,
  ).toBe(2);
});

test("CE-10 concurrent public creates share the beta identity", async ({
  hostPage,
}) => {
  const runId = "routing-concurrent";
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  const beta = frameByName(hostPage, "beta");
  const before = routeFacts(
    await commandAndResult({
      dispatch: dispatchToFrame,
      frame: beta,
      hostPage,
      runId,
      command: "document-route-facts",
      label: "beta",
    }),
  );
  const result = await commandAndResult({
    dispatch: dispatchToFrame,
    frame: beta,
    hostPage,
    runId,
    command: "create-concurrent",
    label: "beta",
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
}) => {
  const runId = "routing-document-reuse";
  const beforeNavigation = new Set(
    (await diagnostics(runId)).map(diagnosticEventIdentity),
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
      dispatch: dispatchToFrame,
      frame: beta,
      hostPage,
      runId,
      command: "document-route-facts",
      label: "beta",
    }),
  );
  const firstCursor = new Set(
    (await diagnostics(runId)).map(diagnosticEventIdentity),
  );
  const firstResult = commandAndResult({
    dispatch: dispatchToFrame,
    frame: beta,
    hostPage,
    runId,
    command: "create-document",
    label: "beta",
  });
  await waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "route-absent" &&
      event.participant === "background",
    { after: firstCursor },
  );
  const first = await firstResult;
  const secondCursor = new Set(
    (await diagnostics(runId)).map(diagnosticEventIdentity),
  );
  const secondResult = commandAndResult({
    dispatch: dispatchToFrame,
    frame: beta,
    hostPage,
    runId,
    command: "create-document",
    label: "beta",
  });
  await waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "route-absent" &&
      event.participant === "background",
    { after: secondCursor },
  );
  const second = await secondResult;
  const after = routeFacts(
    await commandAndResult({
      dispatch: dispatchToFrame,
      frame: beta,
      hostPage,
      runId,
      command: "document-route-facts",
      label: "beta",
    }),
  );

  expect(identity(first)).toMatchObject({ label: "beta" });
  expect(identity(second)).toEqual(identity(first));
  expect(identity(second)).toMatchObject({
    sessionId: after.sessionId,
    nonce: after.nonce,
  });
  expect(after.accepted - before.accepted).toBe(1);
});

test("CE-12 closes the pre-ready native port without a proxy or provider call", async ({
  diagnostics,
  hostPage,
  waitForEvent,
}) => {
  const runId = "routing-pre-ready-port-close";
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  const alpha = frameByName(hostPage, "alpha");
  const before = routeFacts(
    await commandAndResult({
      dispatch: dispatchToFrame,
      frame: alpha,
      hostPage,
      runId,
      command: "document-route-facts",
      label: "alpha",
    }),
  );
  const cursor = new Set(
    (await diagnostics(runId)).map(diagnosticEventIdentity),
  );

  const commandResult = commandAndResult({
    dispatch: dispatchToFrame,
    frame: alpha,
    hostPage,
    runId,
    command: "pre-ready-port-close",
    label: "alpha",
  });
  await waitForEvent(
    runId,
    (event) =>
      event.kind === "barrier" &&
      event.name === "pre-ready-port-open" &&
      event.participant === "content:alpha",
    { after: cursor },
  );
  const result = await commandResult;
  const after = routeFacts(
    await commandAndResult({
      dispatch: dispatchToFrame,
      frame: alpha,
      hostPage,
      runId,
      command: "document-route-facts",
      label: "alpha",
    }),
  );
  const terminal = JSON.parse(result) as { readonly code?: unknown };

  expect(terminal.code).toEqual(expect.any(String));
  expect(terminal.code).not.toBe("E_FIXTURE_UNEXPECTED_PROXY");
  expect(after.invocationCount).toBe(before.invocationCount);
});

const frameSequences = new WeakMap<Frame, number>();

async function dispatchToFrame(
  frame: Frame,
  runId: string,
  command: string,
): Promise<number> {
  // Host and frame commands can be deliberately concurrent in this suite.
  const sequence = (frameSequences.get(frame) ?? 1_000) + 1;
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
  return sequence;
}

async function commandAndResult({
  dispatch,
  frame,
  hostPage,
  runId,
  command,
  label,
  valueMatches,
}: {
  readonly dispatch: (
    frame: Frame,
    runId: string,
    command: string,
  ) => Promise<number>;
  readonly frame: Frame;
  readonly hostPage: Page;
  readonly runId: string;
  readonly command: string;
  readonly label: string;
  readonly valueMatches?: (value: string) => boolean;
}): Promise<string> {
  const sequence = await dispatch(frame, runId, command);
  const result = parseBridgeResult(
    await waitForHostBridgeResult(
      hostPage,
      {
        runId,
        command,
        sequence,
        participant: `content:${label}`,
      },
      { valueMatches },
    ),
    { runId, command, sequence },
  );
  if (!result || result.participant !== `content:${label}`)
    throw new Error("Missing correlated frame DOM result");
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
