import type { Page } from "@playwright/test";
import {
  diagnosticCursor,
  diagnosticEventIdentity,
  expect,
  test,
  type DiagnosticCursor,
} from "../harness/playwright-fixtures";
import { fixtureOrigins } from "../harness/targets";
import {
  parseBridgeResult,
  type BridgeResult,
  type DiagnosticEvent,
} from "../protocol";

test("ST-MC-01..05 direct multi-context State lifecycle", async ({
  hostPage,
  diagnostics,
  dispatchHostCommandAndResult,
  openExtensionPage,
  waitForBarrier,
  waitForResult,
}) => {
  const runId = "ui-state-multi-context";
  let content: Page | undefined;
  let popup: Page | undefined;
  let workspace: Page | undefined;
  let freshPopup: Page | undefined;
  let contentLive = false;
  let popupLive = false;
  let workspaceLive = false;
  let freshPopupLive = false;
  let freshPopupSessionId: string | undefined;
  let contentCleanupStarted = false;
  let popupCleanupStarted = false;
  let workspaceCleanupStarted = false;
  let freshPopupCleanupStarted = false;
  const cleanupErrors: unknown[] = [];
  let stateClients:
    | {
        readonly main: StateEvidence;
        readonly popup: StateEvidence;
        readonly workspace: StateEvidence;
      }
    | undefined;
  let clients!: {
    readonly main: StateEvidence;
    readonly popup: StateEvidence;
    readonly workspace: StateEvidence;
  };

  const cleanupClient = async (
    page: Page,
    participant: "main" | "popup" | "workspace",
    expectedSessionId: string | undefined,
  ): Promise<boolean> => {
    try {
      if (participant === "main") {
        const acknowledgement = await dispatchHostCommandAndResult(
          page,
          runId,
          "state-client-cleanup",
        );
        expect(parsed(acknowledgement.value)).toMatchObject({
          result: "state-client-cleanup-result",
          participant: "main",
          sessionId: expectedSessionId ?? expect.any(String),
          status: { type: "destroyed" },
          error: null,
        });
      } else {
        const acknowledgement = await clickPageCommand(
          page,
          runId,
          "state-client-cleanup",
        );
        expect(parsed(acknowledgement.value)).toMatchObject({
          result: "state-client-cleanup-result",
          participant,
          sessionId: expectedSessionId ?? expect.any(String),
          status: { type: "destroyed" },
          error: null,
        });
      }
      return true;
    } catch (error) {
      cleanupErrors.push(error);
      return false;
    }
  };

  try {
    await test.step("ST-MC-01 initial three-client convergence", async () => {
      const initialCursor = diagnosticCursor(await diagnostics(runId));
      content = await openContent(hostPage, runId, waitForBarrier, true);
      contentLive = true;
      popup = await openExtensionPage("popup", runId);
      popupLive = true;
      workspace = await openExtensionPage("workspace", runId, {
        stateClient: "1",
      });
      workspaceLive = true;

      const mainReady = await waitForStateEvidence(
        runId,
        "main",
        "state-client-ready",
        0,
        0,
        undefined,
        waitForResult,
        initialCursor,
      );
      const popupReady = await waitForStateEvidence(
        runId,
        "popup",
        "state-client-ready",
        0,
        0,
        mainReady.storeInstanceId,
        waitForResult,
        initialCursor,
      );
      const workspaceReady = await waitForStateEvidence(
        runId,
        "workspace",
        "state-client-ready",
        0,
        0,
        mainReady.storeInstanceId,
        waitForResult,
        initialCursor,
      );

      expect(popupReady.storeInstanceId).toBe(mainReady.storeInstanceId);
      expect(workspaceReady.storeInstanceId).toBe(mainReady.storeInstanceId);
      expect(mainReady.storeInstanceId).toMatch(/\S+/);
      expect(mainReady.sessionId).not.toBe(popupReady.sessionId);
      expect(mainReady.sessionId).not.toBe(workspaceReady.sessionId);
      expect(popupReady.sessionId).not.toBe(workspaceReady.sessionId);

      stateClients = {
        main: mainReady,
        popup: popupReady,
        workspace: workspaceReady,
      };
    });

    expect(stateClients).toBeDefined();
    clients = stateClients as {
      readonly main: StateEvidence;
      readonly popup: StateEvidence;
      readonly workspace: StateEvidence;
    };
    const storeInstanceId = clients.main.storeInstanceId;

    await test.step("ST-MC-02 popup action fan-out at version 1", async () => {
      const actionCursor = diagnosticCursor(await diagnostics(runId));
      const action = await clickPageCommand(popup!, runId, "state-ui-action");
      expect(parsed(action.value)).toMatchObject({
        result: "state-action-result",
        participant: "popup",
        sessionId: clients.popup.sessionId,
        status: { type: "ready", storeInstanceId, version: 1 },
        state: { count: 1 },
        value: 1,
        error: null,
      });
      await waitForStateEvidence(
        runId,
        "main",
        "state-observed-v1",
        1,
        1,
        storeInstanceId,
        waitForResult,
        actionCursor,
        clients.main.sessionId,
      );
      await waitForStateEvidence(
        runId,
        "popup",
        "state-observed-v1",
        1,
        1,
        storeInstanceId,
        waitForResult,
        actionCursor,
        clients.popup.sessionId,
      );
      await waitForStateEvidence(
        runId,
        "workspace",
        "state-observed-v1",
        1,
        1,
        storeInstanceId,
        waitForResult,
        actionCursor,
        clients.workspace.sessionId,
      );
    });

    await test.step("ST-MC-03 main content action fan-out at version 2", async () => {
      const actionCursor = diagnosticCursor(await diagnostics(runId));
      const action = await dispatchHostCommandAndResult(
        hostPage,
        runId,
        "state-content-action",
      );
      expect(parsed(action.value)).toMatchObject({
        result: "state-action-result",
        participant: "main",
        sessionId: clients.main.sessionId,
        status: { type: "ready", storeInstanceId, version: 2 },
        state: { count: 2 },
        value: 2,
        error: null,
      });
      await waitForStateEvidence(
        runId,
        "main",
        "state-observed-v2",
        2,
        2,
        storeInstanceId,
        waitForResult,
        actionCursor,
        clients.main.sessionId,
      );
      await waitForStateEvidence(
        runId,
        "popup",
        "state-observed-v2",
        2,
        2,
        storeInstanceId,
        waitForResult,
        actionCursor,
        clients.popup.sessionId,
      );
      await waitForStateEvidence(
        runId,
        "workspace",
        "state-observed-v2",
        2,
        2,
        storeInstanceId,
        waitForResult,
        actionCursor,
        clients.workspace.sessionId,
      );
    });

    await test.step("ST-MC-04 workspace action fan-out at version 3", async () => {
      const actionCursor = diagnosticCursor(await diagnostics(runId));
      const action = await clickPageCommand(
        workspace!,
        runId,
        "state-ui-action",
      );
      expect(parsed(action.value)).toMatchObject({
        result: "state-action-result",
        participant: "workspace",
        sessionId: clients.workspace.sessionId,
        status: { type: "ready", storeInstanceId, version: 3 },
        state: { count: 3 },
        value: 3,
        error: null,
      });
      await waitForStateEvidence(
        runId,
        "main",
        "state-observed-v3",
        3,
        3,
        storeInstanceId,
        waitForResult,
        actionCursor,
        clients.main.sessionId,
      );
      await waitForStateEvidence(
        runId,
        "popup",
        "state-observed-v3",
        3,
        3,
        storeInstanceId,
        waitForResult,
        actionCursor,
        clients.popup.sessionId,
      );
      await waitForStateEvidence(
        runId,
        "workspace",
        "state-observed-v3",
        3,
        3,
        storeInstanceId,
        waitForResult,
        actionCursor,
        clients.workspace.sessionId,
      );
    });

    await test.step("ST-MC-05 popup cleanup and fresh late join at version 4", async () => {
      popupCleanupStarted = true;
      const popupCleaned = await cleanupClient(
        popup!,
        "popup",
        clients.popup.sessionId,
      );
      if (!popupCleaned) {
        throw new Error("Popup State cleanup was not acknowledged");
      }
      const cleanupCursor = diagnosticCursor(await diagnostics(runId));
      const action = await clickPageCommand(
        workspace!,
        runId,
        "state-ui-action",
      );
      expect(parsed(action.value)).toMatchObject({
        result: "state-action-result",
        participant: "workspace",
        sessionId: clients.workspace.sessionId,
        status: { type: "ready", storeInstanceId, version: 4 },
        state: { count: 4 },
        value: 4,
        error: null,
      });
      await waitForStateEvidence(
        runId,
        "main",
        "state-observed-v4",
        4,
        4,
        storeInstanceId,
        waitForResult,
        cleanupCursor,
        clients.main.sessionId,
      );
      await waitForStateEvidence(
        runId,
        "workspace",
        "state-observed-v4",
        4,
        4,
        storeInstanceId,
        waitForResult,
        cleanupCursor,
        clients.workspace.sessionId,
      );
      const postCleanupEvents = (await diagnostics(runId)).filter(
        (event) => !cleanupCursor.has(diagnosticEventIdentity(event)),
      );
      const oldPopupObservations = postCleanupEvents.filter((event) => {
        if (
          event.participant !== "popup" ||
          event.sessionId !== clients.popup.sessionId ||
          event.kind !== "result"
        ) {
          return false;
        }
        const value = parsed(event.value);
        return (
          value?.type === "state-subscription" ||
          (typeof value?.result === "string" &&
            value.result.startsWith("state-observed-"))
        );
      }).length;
      expect(oldPopupObservations).toBe(0);

      popupLive = false;
      await popup!.close();

      const freshCursor = diagnosticCursor(await diagnostics(runId));
      freshPopup = await openExtensionPage("popup", runId);
      freshPopupLive = true;
      const freshReady = await waitForStateEvidence(
        runId,
        "popup",
        "state-client-ready",
        4,
        4,
        storeInstanceId,
        waitForResult,
        freshCursor,
      );
      freshPopupSessionId = freshReady.sessionId;
      expect(freshReady.sessionId).not.toBe(clients.popup.sessionId);
      const freshBaseline = await waitForResult(
        runId,
        (event) =>
          event.participant === "popup" &&
          event.sessionId === freshReady.sessionId &&
          parsed(event.value)?.type === "state-baseline",
        { after: freshCursor },
      );
      expect(parsed(freshBaseline.value)).toMatchObject({
        type: "state-baseline",
        status: { type: "ready", storeInstanceId, version: 4 },
        count: 4,
      });
    });
  } finally {
    if (freshPopup && freshPopupLive && !freshPopupCleanupStarted) {
      freshPopupCleanupStarted = true;
      await cleanupClient(freshPopup, "popup", freshPopupSessionId);
      freshPopupLive = false;
    }
    if (content && contentLive && !contentCleanupStarted) {
      contentCleanupStarted = true;
      await cleanupClient(content, "main", stateClients?.main.sessionId);
      contentLive = false;
    }
    if (popup && popupLive && !popupCleanupStarted) {
      popupCleanupStarted = true;
      await cleanupClient(popup, "popup", stateClients?.popup.sessionId);
      popupLive = false;
    }
    if (workspace && workspaceLive && !workspaceCleanupStarted) {
      workspaceCleanupStarted = true;
      await cleanupClient(
        workspace,
        "workspace",
        stateClients?.workspace.sessionId,
      );
      workspaceLive = false;
    }
    if (cleanupErrors.length > 0) {
      throw new Error(
        `State client cleanup failed: ${String(cleanupErrors[0])}`,
      );
    }
  }
});

test("CE-05 options persists setting across reload with a replacement local session", async ({
  openExtensionPage,
}) => {
  const runId = "ui-options-lifecycle";
  const options = await openExtensionPage("options", runId);
  const firstSessionId = await sessionId(options, runId, "options");

  const set = await clickPageCommand(options, runId, "set-setting");
  await expect(options.locator("[data-status]")).toHaveText("options-updated");
  expect(set.value).toBe("setting:options-updated");

  await options.reload();
  await expect(options.locator("[data-status]")).toContainText(
    "options:ready:",
  );
  const secondSessionId = await sessionId(options, runId, "options");
  expect(secondSessionId).not.toBe(firstSessionId);

  const read = await clickPageCommand(options, runId, "setting");
  await expect(options.locator("[data-status]")).toHaveText("options-updated");
  expect(read.value).toBe("setting:options-updated");
});

test("CE-21/22 offscreen lifecycle recreates a distinct provider session", async ({
  hostPage,
  diagnostics,
  dispatchHostCommandAndResult,
  waitForBarrier,
  waitForEvent,
}) => {
  const runId = "ui-offscreen-lifecycle";
  await openContent(hostPage, runId, waitForBarrier);

  const createCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchHostCommandAndResult(hostPage, runId, "offscreen-create");
  const firstSessionId = await providerSessionId(
    runId,
    "offscreen",
    waitForEvent,
    createCursor,
  );
  expect(firstSessionId).toMatch(/^[a-zA-Z0-9-]{36}$/);
  await dispatchHostCommandAndResult(hostPage, runId, "offscreen-close");

  const recreateCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchHostCommandAndResult(hostPage, runId, "offscreen-create");
  const secondSessionId = await providerSessionId(
    runId,
    "offscreen",
    waitForEvent,
    recreateCursor,
    firstSessionId,
  );
  expect(secondSessionId).not.toBe(firstSessionId);
});

async function openContent(
  hostPage: Page,
  runId: string,
  waitForBarrier: (
    runId: string,
    name: string,
    occurrence?: number,
  ) => Promise<void>,
  stateClient = false,
): Promise<Page> {
  const query = stateClient ? "&stateClient=1" : "";
  await hostPage.goto(
    `${fixtureOrigins.main}/host.html?runId=${runId}${query}`,
  );
  await waitForBarrier(runId, "background-ready");
  await waitForBarrier(runId, "content-listener-ready without route");
  return hostPage;
}

type StateEvidence = {
  readonly sessionId: string;
  readonly storeInstanceId: string;
};

async function waitForStateEvidence(
  runId: string,
  participant: "main" | "popup" | "workspace",
  result: string,
  version: number,
  count: number,
  storeInstanceId: string | undefined,
  waitForResult: (
    runId: string,
    predicate: (event: ResultEvent) => boolean,
    options?: { readonly after?: DiagnosticCursor },
  ) => Promise<ResultEvent>,
  after?: DiagnosticCursor,
  expectedSessionId?: string,
): Promise<StateEvidence> {
  const event = await waitForResult(
    runId,
    (candidate) => {
      const value = parsed(candidate.value);
      return (
        candidate.participant ===
          (participant === "main" ? "content:main" : participant) &&
        value?.result === result &&
        (expectedSessionId === undefined ||
          candidate.sessionId === expectedSessionId)
      );
    },
    { after },
  );
  const value = parsed(event.value);
  expect(value).toMatchObject({
    result,
    participant,
    sessionId: expect.any(String),
    status: {
      type: "ready",
      storeInstanceId: storeInstanceId ?? expect.any(String),
      version,
    },
    storeInstanceId: expect.any(String),
    version,
    state: { count },
    error: null,
  });
  const observedStoreInstanceId = value?.storeInstanceId;
  expect(observedStoreInstanceId).toBe(
    storeInstanceId ?? observedStoreInstanceId,
  );
  expect(event.sessionId).toEqual(expect.any(String));
  expect(value?.sessionId).toBe(event.sessionId);
  return {
    sessionId: event.sessionId as string,
    storeInstanceId: observedStoreInstanceId as string,
  };
}

async function clickPageCommand(
  page: Page,
  runId: string,
  command: string,
): Promise<BridgeResult> {
  const output = page.locator("[data-result]");
  const before = await output.evaluate((element) =>
    element instanceof HTMLOutputElement ? element.value : "",
  );
  const commandButton = page.locator(`[data-command="${command}"]`);
  if ((await commandButton.count()) !== 1)
    throw new Error(`Missing real page command control: ${command}`);
  await commandButton.click();
  await expect
    .poll(async () =>
      output.evaluate((element) =>
        element instanceof HTMLOutputElement ? element.value : "",
      ),
    )
    .not.toBe(before);
  const value = await output.evaluate((element) =>
    element instanceof HTMLOutputElement ? element.value : "",
  );
  const result = parseBridgeResult(JSON.parse(value), {
    runId,
    command,
    sequence: Number(await output.getAttribute("data-sequence")),
  });
  if (result) return result;
  throw new Error(`Invalid ${command} page result: ${value}`);
}

async function sessionId(
  page: Page,
  runId: string,
  participant: string,
): Promise<string> {
  const response = await clickPageCommand(page, runId, "session");
  expect(response.participant).toBe(participant);
  const result = parsed(response.value);
  expect(result?.session).toMatch(/^[a-zA-Z0-9-]{36}$/);
  expect(response.sessionId).toBe(result?.session);
  return result?.session as string;
}

async function providerSessionId(
  runId: string,
  participant: string,
  waitForEvent: (
    runId: string,
    predicate: (event: DiagnosticEvent) => boolean,
    options?: { readonly after?: DiagnosticCursor; readonly count?: number },
  ) => Promise<readonly DiagnosticEvent[]>,
  after: DiagnosticCursor,
  previous?: string,
): Promise<string> {
  const events = await waitForEvent(
    runId,
    (event) =>
      event.participant === participant &&
      event.kind === "barrier" &&
      event.name === "provider-live" &&
      event.sessionId !== undefined &&
      event.sessionId !== previous,
    { after },
  );
  return events[0]?.sessionId as string;
}

function parsed(value: string): Record<string, any> | undefined {
  try {
    const result: unknown = JSON.parse(value);
    return result && typeof result === "object"
      ? (result as Record<string, any>)
      : undefined;
  } catch {
    return undefined;
  }
}

type ResultEvent = DiagnosticEvent & {
  readonly kind: "result";
  readonly value: string;
};
