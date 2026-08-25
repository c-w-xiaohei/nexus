import { expect } from "@playwright/test";
import { diagnosticCursor, test } from "../harness/playwright-fixtures";

test("closes the MV3 worker target and wakes a fresh worker", async ({
  controller,
  diagnostics,
  dispatchHostCommand,
  extensionId,
  hostPage,
  openExtensionPage,
  waitForBarrier,
  waitForDomValue,
  waitForResult,
}) => {
  const runId = "worker-gate";
  await hostPage.goto(`http://127.0.0.1:4173/host.html?runId=${runId}`);
  await waitForBarrier(runId, "background-ready");
  const summaryCursor = await dispatchHostCommand(
    hostPage,
    runId,
    "background-summary",
  );
  const before = (
    await waitForResult(runId, (event) => event.value.includes("nonce"), {
      after: summaryCursor,
    })
  ).value;
  const previous = await controller.capture(extensionId);
  await dispatchHostCommand(hostPage, runId, "worker-pending");
  await waitForBarrier(runId, "pending-started");
  const beforeCloseCursor = diagnosticCursor(await diagnostics(runId));
  await controller.closeAfterPending(previous);
  const hostBefore = await hostPage
    .locator("#bridge-status")
    .evaluate((element) => (element as HTMLDataElement).value);
  const replacementCursor = await dispatchHostCommand(
    hostPage,
    runId,
    "background-summary",
    { after: beforeCloseCursor },
  );
  const replacement = await controller.capture(extensionId);
  expect(replacement.url).toBe(previous.url);
  const hostAfter = await waitForDomValue(
    hostPage,
    "#bridge-status",
    hostBefore,
  );
  const result = JSON.parse(hostAfter) as { readonly value: string };
  expect(result.value).toContain("nonce");
  expect(result.value).not.toBe(before);
  await openExtensionPage("popup", runId);
  const after = await waitForResult(
    runId,
    (event) => event.value.includes("nonce"),
    { after: replacementCursor },
  );
  expect(after.value).toBe(result.value);
});
