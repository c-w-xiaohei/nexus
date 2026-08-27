import type { Frame, Page } from "@playwright/test";
import {
  diagnosticCursor,
  diagnosticEventIdentity,
  expect,
  test,
  type DiagnosticCursor,
  type DispatchCursor,
  waitForHostBridgeResult,
} from "../harness/playwright-fixtures";
import { fixtureOrigins } from "../harness/targets";
import { parseBridgeResult, type DiagnosticEvent } from "../protocol";

test("RL-CT-01 keeps local Workspace and Relay providers distinct", async ({
  dispatchHostCommand,
  hostPage,
  openExtensionPage,
  waitForEvent,
}) => {
  const runId = "relay-local-coexistence";
  await openContent(hostPage, runId, waitForEvent);
  const popup = await openExtensionPage("popup", runId);

  try {
    const before = await documentFacts(hostPage, runId, dispatchHostCommand);
    const local = await clickUiCommand(
      popup,
      runId,
      "relay-local-call",
      "popup",
    );
    const afterLocal = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
    );
    expect(local.result).toBe("relay-local-result");
    expect(local.identity?.sessionId).toEqual(expect.any(String));
    expect(afterLocal.invocationCount).toBe(before.invocationCount);

    const relay = await clickUiCommand(popup, runId, "relay-call", "popup");
    const afterRelay = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
    );
    expect(relay.result).toBe("relay-call-result");
    expect(relay.identity).toEqual({
      label: "main",
      sessionId: afterRelay.sessionId,
      nonce: afterRelay.nonce,
    });
    expect(local.identity?.sessionId).not.toBe(afterRelay.sessionId);
    expect(afterRelay.invocationCount).toBe(before.invocationCount + 1);
  } finally {
    await cleanupUiAndContent(
      popup,
      hostPage,
      runId,
      "popup",
      dispatchHostCommand,
    );
  }
});

test("RL-CT-03 records Relay identity and preserves policy denial side effects", async ({
  diagnostics,
  dispatchHostCommand,
  hostPage,
  openExtensionPage,
  waitForEvent,
}) => {
  const runId = "relay-policy-identity";
  await openContent(hostPage, runId, waitForEvent);
  const popup = await openExtensionPage("popup", runId);
  const workspace = await openExtensionPage("workspace", runId, {
    stateClient: "1",
  });

  try {
    const popupSessionId = await sessionId(popup, "popup");
    const workspaceSessionId = await sessionId(workspace, "workspace");
    await clickUiCommand(popup, runId, "relay-policy-mode", "popup", {
      mode: "allow",
    });
    const mainBefore = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
    );

    const allowedCursor = diagnosticCursor(await diagnostics(runId));
    const allowed = await clickUiCommand(popup, runId, "relay-call", "popup");
    const [allowedObservation] = await policyObservations(
      runId,
      allowedCursor,
      diagnostics,
    );
    const afterAllowed = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
    );
    expect(allowed.result).toBe("relay-call-result");
    expect(allowed.identity).toMatchObject({
      label: "main",
      sessionId: afterAllowed.sessionId,
      nonce: afterAllowed.nonce,
    });
    expect(afterAllowed.invocationCount).toBe(mainBefore.invocationCount + 1);
    const backgroundSessionId = requiredString(
      allowedObservation.relaySessionId,
      "allow policy observation relaySessionId",
    );
    expect(allowedObservation).toEqual({
      type: "relay-policy-observation",
      decision: "allow",
      originContext: "popup",
      originSessionId: popupSessionId,
      relayContext: "background",
      relaySessionId: backgroundSessionId,
      connectionTabId: expect.any(Number),
      connectionFrameId: 0,
      connectionDocumentId: expect.stringMatching(/.+/),
      tokenId: "nexus-e2e:document-relay",
      operation: "APPLY",
      path: ["identity"],
    });

    await clickUiCommand(workspace, runId, "relay-policy-mode", "workspace", {
      mode: "deny",
    });
    const deniedBefore = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
    );
    const deniedCursor = diagnosticCursor(await diagnostics(runId));
    const deniedCall = await clickUiCommand(
      workspace,
      runId,
      "relay-call",
      "workspace",
    );
    const [deniedObservation] = await policyObservations(
      runId,
      deniedCursor,
      diagnostics,
    );
    const deniedAfter = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
    );
    expect(deniedCall.kind).toBe("error");
    expect(deniedCall.error?.code).toBe("E_REMOTE_EXCEPTION");
    expect(deniedCall.error?.message).toEqual(expect.any(String));
    expect(deniedObservation).toEqual({
      type: "relay-policy-observation",
      decision: "deny",
      originContext: "workspace",
      originSessionId: workspaceSessionId,
      relayContext: "background",
      relaySessionId: backgroundSessionId,
      connectionTabId: expect.any(Number),
      connectionFrameId: 0,
      connectionDocumentId: expect.stringMatching(/.+/),
      tokenId: "nexus-e2e:document-relay",
      operation: "APPLY",
      path: ["identity"],
      code: "E_RELAY_POLICY_DENIED",
    });
    expect(deniedAfter.invocationCount).toBe(deniedBefore.invocationCount);
    expect(deniedCall.error?.code).not.toBe("E_AUTH_CALL_DENIED");

    await clickUiCommand(workspace, runId, "relay-policy-mode", "workspace", {
      mode: "allow",
    });
    expect(mainBefore.sessionId).toEqual(deniedAfter.sessionId);
  } finally {
    await cleanupUi(workspace, runId, "workspace");
    await workspace.close();
    await cleanupUi(popup, runId, "popup");
    await popup.close();
    await cleanupContent(hostPage, runId, dispatchHostCommand);
  }
});

test("RL-CT-04 registers the exact main document and does not retarget its retained Relay handle across navigation", async ({
  diagnostics,
  dispatchHostCommand,
  hostPage,
  openExtensionPage,
  waitForEvent,
}) => {
  const runId = "relay-navigation-replacement";
  await openContent(hostPage, runId, waitForEvent);
  const popup = await openExtensionPage("popup", runId);

  try {
    const oldFacts = await documentFacts(hostPage, runId, dispatchHostCommand);
    const alphaBefore = await frameFacts(
      frameByName(hostPage, "alpha"),
      runId,
      "content:alpha",
      hostPage,
    );
    await clickUiCommand(popup, runId, "relay-register", "popup");
    const retainedCall = await clickUiCommand(
      popup,
      runId,
      "relay-call",
      "popup",
    );
    const afterRetainedCall = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
    );
    const alphaAfterRetainedCall = await frameFacts(
      frameByName(hostPage, "alpha"),
      runId,
      "content:alpha",
      hostPage,
    );
    expect(retainedCall.identity).toEqual({
      label: "main",
      sessionId: oldFacts.sessionId,
      nonce: oldFacts.nonce,
    });
    expect(afterRetainedCall.invocationCount).toBe(
      oldFacts.invocationCount + 1,
    );
    expect(alphaAfterRetainedCall.invocationCount).toBe(
      alphaBefore.invocationCount,
    );
    const navigationCursor = diagnosticCursor(await diagnostics(runId));
    await hostPage.goto(
      `${fixtureOrigins.main}/host.html?runId=${runId}&revision=fresh`,
    );
    await waitForEvent(
      runId,
      (event) =>
        event.kind === "barrier" &&
        event.name === "navigation-committed" &&
        event.participant === "background",
      { after: navigationCursor },
    );
    await waitForEvent(
      runId,
      (event) =>
        event.kind === "barrier" &&
        event.name === "content-listener-ready without route" &&
        event.participant === "content:main",
      { after: navigationCursor },
    );
    const freshFacts = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
    );
    expect(freshFacts.sessionId).not.toBe(oldFacts.sessionId);
    expect(freshFacts.nonce).not.toBe(oldFacts.nonce);

    const oldCall = await clickUiCommand(
      popup,
      runId,
      "relay-old-call",
      "popup",
      { timeoutMs: 7_000 },
    );
    const afterOldCall = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
    );
    expect(oldCall.kind).toBe("error");
    expect(afterOldCall.invocationCount).toBe(freshFacts.invocationCount);
    expect(oldCall.error?.code).toBe("E_REMOTE_EXCEPTION");
    expect(oldCall.error?.message).toEqual(expect.any(String));
    expect(oldCall.identity).toBeNull();

    await clickUiCommand(popup, runId, "relay-refresh", "popup");

    const freshCall = await clickUiCommand(
      popup,
      runId,
      "relay-fresh-call",
      "popup",
    );
    const afterFreshCall = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
    );
    expect(freshCall.identity).toEqual({
      label: "main",
      sessionId: freshFacts.sessionId,
      nonce: freshFacts.nonce,
    });
    expect(afterFreshCall.invocationCount).toBe(freshFacts.invocationCount + 1);
  } finally {
    await cleanupUiAndContent(
      popup,
      hostPage,
      runId,
      "popup",
      dispatchHostCommand,
    );
  }
});

test("RL-CT-05 keeps the workspace Relay proxy after popup teardown", async ({
  dispatchHostCommand,
  hostPage,
  openExtensionPage,
  waitForEvent,
}) => {
  const runId = "relay-downstream-isolation";
  await openContent(hostPage, runId, waitForEvent);
  const popup = await openExtensionPage("popup", runId);
  const workspace = await openExtensionPage("workspace", runId, {
    stateClient: "1",
  });

  try {
    const before = await documentFacts(hostPage, runId, dispatchHostCommand);
    const first = await clickUiCommand(
      workspace,
      runId,
      "relay-call",
      "workspace",
    );
    const afterFirst = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
    );
    expect(first.identity).toEqual({
      label: "main",
      sessionId: afterFirst.sessionId,
      nonce: afterFirst.nonce,
    });
    expect(afterFirst.invocationCount).toBe(before.invocationCount + 1);

    await cleanupUi(popup, runId, "popup");
    await popup.close();

    const second = await clickUiCommand(
      workspace,
      runId,
      "relay-call",
      "workspace",
    );
    const afterSecond = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
    );
    expect(second.identity).toEqual(first.identity);
    expect(afterSecond.invocationCount).toBe(afterFirst.invocationCount + 1);
  } finally {
    if (!popup.isClosed()) {
      await cleanupUi(popup, runId, "popup");
      await popup.close();
    }
    await cleanupUiAndContent(
      workspace,
      hostPage,
      runId,
      "workspace",
      dispatchHostCommand,
    );
  }
});

async function openContent(
  hostPage: Page,
  runId: string,
  waitForEvent: (
    runId: string,
    predicate: (event: DiagnosticEvent) => boolean,
    options?: { readonly after?: DiagnosticCursor; readonly count?: number },
  ) => Promise<readonly DiagnosticEvent[]>,
): Promise<void> {
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);
  await waitForEvent(runId, (event) => barrier(event, "background-ready"));
  await waitForEvent(
    runId,
    (event) =>
      barrier(event, "content-listener-ready without route") &&
      (event.participant === "content:main" ||
        event.participant === "content:alpha" ||
        event.participant === "content:beta"),
    { count: 3 },
  );
}

async function clickUiCommand(
  page: Page,
  runId: string,
  command: string,
  participant: "popup" | "workspace",
  options: {
    readonly mode?: "allow" | "deny";
    readonly timeoutMs?: number;
  } = {},
): Promise<UiResult> {
  const selector =
    command === "relay-policy-mode"
      ? `[data-command="${command}"][data-mode="${options.mode}"]`
      : `[data-command="${command}"]`;
  const output = page.locator("[data-result]");
  const before = await output.evaluate((element) =>
    element instanceof HTMLOutputElement ? element.value : "",
  );
  await page.locator(selector).click();
  let value = "";
  await expect
    .poll(
      async () => {
        value = await output.evaluate((element) =>
          element instanceof HTMLOutputElement ? element.value : "",
        );
        return value !== before;
      },
      { timeout: options.timeoutMs },
    )
    .toBe(true);
  const envelope = parseBridgeResult(JSON.parse(value), {
    runId,
    command,
    sequence: Number(await output.getAttribute("data-sequence")),
  });
  if (!envelope || envelope.participant !== participant)
    throw new Error(`Missing ${command} result`);
  return parseUiResult(envelope.value, envelope.kind);
}

async function cleanupUiAndContent(
  page: Page,
  hostPage: Page,
  runId: string,
  participant: "popup" | "workspace",
  dispatchHostCommand: DispatchHostCommand,
): Promise<void> {
  if (!page.isClosed()) {
    await cleanupUi(page, runId, participant);
    await page.close();
  }
  await cleanupContent(hostPage, runId, dispatchHostCommand);
}

async function cleanupContent(
  hostPage: Page,
  runId: string,
  dispatchHostCommand: DispatchHostCommand,
): Promise<void> {
  const cursor = await dispatchHostCommand(
    hostPage,
    runId,
    "state-client-cleanup",
  );
  const expected = {
    runId,
    command: "state-client-cleanup",
    sequence: cursor.commandSequence,
    participant: "content:main",
  };
  const envelope = parseBridgeResult(
    await waitForHostBridgeResult(hostPage, expected),
    expected,
  );
  expect(envelope?.participant).toBe("content:main");
  expect(parsed(envelope?.value ?? "")?.result).toBe(
    "state-client-cleanup-result",
  );
}

async function cleanupUi(
  page: Page,
  runId: string,
  participant: "popup" | "workspace",
): Promise<void> {
  const output = page.locator("[data-result]");
  const before = await output.evaluate((element) =>
    element instanceof HTMLOutputElement ? element.value : "",
  );
  const cleanup = page.locator('[data-command="state-client-cleanup"]');
  if ((await cleanup.count()) !== 1)
    throw new Error("Missing real page command control: state-client-cleanup");
  await cleanup.click();
  await expect
    .poll(async () =>
      output.evaluate((element) =>
        element instanceof HTMLOutputElement ? element.value : "",
      ),
    )
    .not.toBe(before);
  const envelope = parseBridgeResult(
    JSON.parse(
      await output.evaluate((element) =>
        element instanceof HTMLOutputElement ? element.value : "",
      ),
    ),
    {
      runId,
      command: "state-client-cleanup",
      sequence: Number(await output.getAttribute("data-sequence")),
    },
  );
  expect(envelope?.participant).toBe(participant);
  expect(parsed(envelope?.value ?? "")?.result).toBe(
    "state-client-cleanup-result",
  );
}

async function documentFacts(
  hostPage: Page,
  runId: string,
  dispatchHostCommand: DispatchHostCommand,
): Promise<DocumentFacts> {
  return commandFacts(hostPage, runId, "content:main", async () => {
    return dispatchHostCommand(hostPage, runId, "document-route-facts");
  });
}

async function frameFacts(
  frame: Frame,
  runId: string,
  participant: string,
  hostPage: Page,
): Promise<DocumentFacts> {
  return commandFacts(hostPage, runId, participant, async () => {
    return dispatchFrameCommand(frame, runId);
  });
}

async function commandFacts(
  hostPage: Page,
  runId: string,
  participant: string,
  dispatch: () => Promise<{ readonly commandSequence: number }>,
): Promise<DocumentFacts> {
  const cursor = await dispatch();
  const expected = {
    runId,
    command: "document-route-facts",
    sequence: cursor.commandSequence,
    participant,
  };
  const envelope = parseBridgeResult(
    await waitForHostBridgeResult(hostPage, expected),
    expected,
  );
  if (!envelope || envelope.participant !== participant)
    throw new Error(`Missing document facts for ${participant}`);
  return parseFacts(envelope.value);
}

async function dispatchFrameCommand(
  frame: Frame,
  runId: string,
): Promise<{ readonly commandSequence: number }> {
  const sequence = (frameSequences.get(frame) ?? 0) + 1;
  frameSequences.set(frame, sequence);
  await frame.evaluate(
    ({ runId, sequence }) =>
      window.dispatchEvent(
        new CustomEvent("nexus-e2e-command", {
          detail: {
            kind: "command",
            runId,
            command: "document-route-facts",
            sequence,
          },
        }),
      ),
    { runId, sequence },
  );
  return { commandSequence: sequence };
}

async function policyObservations(
  runId: string,
  after: DiagnosticCursor,
  diagnostics: (runId: string) => Promise<readonly DiagnosticEvent[]>,
): Promise<readonly [PolicyObservation]> {
  const observations = (await diagnostics(runId)).flatMap((event) => {
    if (event.kind !== "result" && event.kind !== "error") return [];
    const value = parsed(event.value);
    return !after.has(diagnosticEventIdentity(event)) &&
      event.participant === "background" &&
      value?.type === "relay-policy-observation"
      ? [value as PolicyObservation]
      : [];
  });
  expect(observations).toHaveLength(1);
  return observations as [PolicyObservation];
}

function frameByName(page: Page, name: string): Frame {
  const frame = page
    .frames()
    .find((candidate) => candidate.url().includes(`frame=${name}`));
  if (!frame) throw new Error(`Fixture frame ${name} was not found`);
  return frame;
}

async function sessionId(
  page: Page,
  participant: "popup" | "workspace",
): Promise<string> {
  const status = `${participant}:ready:`;
  const value = await page.locator("[data-status]").textContent();
  if (!value) throw new Error(`Missing ${participant} ready status`);
  const result = value.replace(status, "");
  if (!/^[a-zA-Z0-9-]{36}$/.test(result))
    throw new Error(`Invalid ${participant} session: ${value}`);
  return result;
}

function parseUiResult(value: string, kind: "result" | "error"): UiResult {
  const outer =
    parsed(value) ?? (kind === "error" ? { code: value } : undefined);
  if (!outer) throw new Error(`Invalid UI result: ${value}`);
  return {
    kind,
    result: typeof outer.result === "string" ? outer.result : undefined,
    identity: outer.identity === null ? null : record(outer.identity),
    error: record(outer.error) ?? outer,
  };
}

function parseFacts(value: string): DocumentFacts {
  const facts = parsed(value);
  if (
    !facts ||
    typeof facts.invocationCount !== "number" ||
    typeof facts.sessionId !== "string" ||
    typeof facts.nonce !== "string"
  )
    throw new Error(`Invalid document facts: ${value}`);
  return facts as unknown as DocumentFacts;
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Invalid ${description}`);
  return value;
}

function parsed(value: string): Record<string, any> | undefined {
  try {
    const result: unknown = JSON.parse(value);
    return result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, any>)
      : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function barrier(event: DiagnosticEvent, name: string): boolean {
  return event.kind === "barrier" && event.name === name;
}

type DocumentFacts = {
  readonly invocationCount: number;
  readonly sessionId: string;
  readonly nonce: string;
};

type PolicyObservation = Record<string, any> & {
  readonly originContext: string;
  readonly originSessionId: string;
};

type UiResult = {
  readonly kind: "result" | "error";
  readonly result?: string;
  readonly identity?: Record<string, unknown> | null;
  readonly error?: Record<string, unknown>;
};

type DispatchHostCommand = (
  page: Page,
  runId: string,
  command: string,
  options?: { readonly after?: DiagnosticCursor },
) => Promise<DispatchCursor>;

const frameSequences = new WeakMap<Frame, number>();
