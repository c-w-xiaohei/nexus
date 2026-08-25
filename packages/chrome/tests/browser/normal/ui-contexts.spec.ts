import type { Page } from "@playwright/test";
import {
  diagnosticCursor,
  diagnosticEventIdentity,
  expect,
  test,
  type DiagnosticCursor,
} from "../harness/playwright-fixtures";
import { fixtureOrigins } from "../harness/targets";
import type { DiagnosticEvent } from "../protocol";

test("ST-MC-01..05 direct multi-context State lifecycle", async ({
  hostPage,
  diagnostics,
  dispatchHostCommand,
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
    after: DiagnosticCursor,
  ): Promise<boolean> => {
    try {
      if (participant === "main") {
        await dispatchHostCommand(page, runId, "state-client-cleanup", {
          after,
        });
      } else {
        await triggerPageCommand(page, "state-client-cleanup");
      }
      const acknowledgement = await waitForResult(
        runId,
        (event) =>
          event.participant ===
            (participant === "main" ? "content:main" : participant) &&
          parsed(event.value)?.result === "state-client-cleanup-result",
        { after },
      );
      expect(parsed(acknowledgement.value)).toMatchObject({
        result: "state-client-cleanup-result",
        participant: participant === "main" ? "main" : participant,
        sessionId: expectedSessionId ?? expect.any(String),
        status: { type: "destroyed" },
        error: null,
      });
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
      await popup!
        .getByRole("button", { name: "Increment shared State" })
        .click();
      const action = await waitForResult(
        runId,
        (event) =>
          event.participant === "popup" &&
          event.sessionId === clients.popup.sessionId &&
          parsed(event.value)?.result === "state-action-result",
        { after: actionCursor },
      );
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
      const actionCursor = await dispatchHostCommand(
        hostPage,
        runId,
        "state-content-action",
      );
      const action = await waitForResult(
        runId,
        (event) =>
          event.participant === "content:main" &&
          event.sessionId === clients.main.sessionId &&
          parsed(event.value)?.result === "state-action-result",
        { after: actionCursor },
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
      await workspace!
        .getByRole("button", { name: "Increment shared workspace State" })
        .click();
      const action = await waitForResult(
        runId,
        (event) =>
          event.participant === "workspace" &&
          event.sessionId === clients.workspace.sessionId &&
          parsed(event.value)?.result === "state-action-result",
        { after: actionCursor },
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

    await test.step("ST-MC-05 popup cleanup and fresh late join", async () => {
      const closeCursor = diagnosticCursor(await diagnostics(runId));
      const beforeCloseEvents = await diagnostics(runId);
      const workspaceV3Evidence = beforeCloseEvents.find(
        (event): event is ResultEvent =>
          event.kind === "result" &&
          event.participant === "workspace" &&
          event.sessionId === clients.workspace.sessionId &&
          parsed(event.value)?.result === "state-observed-v3",
      );
      expect(workspaceV3Evidence).toBeDefined();
      expect(parsed(workspaceV3Evidence?.value ?? "")).toMatchObject({
        result: "state-observed-v3",
        participant: "workspace",
        sessionId: clients.workspace.sessionId,
        storeInstanceId,
        version: 3,
        state: { count: 3 },
        error: null,
      });
      popupCleanupStarted = true;
      const popupCleaned = await cleanupClient(
        popup!,
        "popup",
        clients.popup.sessionId,
        closeCursor,
      );
      if (!popupCleaned) {
        throw new Error("Popup State cleanup was not acknowledged");
      }
      popupLive = false;
      await popup!.close();

      const postCloseCursor = diagnosticCursor(await diagnostics(runId));
      const stateInspectCursor = await dispatchHostCommand(
        content!,
        runId,
        "worker-state-check",
        { after: postCloseCursor },
      );
      const inspectedState = await waitForResult(
        runId,
        (event) =>
          event.participant === "content:main" &&
          event.sessionId === clients.main.sessionId &&
          parsed(event.value)?.status !== undefined &&
          parsed(event.value)?.state !== undefined,
        { after: stateInspectCursor },
      );
      expect(parsed(inspectedState.value)).toEqual({
        state: { count: 3 },
        status: {
          type: "ready",
          storeInstanceId,
          version: 3,
        },
      });

      const survivorCursor = diagnosticCursor(await diagnostics(runId));
      await workspace!.getByRole("button", { name: "Session" }).click();
      const workspaceSession = await waitForResult(
        runId,
        (event) =>
          event.participant === "workspace" &&
          event.sessionId === clients.workspace.sessionId &&
          parsed(event.value)?.session === clients.workspace.sessionId,
        { after: survivorCursor },
      );
      expect(parsed(workspaceSession.value)).toMatchObject({
        session: clients.workspace.sessionId,
        status: {
          type: "ready",
          storeInstanceId,
          version: 3,
        },
        state: { count: 3 },
      });
      const afterSurvivor = await diagnostics(runId);
      const postCloseEvents = afterSurvivor.filter(
        (event) => !postCloseCursor.has(diagnosticEventIdentity(event)),
      );
      const laterOldPopupObservations = postCloseEvents.filter((event) => {
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
      expect(laterOldPopupObservations).toBe(0);

      const freshCursor = diagnosticCursor(await diagnostics(runId));
      freshPopup = await openExtensionPage("popup", runId);
      freshPopupLive = true;
      const freshReady = await waitForStateEvidence(
        runId,
        "popup",
        "state-client-ready",
        3,
        3,
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
        status: { type: "ready", storeInstanceId, version: 3 },
        count: 3,
      });
    });
  } finally {
    if (freshPopup && freshPopupLive && !freshPopupCleanupStarted) {
      freshPopupCleanupStarted = true;
      await cleanupClient(
        freshPopup,
        "popup",
        freshPopupSessionId,
        diagnosticCursor(await diagnostics(runId)),
      );
      freshPopupLive = false;
    }
    if (content && contentLive && !contentCleanupStarted) {
      contentCleanupStarted = true;
      await cleanupClient(
        content,
        "main",
        stateClients?.main.sessionId,
        diagnosticCursor(await diagnostics(runId)),
      );
      contentLive = false;
    }
    if (popup && popupLive && !popupCleanupStarted) {
      popupCleanupStarted = true;
      await cleanupClient(
        popup,
        "popup",
        stateClients?.popup.sessionId,
        diagnosticCursor(await diagnostics(runId)),
      );
      popupLive = false;
    }
    if (workspace && workspaceLive && !workspaceCleanupStarted) {
      workspaceCleanupStarted = true;
      await cleanupClient(
        workspace,
        "workspace",
        stateClients?.workspace.sessionId,
        diagnosticCursor(await diagnostics(runId)),
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

test("CE-04/20 popup State lifecycle keeps old sessions unavailable", async ({
  hostPage,
  diagnostics,
  dispatchHostCommand,
  openExtensionPage,
  waitForBarrier,
  waitForResult,
}) => {
  const runId = "ui-popup-lifecycle";
  let popup: Page | undefined;
  let replacement: Page | undefined;
  let popupLive = false;
  let replacementLive = false;
  let popupCleanupStarted = false;
  let replacementCleanupStarted = false;
  const cleanupErrors: unknown[] = [];
  let primaryError: unknown;
  let firstSessionId: string | undefined;
  let secondSessionId: string | undefined;

  const cleanupPopup = async (
    page: Page,
    expectedSessionId: string | undefined,
  ): Promise<boolean> => {
    try {
      const after = diagnosticCursor(await diagnostics(runId));
      await triggerPageCommand(page, "state-client-cleanup");
      const acknowledgement = await waitForResult(
        runId,
        (event) =>
          event.participant === "popup" &&
          (expectedSessionId === undefined ||
            event.sessionId === expectedSessionId) &&
          parsed(event.value)?.result === "state-client-cleanup-result",
        { after },
      );
      expect(parsed(acknowledgement.value)).toEqual({
        result: "state-client-cleanup-result",
        participant: "popup",
        sessionId: expectedSessionId ?? expect.any(String),
        status: { type: "destroyed" },
        state: null,
        error: null,
      });
      return true;
    } catch (error) {
      cleanupErrors.push(error);
      return false;
    }
  };

  try {
    const content = await openContent(hostPage, runId, waitForBarrier);
    popup = await openExtensionPage("popup", runId);
    popupLive = true;
    firstSessionId = await sessionId(
      popup,
      runId,
      "popup",
      diagnostics,
      waitForResult,
    );

    const baseline = (await diagnostics(runId)).find(
      (event): event is ResultEvent =>
        event.kind === "result" &&
        event.participant === "popup" &&
        event.sessionId === firstSessionId &&
        parsed(event.value)?.type === "state-baseline",
    );
    expect(baseline).toBeDefined();
    expect(parsed(baseline?.value ?? "")).toMatchObject({
      status: { type: "ready" },
      count: 0,
    });
    const baselineState = parsed(baseline?.value ?? "");
    const storeInstanceId = (
      baselineState?.status as { storeInstanceId?: unknown }
    )?.storeInstanceId;
    expect(storeInstanceId).toEqual(expect.any(String));

    const actionCursor = diagnosticCursor(await diagnostics(runId));
    await popup.getByRole("button", { name: "Increment" }).click();
    await expect(popup.locator("[data-status]")).toHaveText("state:1");
    const action = await waitForResult(
      runId,
      (event) =>
        event.participant === "popup" &&
        event.sessionId === firstSessionId &&
        parsed(event.value)?.type === "state-action",
      { after: actionCursor },
    );
    expect(parsed(action.value)).toEqual({ type: "state-action", value: 1 });
    await waitForResult(
      runId,
      (event) =>
        event.participant === "popup" &&
        event.sessionId === firstSessionId &&
        parsed(event.value)?.type === "state-subscription" &&
        parsed(event.value)?.count === 1,
      { after: actionCursor },
    );

    const stateInspectCursor = await dispatchHostCommand(
      hostPage,
      runId,
      "worker-state-check",
      { after: actionCursor },
    );
    const inspectedState = await waitForResult(
      runId,
      (event) =>
        event.participant === "content:main" &&
        parsed(event.value)?.state !== undefined &&
        parsed(event.value)?.status !== undefined,
      { after: stateInspectCursor },
    );
    expect(parsed(inspectedState.value)).toMatchObject({
      state: { count: 1 },
      status: { type: "ready", storeInstanceId },
    });

    const closeCursor = diagnosticCursor(await diagnostics(runId));
    popupCleanupStarted = true;
    if (!(await cleanupPopup(popup, firstSessionId))) {
      throw new Error("First popup State cleanup was not acknowledged");
    }
    popupLive = false;
    await popup.close();
    await expectSessionNoMatch(
      content,
      runId,
      firstSessionId,
      closeCursor,
      dispatchHostCommand,
      waitForResult,
    );

    replacement = await openExtensionPage("popup", runId);
    replacementLive = true;
    secondSessionId = await sessionId(
      replacement,
      runId,
      "popup",
      diagnostics,
      waitForResult,
    );
    expect(secondSessionId).not.toBe(firstSessionId);
    await expectSessionSelected(
      content,
      runId,
      secondSessionId,
      dispatchHostCommand,
      waitForResult,
    );
    await expect(replacement.locator("[data-status]")).toContainText(
      `popup:ready:${secondSessionId}`,
    );
    await replacement.getByRole("button", { name: "Increment" }).click();
    await expect(replacement.locator("[data-status]")).toHaveText("state:2");

    replacementCleanupStarted = true;
    if (!(await cleanupPopup(replacement, secondSessionId))) {
      throw new Error("Replacement popup State cleanup was not acknowledged");
    }
    replacementLive = false;
    await replacement.close();
  } catch (error) {
    primaryError = error;
  } finally {
    if (replacement && replacementLive && !replacementCleanupStarted) {
      replacementCleanupStarted = true;
      if (!(await cleanupPopup(replacement, secondSessionId))) {
        replacementLive = false;
      }
    }
    if (popup && popupLive && !popupCleanupStarted) {
      popupCleanupStarted = true;
      if (!(await cleanupPopup(popup, firstSessionId))) popupLive = false;
    }
    for (const page of [replacement, popup]) {
      if (page && !page.isClosed()) {
        try {
          await page.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new Error(`State client cleanup failed: ${String(cleanupErrors[0])}`);
  }
});

test("CE-05 options persists setting across reload without an old-session effect", async ({
  hostPage,
  diagnostics,
  dispatchHostCommand,
  openExtensionPage,
  waitForBarrier,
  waitForResult,
}) => {
  const runId = "ui-options-lifecycle";
  const content = await openContent(hostPage, runId, waitForBarrier);
  const options = await openExtensionPage("options", runId);
  const firstSessionId = await sessionId(
    options,
    runId,
    "options",
    diagnostics,
    waitForResult,
  );

  const setCursor = diagnosticCursor(await diagnostics(runId));
  await options.getByRole("button", { name: "Set setting" }).click();
  await expect(options.locator("[data-status]")).toHaveText("options-updated");
  await waitForResult(
    runId,
    (event) =>
      event.participant === "options" &&
      event.sessionId === firstSessionId &&
      event.value === "setting:options-updated",
    { after: setCursor },
  );

  const reloadCursor = diagnosticCursor(await diagnostics(runId));
  await options.reload();
  await expect(options.locator("[data-status]")).toContainText(
    "options:ready:",
  );
  const secondSessionId = await sessionId(
    options,
    runId,
    "options",
    diagnostics,
    waitForResult,
  );
  expect(secondSessionId).not.toBe(firstSessionId);
  await expectSessionNoMatch(
    content,
    runId,
    firstSessionId,
    reloadCursor,
    dispatchHostCommand,
    waitForResult,
  );
  await expectSessionSelected(
    content,
    runId,
    secondSessionId,
    dispatchHostCommand,
    waitForResult,
  );

  const readCursor = diagnosticCursor(await diagnostics(runId));
  await options.getByRole("button", { name: "Read setting" }).click();
  await expect(options.locator("[data-status]")).toHaveText("options-updated");
  await waitForResult(
    runId,
    (event) =>
      event.participant === "options" &&
      event.sessionId === secondSessionId &&
      event.value === "setting:options-updated",
    { after: readCursor },
  );
});

test("CE-06 workspace exposes its custom audit session", async ({
  hostPage,
  diagnostics,
  dispatchHostCommand,
  openExtensionPage,
  waitForBarrier,
  waitForResult,
}) => {
  const runId = "ui-workspace-audit";
  await openContent(hostPage, runId, waitForBarrier);
  const workspace = await openExtensionPage("workspace", runId);
  const workspaceSessionId = await sessionId(
    workspace,
    runId,
    "workspace",
    diagnostics,
    waitForResult,
  );
  await expectSessionSelected(
    hostPage,
    runId,
    workspaceSessionId,
    dispatchHostCommand,
    waitForResult,
  );
  const cursor = diagnosticCursor(await diagnostics(runId));

  await workspace.getByRole("button", { name: "Audit" }).click();
  await expect(workspace.locator("[data-status]")).toHaveText(
    `audit:${workspaceSessionId}`,
  );
  const audit = await waitForResult(
    runId,
    (event) =>
      event.participant === "workspace" &&
      event.sessionId === workspaceSessionId,
    { after: cursor },
  );
  expect(audit.value).toBe(`audit:${workspaceSessionId}`);
});

test("CE-21/22 background recreates offscreen export and keeps State distinct from storage", async ({
  hostPage,
  diagnostics,
  dispatchHostCommand,
  waitForBarrier,
  waitForEvent,
  waitForDomValue,
  waitForResult,
}) => {
  const runId = "ui-offscreen-state-storage";
  const content = await openContent(hostPage, runId, waitForBarrier);

  const baselineCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchHostCommand(hostPage, runId, "background-summary", {
    after: baselineCursor,
  });
  const baseline = await waitForResult(
    runId,
    (event) => event.participant === "content:main",
    { after: baselineCursor },
  );
  expect(parsed(baseline.value)).toMatchObject({
    counter: 0,
    setting: "compact",
  });

  const incrementCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchHostCommand(hostPage, runId, "background-increment", {
    after: incrementCursor,
  });
  await waitForResult(
    runId,
    (event) => event.participant === "content:main" && event.value === "1",
    { after: incrementCursor },
  );

  const storageCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchHostCommand(hostPage, runId, "background-setting", {
    after: storageCursor,
  });
  await waitForResult(
    runId,
    (event) =>
      event.participant === "content:main" && event.value === "compact",
    { after: storageCursor },
  );

  const createCursor = diagnosticCursor(await diagnostics(runId));
  const firstVisibleBefore = await bridgeStatus(hostPage);
  await dispatchHostCommand(hostPage, runId, "offscreen-create", {
    after: createCursor,
  });
  const firstSessionId = await providerSessionId(
    runId,
    "offscreen",
    waitForEvent,
    createCursor,
  );
  const firstExport = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:main" &&
      parsed(event.value)?.export === "export:ready" &&
      parsed(event.value)?.sessionId === firstSessionId,
    { after: createCursor },
  );
  expect(parsed(firstExport.value)).toEqual({
    export: "export:ready",
    sessionId: firstSessionId,
  });
  const firstVisibleExport = await waitForHostResult(
    waitForDomValue,
    hostPage,
    firstVisibleBefore,
  );
  expect(firstVisibleExport.command).toBe("offscreen-create");
  expect(parsed(firstVisibleExport.value)).toEqual({
    export: "export:ready",
    sessionId: firstSessionId,
  });
  await expectSessionSelected(
    content,
    runId,
    firstSessionId,
    dispatchHostCommand,
    waitForResult,
  );
  const closeCursor = diagnosticCursor(await diagnostics(runId));
  await dispatchHostCommand(hostPage, runId, "offscreen-close", {
    after: closeCursor,
  });
  await waitForResult(
    runId,
    (event) =>
      event.participant === "content:main" &&
      parsed(event.value)?.closed === true,
    { after: closeCursor },
  );
  await expectSessionNoMatch(
    content,
    runId,
    firstSessionId,
    closeCursor,
    dispatchHostCommand,
    waitForResult,
  );

  const recreateCursor = diagnosticCursor(await diagnostics(runId));
  const secondVisibleBefore = await bridgeStatus(hostPage);
  await dispatchHostCommand(hostPage, runId, "offscreen-create", {
    after: recreateCursor,
  });
  const secondSessionId = await providerSessionId(
    runId,
    "offscreen",
    waitForEvent,
    recreateCursor,
    firstSessionId,
  );
  const secondExport = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:main" &&
      parsed(event.value)?.export === "export:ready" &&
      parsed(event.value)?.sessionId === secondSessionId,
    { after: recreateCursor },
  );
  expect(parsed(secondExport.value)).toEqual({
    export: "export:ready",
    sessionId: secondSessionId,
  });
  const secondVisibleExport = await waitForHostResult(
    waitForDomValue,
    hostPage,
    secondVisibleBefore,
  );
  expect(secondVisibleExport.command).toBe("offscreen-create");
  expect(parsed(secondVisibleExport.value)).toEqual({
    export: "export:ready",
    sessionId: secondSessionId,
  });
  expect(secondSessionId).not.toBe(firstSessionId);
  await expectSessionSelected(
    content,
    runId,
    secondSessionId,
    dispatchHostCommand,
    waitForResult,
  );
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

async function triggerPageCommand(page: Page, command: string): Promise<void> {
  await page.evaluate((command) => {
    const element = document.createElement("button");
    element.dataset.command = command;
    document.body.append(element);
    element.click();
    element.remove();
  }, command);
}

async function sessionId(
  page: Page,
  runId: string,
  participant: string,
  diagnostics: (runId: string) => Promise<readonly DiagnosticEvent[]>,
  waitForResult: (
    runId: string,
    predicate: (event: {
      readonly participant: string;
      readonly value: string;
    }) => boolean,
    options?: { readonly after?: DiagnosticCursor },
  ) => Promise<{ readonly value: string }>,
): Promise<string> {
  const cursor = diagnosticCursor(await diagnostics(runId));
  await page.getByRole("button", { name: "Session" }).click();
  const result = parsed(
    (
      await waitForResult(
        runId,
        (event) =>
          event.participant === participant && parsed(event.value)?.session,
        { after: cursor },
      )
    ).value,
  );
  expect(result?.session).toMatch(/^[a-zA-Z0-9-]{36}$/);
  return result?.session as string;
}

async function expectSessionSelected(
  content: Page,
  runId: string,
  sessionId: string,
  dispatchHostCommand: (
    page: Page,
    runId: string,
    command: string,
    options?: {
      readonly sessionId?: string;
      readonly after?: DiagnosticCursor;
    },
  ) => Promise<DiagnosticCursor>,
  waitForResult: (
    runId: string,
    predicate: (event: { readonly value: string }) => boolean,
    options?: { readonly after?: DiagnosticCursor },
  ) => Promise<{ readonly value: string }>,
): Promise<void> {
  const cursor = await dispatchHostCommand(content, runId, "select-session", {
    sessionId,
  });
  const selected = await waitForResult(
    runId,
    (event) => parsed(event.value)?.session === sessionId,
    { after: cursor },
  );
  expect(parsed(selected.value)).toEqual({ session: sessionId });
}

async function expectSessionNoMatch(
  content: Page,
  runId: string,
  sessionId: string,
  after: DiagnosticCursor,
  dispatchHostCommand: (
    page: Page,
    runId: string,
    command: string,
    options?: {
      readonly sessionId?: string;
      readonly after?: DiagnosticCursor;
    },
  ) => Promise<DiagnosticCursor>,
  waitForResult: (
    runId: string,
    predicate: (event: { readonly value: string }) => boolean,
    options?: { readonly after?: DiagnosticCursor },
  ) => Promise<{ readonly value: string }>,
): Promise<void> {
  const cursor = await dispatchHostCommand(content, runId, "select-session", {
    sessionId,
    after,
  });
  const result = await waitForResult(
    runId,
    (event) => parsed(event.value)?.code === "E_SERVICE_NO_MATCH",
    { after: cursor },
  );
  expect(parsed(result.value)).toEqual({ code: "E_SERVICE_NO_MATCH" });
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
  return JSON.parse(
    await waitForDomValue(hostPage, "#bridge-status", before),
  ) as { readonly command: string; readonly value: string };
}

type ResultEvent = DiagnosticEvent & {
  readonly kind: "result";
  readonly value: string;
};
