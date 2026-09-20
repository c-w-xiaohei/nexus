import type { BrowserContext, Page } from "@playwright/test";
import {
  diagnosticCursor,
  expect,
  test,
  type DiagnosticCursor,
} from "../harness/playwright-fixtures";
import type { DiagnosticEvent } from "../protocol";

type SidePanelCall = {
  readonly connectionId: string;
  readonly receiver: {
    readonly participant: string;
    readonly sessionId: string;
  };
};

test("real Chrome Side Panel opens, closes, disconnects, and reopens", async ({
  launch,
  openExtensionPage,
  diagnostics,
  waitForEvent,
}) => {
  const runId = "sidepanel-real-lifecycle";
  const popup = await openExtensionPage("popup", runId);
  const feature = await popup.evaluate(() => ({
    close: typeof chrome.sidePanel?.close === "function",
    events:
      typeof chrome.sidePanel?.onOpened?.addListener === "function" &&
      typeof chrome.sidePanel?.onClosed?.addListener === "function",
  }));
  if (!feature.close || !feature.events) {
    test.info().annotations.push({
      type: "feature-gate",
      description:
        "Requires Chrome sidePanel.close(), onOpened, and onClosed (Chrome 142+).",
    });
    test.skip(true, "Chrome Side Panel lifecycle events are unavailable");
  }

  let cursor = diagnosticCursor(await diagnostics(runId));
  await clickPopupCommand(popup, "sidepanel-open");
  const popupWindowId = await popup.evaluate(
    async () => (await chrome.windows.getCurrent()).id,
  );
  const firstOpened = await waitForResult(
    waitForEvent,
    runId,
    cursor,
    "sidepanel-opened",
    "background",
  );
  expect(firstOpened).toMatchObject({
    path: "/sidepanel.html",
    windowId: popupWindowId,
  });
  await waitForBarrierEvent(
    waitForEvent,
    runId,
    cursor,
    "provider-live",
    "sidepanel",
  );

  const firstTarget = await waitForSidePanelTarget(
    launch.context,
    launch.extensionId,
  );
  expect(firstTarget.url).toBe(
    `chrome-extension://${launch.extensionId}/sidepanel.html`,
  );
  expect(firstTarget.type).toBe("page");

  const firstCall = (await callPopupCommand(
    popup,
    "sidepanel-call",
  )) as unknown as SidePanelCall;
  expect(firstCall).toMatchObject({
    receiver: { participant: "sidepanel" },
  });
  expect(firstCall.connectionId).toEqual(expect.any(String));
  expect(firstCall.receiver.sessionId).toEqual(expect.any(String));
  const firstConnectionId = firstCall.connectionId as string;
  const firstSessionId = firstCall.receiver.sessionId as string;

  cursor = diagnosticCursor(await diagnostics(runId));
  await clickPopupCommand(popup, "sidepanel-close");
  const firstClosed = await waitForResult(
    waitForEvent,
    runId,
    cursor,
    "sidepanel-closed",
    "background",
  );
  expect(firstClosed).toMatchObject({
    path: "/sidepanel.html",
    windowId: popupWindowId,
  });
  await waitForTargetToDisappear(
    launch.context,
    launch.extensionId,
    firstTarget.targetId,
  );

  const retained = await callPopupCommand(popup, "sidepanel-retained-call");
  expect(retained).toEqual({ code: "E_CONN_CLOSED" });

  cursor = diagnosticCursor(await diagnostics(runId));
  await clickPopupCommand(popup, "sidepanel-open");
  const secondOpened = await waitForResult(
    waitForEvent,
    runId,
    cursor,
    "sidepanel-opened",
    "background",
  );
  expect(secondOpened).toMatchObject({
    path: "/sidepanel.html",
    windowId: popupWindowId,
  });
  const secondReady = await waitForBarrierEvent(
    waitForEvent,
    runId,
    cursor,
    "provider-live",
    "sidepanel",
  );
  expect(secondReady.sessionId).not.toBe(firstSessionId);

  const secondTarget = await waitForSidePanelTarget(
    launch.context,
    launch.extensionId,
  );
  expect(secondTarget.targetId).not.toBe(firstTarget.targetId);
  const secondCall = (await callPopupCommand(
    popup,
    "sidepanel-call",
  )) as unknown as SidePanelCall;
  expect(secondCall).toMatchObject({
    receiver: { participant: "sidepanel" },
  });
  expect(secondCall.connectionId).not.toBe(firstConnectionId);
  expect(secondCall.receiver.sessionId).not.toBe(firstSessionId);
});

async function clickPopupCommand(page: Page, command: string): Promise<void> {
  await page.locator(`[data-command="${command}"]`).click();
}

async function callPopupCommand(
  page: Page,
  command: string,
): Promise<Record<string, unknown>> {
  const output = page.locator("[data-result]");
  const before = await output.getAttribute("data-sequence");
  await clickPopupCommand(page, command);
  await expect
    .poll(() => output.getAttribute("data-sequence"))
    .not.toBe(before);
  const value = await output.evaluate((element) =>
    element instanceof HTMLOutputElement ? element.value : "",
  );
  const result = JSON.parse(value) as {
    readonly value?: string;
    readonly kind?: string;
  };
  if (result.kind !== "result" || typeof result.value !== "string") {
    throw new Error(`Side Panel command failed: ${value}`);
  }
  return JSON.parse(result.value) as Record<string, unknown>;
}

async function waitForResult(
  waitForEvent: (
    runId: string,
    predicate: (event: DiagnosticEvent) => boolean,
    options?: { readonly after?: DiagnosticCursor },
  ) => Promise<readonly DiagnosticEvent[]>,
  runId: string,
  after: DiagnosticCursor,
  type: string,
  participant: string,
): Promise<Record<string, unknown>> {
  const events = await waitForEvent(
    runId,
    (candidate) =>
      candidate.kind === "result" &&
      candidate.participant === participant &&
      parseValue(candidate.value)?.type === type,
    { after },
  );
  const event = events[0];
  return event?.kind === "result" ? (parseValue(event.value) ?? {}) : {};
}

async function waitForBarrierEvent(
  waitForEvent: (
    runId: string,
    predicate: (event: DiagnosticEvent) => boolean,
    options?: { readonly after?: DiagnosticCursor },
  ) => Promise<readonly DiagnosticEvent[]>,
  runId: string,
  after: DiagnosticCursor,
  name: string,
  participant: string,
): Promise<DiagnosticEvent> {
  const events = await waitForEvent(
    runId,
    (candidate) =>
      candidate.kind === "barrier" &&
      candidate.name === name &&
      candidate.participant === participant,
    { after },
  );
  return events[0] as DiagnosticEvent;
}

async function waitForSidePanelTarget(
  context: BrowserContext,
  extensionId: string,
): Promise<{
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
}> {
  const browser = context.browser();
  if (!browser) throw new Error("Persistent context has no browser");
  const cdp = await browser.newBrowserCDPSession();
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const { targetInfos } = await cdp.send("Target.getTargets");
      const target = targetInfos.find(
        (candidate) =>
          candidate.type === "page" &&
          candidate.url === `chrome-extension://${extensionId}/sidepanel.html`,
      );
      if (target) {
        return {
          targetId: target.targetId,
          type: target.type,
          url: target.url,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await cdp.detach();
  }
  throw new Error("Real Chrome Side Panel target was not found");
}

async function waitForTargetToDisappear(
  context: BrowserContext,
  _extensionId: string,
  targetId: string,
): Promise<void> {
  const browser = context.browser();
  if (!browser) throw new Error("Persistent context has no browser");
  const cdp = await browser.newBrowserCDPSession();
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const { targetInfos } = await cdp.send("Target.getTargets");
      if (!targetInfos.some((candidate) => candidate.targetId === targetId))
        return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await cdp.detach();
  }
  throw new Error("Closed Side Panel target remained present");
}

function parseValue(
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
