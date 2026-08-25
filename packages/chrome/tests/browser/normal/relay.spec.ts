import type { Frame, Page } from "@playwright/test";
import {
  diagnosticCursor,
  expect,
  test,
  type DiagnosticCursor,
} from "../harness/playwright-fixtures";
import { fixtureOrigins } from "../harness/targets";
import type { DiagnosticEvent } from "../protocol";

test("RL-CT-01 keeps local Workspace and Relay providers distinct", async ({
  diagnostics,
  dispatchHostCommand,
  hostPage,
  openExtensionPage,
  waitForEvent,
  waitForResult,
}) => {
  const runId = "relay-local-coexistence";
  await openContent(hostPage, runId, waitForEvent);
  const popup = await openExtensionPage("popup", runId);

  try {
    const before = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    const local = await clickUiCommand(
      popup,
      runId,
      "relay-local-call",
      "popup",
      diagnostics,
    );
    const afterLocal = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    expect(local.result).toBe("relay-local-result");
    expect(local.identity?.sessionId).toEqual(expect.any(String));
    expect(afterLocal.invocationCount).toBe(before.invocationCount);

    const relay = await clickUiCommand(
      popup,
      runId,
      "relay-call",
      "popup",
      diagnostics,
    );
    const afterRelay = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    expect(relay.result).toBe("relay-call-result");
    expect(relay.identity).toEqual({
      label: "main",
      sessionId: afterRelay.sessionId,
      nonce: afterRelay.nonce,
    });
    expect(afterRelay.invocationCount).toBe(before.invocationCount + 1);
  } finally {
    await cleanupUiAndContent(
      popup,
      hostPage,
      runId,
      "popup",
      dispatchHostCommand,
      diagnostics,
      waitForResult,
    );
  }
});

test("RL-CT-02 registers and invokes the exact current main document", async ({
  diagnostics,
  dispatchHostCommand,
  hostPage,
  openExtensionPage,
  waitForEvent,
  waitForResult,
}) => {
  const runId = "relay-exact-main";
  await openContent(hostPage, runId, waitForEvent);
  const popup = await openExtensionPage("popup", runId);

  try {
    const mainBefore = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    const mainTarget = await registryMainFact(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    const siblingBefore = await frameFacts(
      frameByName(hostPage, "alpha"),
      runId,
      "content:alpha",
      diagnostics,
      waitForResult,
    );
    const registration = await clickUiCommand(
      popup,
      runId,
      "relay-register",
      "popup",
      diagnostics,
    );
    expect(registration.result).toBe("relay-register-result");
    expect(registration.target).toEqual(targetIdentity(mainTarget));

    const relay = await clickUiCommand(
      popup,
      runId,
      "relay-call",
      "popup",
      diagnostics,
    );
    const mainAfter = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    const siblingAfter = await frameFacts(
      frameByName(hostPage, "alpha"),
      runId,
      "content:alpha",
      diagnostics,
      waitForResult,
    );
    expect(relay.identity).toEqual({
      label: "main",
      sessionId: mainBefore.sessionId,
      nonce: mainBefore.nonce,
    });
    expect(mainAfter.invocationCount).toBe(mainBefore.invocationCount + 1);
    expect(siblingAfter.invocationCount).toBe(siblingBefore.invocationCount);
  } finally {
    await cleanupUiAndContent(
      popup,
      hostPage,
      runId,
      "popup",
      dispatchHostCommand,
      diagnostics,
      waitForResult,
    );
  }
});

test("RL-CT-03 records Relay identity and preserves policy denial side effects", async ({
  diagnostics,
  dispatchHostCommand,
  hostPage,
  openExtensionPage,
  waitForEvent,
  waitForResult,
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
    const allowMode = await clickUiCommand(
      popup,
      runId,
      "relay-policy-mode",
      "popup",
      diagnostics,
      undefined,
      "allow",
    );
    const backgroundSessionId = requiredString(
      allowMode.controlResult?.backgroundSessionId,
      "relay-policy-mode allow backgroundSessionId",
    );
    expect(allowMode.controlResult).toEqual({
      ok: true,
      type: "relay-policy-mode-result",
      mode: "allow",
      backgroundSessionId,
    });
    const mainBefore = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );

    const allowedCursor = diagnosticCursor(await diagnostics(runId));
    const allowed = await clickUiCommand(
      popup,
      runId,
      "relay-call",
      "popup",
      diagnostics,
      allowedCursor,
    );
    const [allowedObservation] = await policyObservations(
      runId,
      allowedCursor,
      diagnostics,
    );
    const afterAllowed = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    expect(allowed.result).toBe("relay-call-result");
    expect(allowed.identity).toMatchObject({
      label: "main",
      sessionId: afterAllowed.sessionId,
      nonce: afterAllowed.nonce,
    });
    expect(afterAllowed.invocationCount).toBe(mainBefore.invocationCount + 1);
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

    const denyMode = await clickUiCommand(
      workspace,
      runId,
      "relay-policy-mode",
      "workspace",
      diagnostics,
      diagnosticCursor(await diagnostics(runId)),
      "deny",
    );
    expect(denyMode.controlResult).toEqual({
      ok: true,
      type: "relay-policy-mode-result",
      mode: "deny",
      backgroundSessionId,
    });
    const deniedBefore = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    const deniedCursor = diagnosticCursor(await diagnostics(runId));
    const deniedCall = await clickUiCommand(
      workspace,
      runId,
      "relay-call",
      "workspace",
      diagnostics,
      deniedCursor,
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
      waitForResult,
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

    const restoreAllowMode = await clickUiCommand(
      workspace,
      runId,
      "relay-policy-mode",
      "workspace",
      diagnostics,
      diagnosticCursor(await diagnostics(runId)),
      "allow",
    );
    expect(restoreAllowMode.controlResult).toEqual({
      ok: true,
      type: "relay-policy-mode-result",
      mode: "allow",
      backgroundSessionId,
    });
    expect(mainBefore.sessionId).toEqual(deniedAfter.sessionId);
  } finally {
    await cleanupUi(workspace, runId, "workspace", diagnostics, waitForResult);
    await workspace.close();
    await cleanupUi(popup, runId, "popup", diagnostics, waitForResult);
    await popup.close();
    await cleanupContent(hostPage, runId, dispatchHostCommand, waitForResult);
  }
});

test("RL-CT-04 does not retarget a retained Relay handle across navigation", async ({
  diagnostics,
  dispatchHostCommand,
  hostPage,
  openExtensionPage,
  waitForEvent,
  waitForResult,
}) => {
  const runId = "relay-navigation-replacement";
  await openContent(hostPage, runId, waitForEvent);
  const popup = await openExtensionPage("popup", runId);

  try {
    const oldFacts = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    const initialTarget = await registryMainFact(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    const registration = await clickUiCommand(
      popup,
      runId,
      "relay-register",
      "popup",
      diagnostics,
    );
    expect(registration.target).toEqual(targetIdentity(initialTarget));
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
      waitForResult,
    );
    const freshTarget = await registryMainFact(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    expect(freshFacts.sessionId).not.toBe(oldFacts.sessionId);
    expect(freshFacts.nonce).not.toBe(oldFacts.nonce);

    const oldCall = await clickUiCommand(
      popup,
      runId,
      "relay-old-call",
      "popup",
      diagnostics,
      diagnosticCursor(await diagnostics(runId)),
      undefined,
      7_000,
    );
    const afterOldCall = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    expect(oldCall.kind).toBe("error");
    expect(afterOldCall.invocationCount).toBe(freshFacts.invocationCount);
    expect(oldCall.error?.code).toBe("E_REMOTE_EXCEPTION");
    expect(oldCall.error?.message).toEqual(expect.any(String));
    expect(oldCall.identity).toBeNull();

    const refresh = await clickUiCommand(
      popup,
      runId,
      "relay-refresh",
      "popup",
      diagnostics,
      diagnosticCursor(await diagnostics(runId)),
    );
    expect(refresh.result).toBe("relay-refresh-result");
    expect(refresh.oldTarget).toEqual(targetIdentity(initialTarget));
    expect(refresh.freshTarget).toEqual(targetIdentity(freshTarget));
    expect(initialTarget.tabId).toBe(freshTarget.tabId);
    expect(initialTarget.frameId).toBe(0);
    expect(freshTarget.frameId).toBe(0);
    expect(initialTarget.documentId).not.toBe("");
    expect(freshTarget.documentId).not.toBe("");
    expect(initialTarget.documentId).not.toBe(freshTarget.documentId);
    expect(initialTarget.sessionId).not.toBe(freshTarget.sessionId);
    expect(initialTarget.nonce).not.toBe(freshTarget.nonce);

    const freshCall = await clickUiCommand(
      popup,
      runId,
      "relay-fresh-call",
      "popup",
      diagnostics,
      diagnosticCursor(await diagnostics(runId)),
    );
    const afterFreshCall = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
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
      diagnostics,
      waitForResult,
    );
  }
});

test("RL-CT-05 keeps the workspace Relay proxy after popup teardown", async ({
  diagnostics,
  dispatchHostCommand,
  hostPage,
  openExtensionPage,
  waitForEvent,
  waitForResult,
}) => {
  const runId = "relay-downstream-isolation";
  await openContent(hostPage, runId, waitForEvent);
  const popup = await openExtensionPage("popup", runId);
  const workspace = await openExtensionPage("workspace", runId, {
    stateClient: "1",
  });

  try {
    const before = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    const first = await clickUiCommand(
      workspace,
      runId,
      "relay-call",
      "workspace",
      diagnostics,
    );
    const afterFirst = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    expect(first.identity).toEqual({
      label: "main",
      sessionId: afterFirst.sessionId,
      nonce: afterFirst.nonce,
    });
    expect(afterFirst.invocationCount).toBe(before.invocationCount + 1);

    await cleanupUi(popup, runId, "popup", diagnostics, waitForResult);
    await popup.close();

    const second = await clickUiCommand(
      workspace,
      runId,
      "relay-call",
      "workspace",
      diagnostics,
    );
    const afterSecond = await documentFacts(
      hostPage,
      runId,
      dispatchHostCommand,
      waitForResult,
    );
    expect(second.identity).toEqual(first.identity);
    expect(afterSecond.invocationCount).toBe(afterFirst.invocationCount + 1);
  } finally {
    if (!popup.isClosed()) {
      await cleanupUi(popup, runId, "popup", diagnostics, waitForResult);
      await popup.close();
    }
    await cleanupUiAndContent(
      workspace,
      hostPage,
      runId,
      "workspace",
      dispatchHostCommand,
      diagnostics,
      waitForResult,
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
  diagnostics: (runId: string) => Promise<readonly DiagnosticEvent[]>,
  after?: DiagnosticCursor,
  mode?: "allow" | "deny",
  timeoutMs = 5_000,
): Promise<UiResult> {
  const cursor = after ?? diagnosticCursor(await diagnostics(runId));
  const selector =
    command === "relay-policy-mode"
      ? `[data-command="${command}"][data-mode="${mode}"]`
      : `[data-command="${command}"]`;
  await page.locator(selector).click();
  let observed: DiagnosticEvent | undefined;
  await expect
    .poll(
      async () => {
        observed = (await diagnostics(runId)).find(
          (event) =>
            !cursor.has(eventIdentity(event)) &&
            event.participant === participant &&
            (event.kind === "result" || event.kind === "error") &&
            matchesUiResult(event.value, command),
        );
        return observed !== undefined;
      },
      { timeout: timeoutMs },
    )
    .toBe(true);
  if (!observed || (observed.kind !== "result" && observed.kind !== "error"))
    throw new Error(`Missing ${command} result`);
  return parseUiResult(observed.value, observed.kind);
}

async function cleanupUiAndContent(
  page: Page,
  hostPage: Page,
  runId: string,
  participant: "popup" | "workspace",
  dispatchHostCommand: DispatchHostCommand,
  diagnostics: (runId: string) => Promise<readonly DiagnosticEvent[]>,
  waitForResult: WaitForResult,
): Promise<void> {
  if (!page.isClosed()) {
    await cleanupUi(page, runId, participant, diagnostics, waitForResult);
    await page.close();
  }
  await cleanupContent(hostPage, runId, dispatchHostCommand, waitForResult);
}

async function cleanupContent(
  hostPage: Page,
  runId: string,
  dispatchHostCommand: DispatchHostCommand,
  waitForResult: WaitForResult,
): Promise<void> {
  const cursor = await dispatchHostCommand(
    hostPage,
    runId,
    "state-client-cleanup",
  );
  const result = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:main" &&
      parsed(event.value)?.result === "state-client-cleanup-result",
    { after: cursor },
  );
  expect(parsed(result.value)?.result).toBe("state-client-cleanup-result");
}

async function cleanupUi(
  page: Page,
  runId: string,
  participant: "popup" | "workspace",
  diagnostics: (runId: string) => Promise<readonly DiagnosticEvent[]>,
  waitForResult: WaitForResult,
): Promise<void> {
  const cursor = diagnosticCursor(await diagnostics(runId));
  await page.evaluate(() => {
    const cleanup = document.createElement("button");
    cleanup.dataset.command = "state-client-cleanup";
    document.body.append(cleanup);
    cleanup.click();
    cleanup.remove();
  });
  const result = await waitForResult(
    runId,
    (event) =>
      event.participant === participant &&
      parsed(event.value)?.result === "state-client-cleanup-result",
    { after: cursor },
  );
  expect(parsed(result.value)?.result).toBe("state-client-cleanup-result");
}

async function documentFacts(
  hostPage: Page,
  runId: string,
  dispatchHostCommand: DispatchHostCommand,
  waitForResult: WaitForResult,
): Promise<DocumentFacts> {
  const cursor = await dispatchHostCommand(
    hostPage,
    runId,
    "document-route-facts",
  );
  const result = await waitForResult(
    runId,
    (event) => event.participant === "content:main",
    { after: cursor },
  );
  return parseFacts(result.value);
}

async function registryMainFact(
  hostPage: Page,
  runId: string,
  dispatchHostCommand: DispatchHostCommand,
  waitForResult: WaitForResult,
): Promise<RegistryFact> {
  const cursor = await dispatchHostCommand(hostPage, runId, "registry-facts");
  const result = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:main" &&
      Array.isArray(parsed(event.value)?.providers),
    { after: cursor },
  );
  const providers = parsed(result.value)?.providers;
  if (!Array.isArray(providers))
    throw new Error(`Invalid registry facts: ${result.value}`);
  const main = providers.find((provider) => record(provider)?.label === "main");
  return parseRegistryFact(main);
}

async function frameFacts(
  frame: Frame,
  runId: string,
  participant: string,
  diagnostics: (runId: string) => Promise<readonly DiagnosticEvent[]>,
  waitForResult: WaitForResult,
): Promise<DocumentFacts> {
  const cursor = diagnosticCursor(await diagnostics(runId));
  await dispatchFrameCommand(frame, runId);
  const result = await waitForResult(
    runId,
    (event) => event.participant === participant,
    { after: cursor },
  );
  return parseFacts(result.value);
}

async function dispatchFrameCommand(
  frame: Frame,
  runId: string,
): Promise<void> {
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
}

async function policyObservations(
  runId: string,
  after: DiagnosticCursor,
  diagnostics: (runId: string) => Promise<readonly DiagnosticEvent[]>,
): Promise<readonly [PolicyObservation]> {
  const observations = (await diagnostics(runId)).flatMap((event) => {
    if (event.kind !== "result" && event.kind !== "error") return [];
    const value = parsed(event.value);
    return !after.has(eventIdentity(event)) &&
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
  const controlResult = record(outer.result);
  return {
    kind,
    result:
      typeof outer.result === "string"
        ? outer.result
        : typeof controlResult?.type === "string"
          ? controlResult.type
          : undefined,
    identity: outer.identity === null ? null : record(outer.identity),
    target: record(controlResult?.target),
    oldTarget: record(controlResult?.oldTarget),
    freshTarget: record(controlResult?.freshTarget),
    controlResult,
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

function parseRegistryFact(value: unknown): RegistryFact {
  const fact = record(value);
  if (
    !fact ||
    typeof fact.tabId !== "number" ||
    typeof fact.frameId !== "number" ||
    typeof fact.documentId !== "string" ||
    typeof fact.sessionId !== "string" ||
    typeof fact.nonce !== "string"
  )
    throw new Error(`Invalid main registry fact: ${JSON.stringify(value)}`);
  return fact as unknown as RegistryFact;
}

function targetIdentity(fact: RegistryFact) {
  return {
    tabId: fact.tabId,
    frameId: fact.frameId,
    documentId: fact.documentId,
    contentSessionId: fact.sessionId,
    contentNonce: fact.nonce,
  };
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

function commandResultName(command: string): string {
  switch (command) {
    case "relay-local-call":
      return "relay-local-result";
    case "relay-call":
      return "relay-call-result";
    case "relay-old-call":
      return "relay-old-result";
    case "relay-fresh-call":
      return "relay-fresh-result";
    default:
      return `${command}-result`;
  }
}

function matchesUiResult(value: string, command: string): boolean {
  const result = parsed(value);
  const expected = commandResultName(command);
  return (
    result?.result === expected || record(result?.result)?.type === expected
  );
}

function eventIdentity(event: DiagnosticEvent): string {
  return [
    event.runId,
    event.participant,
    event.sessionId ?? "none",
    event.sequence,
    event.kind,
  ].join(":");
}

type DocumentFacts = {
  readonly invocationCount: number;
  readonly sessionId: string;
  readonly nonce: string;
};

type RegistryFact = {
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId: string;
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
  readonly target?: Record<string, unknown>;
  readonly oldTarget?: Record<string, unknown>;
  readonly freshTarget?: Record<string, unknown>;
  readonly controlResult?: Record<string, unknown>;
  readonly error?: Record<string, unknown>;
};

type WaitForResult = (
  runId: string,
  predicate: (event: {
    readonly participant: string;
    readonly value: string;
  }) => boolean,
  options?: { readonly after?: DiagnosticCursor },
) => Promise<{
  readonly kind: "result" | "error";
  readonly value: string;
}>;

type DispatchHostCommand = (
  page: Page,
  runId: string,
  command: string,
  options?: { readonly after?: DiagnosticCursor },
) => Promise<DiagnosticCursor>;

const frameSequences = new WeakMap<Frame, number>();
