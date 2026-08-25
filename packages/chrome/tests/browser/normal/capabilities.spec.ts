import type { Frame, Page } from "@playwright/test";
import {
  diagnosticCursor,
  expect,
  test,
  type DiagnosticCursor,
} from "../harness/playwright-fixtures";
import { fixtureOrigins } from "../harness/targets";
import type { DiagnosticEvent } from "../protocol";

test("CE-13 closes retained alpha capabilities on navigation while beta remains available", async ({
  diagnostics,
  hostPage,
  waitForBarrier,
  waitForResult,
}) => {
  const runId = "ce13-navigation";
  await openFixture(hostPage, runId, waitForBarrier);
  const alpha = frameByName(hostPage, "alpha");
  const beta = frameByName(hostPage, "beta");

  const retained = await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "capability-retain",
    participant: "content:alpha",
    waitForResult,
  });
  const retainedAlphaIdentity = nestedIdentity(retained);
  expect(retainedAlphaIdentity).toMatchObject({ label: "alpha" });
  await waitForBarrier(runId, "alpha-reference-created");

  await dispatchToFrame(alpha, runId, "content-hold");
  await waitForBarrier(runId, "hold-call-started");
  await waitForBarrier(runId, "pending-started");
  await alpha.goto(
    `${fixtureOrigins.main}/child.html?frame=alpha&runId=${runId}`,
  );
  await waitForBarrier(runId, "navigation-committed");
  await waitForBarrier(runId, "provider-live", 4);
  await waitForBarrier(runId, "hold-terminal-error");

  const proxyCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchToFrame(beta, runId, "capability-proxy-invoke");
  const proxyResult = (
    await waitForResult(
      runId,
      (event) =>
        event.participant === "content:beta" &&
        parsed(event.value)?.code === "E_CONN_CLOSED",
      { after: proxyCursor },
    )
  ).value;
  expect(parsed(proxyResult)).toEqual({ code: "E_CONN_CLOSED" });

  const referenceCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchToFrame(beta, runId, "capability-reference-invoke");
  const referenceResult = (
    await waitForResult(
      runId,
      (event) =>
        event.participant === "content:beta" &&
        parsed(event.value)?.code === "E_CONN_CLOSED",
      { after: referenceCursor },
    )
  ).value;
  expect(parsed(referenceResult)).toEqual({ code: "E_CONN_CLOSED" });

  const betaIdentity = await commandAndResult({
    diagnostics,
    frame: beta,
    runId,
    command: "content-identity",
    participant: "content:beta",
    waitForResult,
  });
  expect(parsed(betaIdentity)).toMatchObject({ label: "beta" });
  const freshAlpha = await commandAndResult({
    diagnostics,
    frame: frameByName(hostPage, "alpha"),
    runId,
    command: "content-identity",
    participant: "content:alpha",
    waitForResult,
  });
  const freshAlphaIdentity = identity(freshAlpha);
  expect(freshAlphaIdentity).toMatchObject({ label: "alpha" });
  expect(freshAlphaIdentity.sessionId).not.toBe(
    retainedAlphaIdentity.sessionId,
  );
});

test("CE-14 observes 0/1/2 selection and rebinds after a multicast member leaves", async ({
  diagnostics,
  hostPage,
  waitForBarrier,
  waitForResult,
}) => {
  const runId = "ce14-multicast";
  await openFixture(hostPage, runId, waitForBarrier);
  const alpha = frameByName(hostPage, "alpha");
  const beta = frameByName(hostPage, "beta");

  const zero = await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "provider-cardinality",
    participant: "content:alpha",
    waitForResult,
  });
  expect(parsed(zero)).toEqual({ code: "E_SERVICE_NO_MATCH" });

  await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "capability-retain",
    participant: "content:alpha",
    waitForResult,
  });
  const one = await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "provider-cardinality",
    participant: "content:alpha",
    waitForResult,
  });
  expect(parsed(one)?.count).toBe(1);
  await waitForBarrier(runId, "selection-one-ready");

  await commandAndResult({
    diagnostics,
    frame: beta,
    runId,
    command: "capability-retain",
    participant: "content:beta",
    waitForResult,
  });
  const originalBeta = nestedIdentity(
    await commandAndResult({
      diagnostics,
      frame: beta,
      runId,
      command: "capability-invoke",
      participant: "content:beta",
      waitForResult,
    }),
  );
  expect(originalBeta).toMatchObject({ label: "beta" });
  const two = await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "provider-cardinality",
    participant: "content:alpha",
    waitForResult,
  });
  expect(parsed(two)?.count).toBe(2);
  await waitForBarrier(runId, "selection-two-ready");

  const bound = await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "multicast-select",
    participant: "content:alpha",
    waitForResult,
  });
  expect(parsed(bound)?.identities).toHaveLength(2);
  await waitForBarrier(runId, "multicast-snapshot-bound");

  await beta.goto(
    `${fixtureOrigins.child}/child.html?frame=beta&runId=${runId}`,
  );
  await waitForBarrier(runId, "beta-left-snapshot");
  const closed = await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "multicast-bound-invoke",
    participant: "content:alpha",
    waitForResult,
  });
  expect(parsed(closed)).toEqual({ code: "E_CONN_CLOSED" });

  await waitForBarrier(runId, "provider-live", 4);
  const rebound = await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "multicast-rebind",
    participant: "content:alpha",
    waitForResult,
  });
  const reboundIdentities = fulfilledIdentities(rebound);
  expect(reboundIdentities).toHaveLength(2);
  expect(reboundIdentities.map((identity) => identity.label).sort()).toEqual([
    "alpha",
    "beta",
  ]);
  const replacementBeta = reboundIdentities.find(
    (identity) => identity.label === "beta",
  );
  expect(replacementBeta).toBeDefined();
  expect(replacementBeta?.sessionId).not.toBe(originalBeta.sessionId);
});

test("CE-15 distinguishes remote multicast rejection from unavailable all-target acquisition", async ({
  diagnostics,
  hostPage,
  waitForBarrier,
  waitForResult,
}) => {
  const runId = "ce15-create-multicast";
  await openFixture(hostPage, runId, waitForBarrier);
  const alpha = frameByName(hostPage, "alpha");
  const beta = frameByName(hostPage, "beta");
  for (const [frame, participant] of [
    [alpha, "content:alpha"],
    [beta, "content:beta"],
  ] as const) {
    await commandAndResult({
      diagnostics,
      frame,
      runId,
      command: "capability-retain",
      participant,
      waitForResult,
    });
  }

  const acquired = await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "multicast-create",
    participant: "content:alpha",
    waitForResult,
  });
  expect(
    fulfilledIdentities(acquired)
      .map((identity) => identity.label)
      .sort(),
  ).toEqual(["alpha", "beta"]);
  await waitForBarrier(runId, "multicast-all-acquired");

  const rejected = await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "multicast-fail",
    participant: "content:alpha",
    waitForResult,
  });
  expect(JSON.stringify(parsed(rejected)?.results)).toContain(
    "fixture remote failure",
  );
  await waitForBarrier(runId, "multicast-remote-rejection-ready");

  const unavailable = await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "multicast-unavailable",
    participant: "content:alpha",
    waitForResult,
  });
  expect(parsed(unavailable)).toEqual({ code: "E_HANDSHAKE_FAILED" });
  await waitForBarrier(runId, "multicast-unavailable-ready");
});

test("CE-16 invokes callbacks and makes released references terminal", async ({
  diagnostics,
  hostPage,
  waitForBarrier,
  waitForResult,
}) => {
  const runId = "ce16-resources";
  await openFixture(hostPage, runId, waitForBarrier);
  const alpha = frameByName(hostPage, "alpha");

  const callback = await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "reference-callback",
    participant: "content:alpha",
    waitForResult,
  });
  expect(parsed(callback)).toEqual({ callback: "callback-ok" });
  await waitForBarrier(runId, "callback-invoked");

  const retained = await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "capability-retain",
    participant: "content:alpha",
    waitForResult,
  });
  expect(parsed(retained)?.reference).toMatch(/^alpha:/);
  await waitForBarrier(runId, "alpha-reference-created");

  const released = await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "capability-release",
    participant: "content:alpha",
    waitForResult,
  });
  expect(parsed(released)).toEqual({ code: "E_RESOURCE_ACCESS_DENIED" });
  await waitForBarrier(runId, "reference-released");
  await waitForBarrier(runId, "reference-terminal-error");
});

test("CE-19 keeps raw alpha proxy pinned while fresh selection finds beta", async ({
  diagnostics,
  hostPage,
  waitForBarrier,
  waitForResult,
}) => {
  const runId = "ce19-identity";
  await openFixture(hostPage, runId, waitForBarrier);
  const alpha = frameByName(hostPage, "alpha");
  const beta = frameByName(hostPage, "beta");

  const retained = await commandAndResult({
    diagnostics,
    frame: alpha,
    runId,
    command: "capability-retain",
    participant: "content:alpha",
    waitForResult,
  });
  expect(parsed(retained)).toMatchObject({ identity: { label: "alpha" } });

  await dispatchToFrame(alpha, runId, "identity-update");
  await waitForBarrier(runId, "identity update");

  const pinned = await commandAndResult({
    diagnostics,
    frame: beta,
    runId,
    command: "identity-pinned",
    participant: "content:beta",
    waitForResult,
  });
  expect(parsed(pinned)).toMatchObject({ identity: { label: "alpha" } });

  const selected = await commandAndResult({
    diagnostics,
    frame: beta,
    runId,
    command: "identity-select-beta",
    participant: "content:beta",
    waitForResult,
  });
  expect(parsed(selected)).toMatchObject({ identity: { label: "beta" } });
  await waitForBarrier(runId, "beta-selected-fresh");

  const constrained = await commandAndResult({
    diagnostics,
    frame: beta,
    runId,
    command: "identity-constraint",
    participant: "content:beta",
    waitForResult,
  });
  expect(parsed(constrained)).toEqual({ code: "E_TARGET_CONSTRAINT_FAILED" });
  await waitForBarrier(runId, "alpha-constraint-failed");
});

const frameSequences = new WeakMap<Frame, number>();

async function openFixture(
  hostPage: Page,
  runId: string,
  waitForBarrier: (
    runId: string,
    name: string,
    occurrence?: number,
  ) => Promise<void>,
): Promise<void> {
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");
  await waitForBarrier(runId, "provider-live", 3);
}

async function commandAndResult({
  diagnostics,
  frame,
  runId,
  command,
  participant,
  waitForResult,
}: {
  readonly diagnostics: (runId: string) => Promise<readonly DiagnosticEvent[]>;
  readonly frame: Frame;
  readonly runId: string;
  readonly command: string;
  readonly participant: string;
  readonly waitForResult: (
    runId: string,
    predicate: (event: {
      readonly participant: string;
      readonly value: string;
    }) => boolean,
    options?: { readonly after?: DiagnosticCursor },
  ) => Promise<{ readonly value: string }>;
}): Promise<string> {
  const cursor = diagnosticCursor(await diagnostics(runId));
  await dispatchToFrame(frame, runId, command);
  return (
    await waitForResult(
      runId,
      (event) =>
        event.participant === participant && event.value.startsWith("{"),
      { after: cursor },
    )
  ).value;
}

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

function frameByName(page: Page, name: string): Frame {
  const frame = page
    .frames()
    .find((candidate) => candidate.url().includes(`frame=${name}`));
  if (!frame) throw new Error(`Fixture frame ${name} was not found`);
  return frame;
}

interface FixtureIdentity {
  readonly label: string;
  readonly nonce: string;
  readonly sessionId: string;
}

interface FulfilledIdentityResult {
  readonly status: "fulfilled";
  readonly value: FixtureIdentity;
}

function fulfilledIdentities(value: string): readonly FixtureIdentity[] {
  const results = parsed(value)?.identities;
  if (!Array.isArray(results)) {
    throw new Error(
      `Fixture command did not return settled identities: ${value}`,
    );
  }
  return results.map((result) => {
    if (!isFulfilledIdentityResult(result)) {
      throw new Error(
        `Fixture all-target acquisition did not fulfill every identity: ${value}`,
      );
    }
    return result.value;
  });
}

function isFulfilledIdentityResult(
  value: unknown,
): value is FulfilledIdentityResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return result.status === "fulfilled" && isFixtureIdentity(result.value);
}

function identity(value: string): FixtureIdentity {
  const result = parsed(value);
  if (!isFixtureIdentity(result)) {
    throw new Error(`Fixture command did not return an identity: ${value}`);
  }
  return result;
}

function nestedIdentity(value: string): FixtureIdentity {
  const result = parsed(value)?.identity;
  if (!isFixtureIdentity(result)) {
    throw new Error(
      `Fixture command did not return a nested identity: ${value}`,
    );
  }
  return result;
}

function isFixtureIdentity(value: unknown): value is FixtureIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.label === "string" &&
    typeof identity.nonce === "string" &&
    typeof identity.sessionId === "string"
  );
}

function parsed(value: string): Record<string, unknown> | undefined {
  try {
    const result: unknown = JSON.parse(value);
    return result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
