import type { Frame, Page } from "@playwright/test";
import { fixtureOrigins } from "../harness/targets";
import {
  expect,
  test,
  waitForHostBridgeResult,
} from "../harness/playwright-fixtures";
import { parseBridgeResult } from "../protocol";

test("addressed pages route background, content, and page-to-page calls exactly", async ({
  hostPage,
  openExtensionPage,
  waitForBarrier,
}) => {
  const runId = "addressed-pages-routing";
  await openFixture(hostPage, runId, waitForBarrier);

  const alpha = await openExtensionPage("addressed", runId, {
    endpointId: "alpha",
  });
  const beta = await openExtensionPage("addressed", runId, {
    endpointId: "beta",
  });

  const backgroundToAlpha = await contentCommand(
    hostPage,
    frameByName(hostPage, "main"),
    runId,
    "addressed-call-alpha",
  );
  expect(JSON.parse(backgroundToAlpha)).toMatchObject({
    endpointId: "alpha",
  });

  const backgroundToBeta = await contentCommand(
    hostPage,
    frameByName(hostPage, "main"),
    runId,
    "addressed-call-beta",
  );
  expect(JSON.parse(backgroundToBeta)).toMatchObject({ endpointId: "beta" });

  const concurrent = JSON.parse(
    await contentCommand(
      hostPage,
      frameByName(hostPage, "main"),
      runId,
      "addressed-call-alpha-twice",
    ),
  ) as readonly { readonly endpointId: string; readonly sessionId: string }[];
  expect(concurrent).toHaveLength(2);
  expect(concurrent[0]).toEqual(concurrent[1]);

  await addressedCommand(beta, runId, "raw-unrelated-port");
  const selectedAfterRawPort = await contentCommand(
    hostPage,
    frameByName(hostPage, "main"),
    runId,
    "addressed-call-alpha",
  );
  expect(JSON.parse(selectedAfterRawPort)).toMatchObject({
    endpointId: "alpha",
  });

  await beta.close();
  const selectedAfterNonTargetClose = await contentCommand(
    hostPage,
    frameByName(hostPage, "main"),
    runId,
    "addressed-call-alpha",
  );
  expect(JSON.parse(selectedAfterNonTargetClose)).toMatchObject({
    endpointId: "alpha",
  });

  await alpha.close();
  await beta.close();
});

test("an exact addressed target isolates Nexus and provider activity from receiver fan-out", async ({
  hostPage,
  openExtensionPage,
  waitForBarrier,
}) => {
  const runId = "addressed-pages-exact-isolation";
  await openFixture(hostPage, runId, waitForBarrier);
  const alpha = await openExtensionPage("addressed", runId, {
    endpointId: "alpha",
  });
  const beta = await openExtensionPage("addressed", runId, {
    endpointId: "beta",
  });
  const gamma = await openExtensionPage("addressed", runId, {
    endpointId: "gamma",
  });

  const before = await Promise.all(
    [alpha, beta, gamma].map((page) =>
      addressedCommand(page, runId, "metrics"),
    ),
  );
  const result = JSON.parse(
    await contentCommand(
      hostPage,
      frameByName(hostPage, "main"),
      runId,
      "addressed-call-alpha",
    ),
  ) as { readonly endpointId: string };
  expect(result.endpointId).toBe("alpha");

  const after = await Promise.all(
    [alpha, beta, gamma].map((page) =>
      addressedCommand(page, runId, "metrics"),
    ),
  );
  const labels = ["alpha", "beta", "gamma"] as const;
  const rawCounts = after.map((metrics, index) => ({
    endpointId: labels[index],
    before: before[index].nativeOnConnectCount,
    after: metrics.nativeOnConnectCount,
  }));
  test.info().annotations.push({
    type: "raw-native-runtime-onConnect-counts",
    description: JSON.stringify(rawCounts),
  });

  expect(after[0].nexusReadyOnConnectCount).toBe(
    before[0].nexusReadyOnConnectCount + 1,
  );
  expect(after[0].providerInvocationCount).toBe(
    before[0].providerInvocationCount + 1,
  );
  expect(after[1].nexusReadyOnConnectCount).toBe(
    before[1].nexusReadyOnConnectCount,
  );
  expect(after[2].nexusReadyOnConnectCount).toBe(
    before[2].nexusReadyOnConnectCount,
  );
  expect(after[1].providerInvocationCount).toBe(
    before[1].providerInvocationCount,
  );
  expect(after[2].providerInvocationCount).toBe(
    before[2].providerInvocationCount,
  );

  const rawReceiverPages = rawCounts.filter(
    ({ before: beforeCount, after: afterCount }) => afterCount > beforeCount,
  );
  if (rawReceiverPages.length > 1) {
    // Some Chromium builds expose the native Port fan-out. Core must still
    // admit only the exact endpoint and invoke only that endpoint's provider.
    expect(rawReceiverPages.length).toBeGreaterThan(1);
  } else {
    // On builds without observable raw fan-out, assert the stronger adapter
    // invariant rather than manufacturing a fan-out observation.
    expect(rawCounts[1].after).toBe(rawCounts[1].before);
    expect(rawCounts[2].after).toBe(rawCounts[2].before);
  }

  await alpha.close();
  await beta.close();
  await gamma.close();
});

test("an absent addressed target times out without Nexus or provider activity on other pages", async ({
  hostPage,
  openExtensionPage,
  waitForBarrier,
}) => {
  const runId = "addressed-pages-target-absent";
  await openFixture(hostPage, runId, waitForBarrier);
  const beta = await openExtensionPage("addressed", runId, {
    endpointId: "beta",
  });
  const gamma = await openExtensionPage("addressed", runId, {
    endpointId: "gamma",
  });
  const before = await Promise.all(
    [beta, gamma].map((page) => addressedCommand(page, runId, "metrics")),
  );

  const result = JSON.parse(
    await contentCommand(
      hostPage,
      frameByName(hostPage, "main"),
      runId,
      "addressed-call-absent",
    ),
  ) as { readonly code: string };
  expect(result.code).toBe("E_SERVICE_ACQUISITION_TIMEOUT");

  const after = await Promise.all(
    [beta, gamma].map((page) => addressedCommand(page, runId, "metrics")),
  );
  test.info().annotations.push({
    type: "absent-target-raw-native-runtime-onConnect-counts",
    description: JSON.stringify(
      after.map((metrics, index) => ({
        endpointId: ["beta", "gamma"][index],
        before: before[index].nativeOnConnectCount,
        after: metrics.nativeOnConnectCount,
      })),
    ),
  });
  for (const [beforeMetrics, afterMetrics] of before.map(
    (value, index) => [value, after[index]] as const,
  )) {
    expect(afterMetrics.nexusReadyOnConnectCount).toBe(
      beforeMetrics.nexusReadyOnConnectCount,
    );
    expect(afterMetrics.providerInvocationCount).toBe(
      beforeMetrics.providerInvocationCount,
    );
  }

  await beta.close();
  await gamma.close();
});

test("different exact addressed targets get different Core IDs and alpha reacquisition reuses its ID", async ({
  hostPage,
  openExtensionPage,
  waitForBarrier,
}) => {
  const runId = "addressed-pages-connection-ids";
  await openFixture(hostPage, runId, waitForBarrier);
  const alpha = await openExtensionPage("addressed", runId, {
    endpointId: "alpha",
  });
  const beta = await openExtensionPage("addressed", runId, {
    endpointId: "beta",
  });
  const main = frameByName(hostPage, "main");

  const alphaFirst = JSON.parse(
    await contentCommand(hostPage, main, runId, "addressed-call-alpha"),
  ) as { readonly connectionId: string; readonly endpointId: string };
  const betaConnection = JSON.parse(
    await contentCommand(hostPage, main, runId, "addressed-call-beta"),
  ) as { readonly connectionId: string; readonly endpointId: string };
  const alphaAgain = JSON.parse(
    await contentCommand(hostPage, main, runId, "addressed-call-alpha"),
  ) as { readonly connectionId: string; readonly endpointId: string };

  expect(alphaFirst.endpointId).toBe("alpha");
  expect(betaConnection.endpointId).toBe("beta");
  expect(alphaAgain.endpointId).toBe("alpha");
  expect(alphaFirst.connectionId).not.toBe(betaConnection.connectionId);
  expect(alphaAgain.connectionId).toBe(alphaFirst.connectionId);

  await alpha.close();
  await beta.close();
});

test("closing a selected addressed page invalidates its retained connection", async ({
  openExtensionPage,
}) => {
  const runId = "addressed-pages-target-close";
  const alpha = await openExtensionPage("addressed", runId, {
    endpointId: "alpha",
  });
  const beta = await openExtensionPage("addressed", runId, {
    endpointId: "beta",
  });

  const retained = await addressedCommand(alpha, runId, "retain-peer", {
    endpointId: "beta",
  });
  expect(retained).toMatchObject({ endpointId: "beta" });
  await beta.close();

  const closed = await addressedCommand(alpha, runId, "invoke-retained-peer");
  expect(closed).toEqual({ code: "E_CONN_CLOSED" });

  const replacement = await openExtensionPage("addressed", runId, {
    endpointId: "beta",
  });
  const replacementCall = await addressedCommand(alpha, runId, "call-peer", {
    endpointId: "beta",
  });
  expect(replacementCall).toMatchObject({ endpointId: "beta" });
  await alpha.close();
  await replacement.close();
});

test("an addressed extension page can dial the exact main-frame content script", async ({
  hostPage,
  openExtensionPage,
  waitForBarrier,
}) => {
  const runId = "addressed-pages-page-to-content";
  await openFixture(hostPage, runId, waitForBarrier);
  const alpha = await openExtensionPage("addressed", runId, {
    endpointId: "alpha",
  });

  const pageToContent = await addressedCommand(alpha, runId, "call-content");
  expect(pageToContent).toMatchObject({ label: "main" });
  await alpha.close();
});

test("an addressed extension page can dial another addressed extension page", async ({
  openExtensionPage,
}) => {
  const runId = "addressed-pages-page-to-page";
  const alpha = await openExtensionPage("addressed", runId, {
    endpointId: "alpha",
  });
  const beta = await openExtensionPage("addressed", runId, {
    endpointId: "beta",
  });

  const result = await addressedCommand(alpha, runId, "call-peer", {
    endpointId: "beta",
  });
  expect(result).toMatchObject({ endpointId: "beta" });
  await alpha.close();
  await beta.close();
});

test("concurrent acquisition of one addressed target reuses one native session", async ({
  hostPage,
  openExtensionPage,
  waitForBarrier,
}) => {
  const runId = "addressed-pages-reuse";
  await openFixture(hostPage, runId, waitForBarrier);
  const alpha = await openExtensionPage("addressed", runId, {
    endpointId: "alpha",
  });
  const main = frameByName(hostPage, "main");

  const first = JSON.parse(
    await contentCommand(hostPage, main, runId, "addressed-call-alpha"),
  ) as { readonly connectionId: string };
  const before = await addressedCommand(alpha, runId, "metrics");

  const concurrent = JSON.parse(
    await contentCommand(hostPage, main, runId, "addressed-call-alpha-twice"),
  ) as readonly { readonly connectionId: string }[];
  expect(concurrent).toHaveLength(2);
  expect(concurrent[0].connectionId).toBe(first.connectionId);
  expect(concurrent[1].connectionId).toBe(first.connectionId);
  const after = await addressedCommand(alpha, runId, "metrics");
  expect(after.nativeOnConnectCount).toBe(before.nativeOnConnectCount);
  expect(after.nexusReadyOnConnectCount).toBe(before.nexusReadyOnConnectCount);
  expect(after.connectionIds).toEqual(before.connectionIds);
  await alpha.close();
});

test("content scripts dial an exact addressed page and the side-panel entrypoint smoke loads directly", async ({
  hostPage,
  openExtensionPage,
  waitForBarrier,
}) => {
  const runId = "addressed-pages-content-sidepanel";
  await openFixture(hostPage, runId, waitForBarrier);
  const addressed = await openExtensionPage("addressed", runId, {
    endpointId: "alpha",
  });

  const contentToPage = await contentCommand(
    hostPage,
    frameByName(hostPage, "main"),
    runId,
    "addressed-direct-alpha",
  );
  expect(JSON.parse(contentToPage)).toMatchObject({ endpointId: "alpha" });

  // This is an entrypoint smoke only. It does not exercise Chrome's actual
  // Side Panel UI lifecycle or provide a structural coordinate.
  const sidePanel = await openExtensionPage("sidepanel", runId);
  await expect(sidePanel.locator("[data-status]")).toContainText(
    "sidepanel:ready:",
  );
  await addressed.close();
  await sidePanel.close();
});

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

async function contentCommand(
  hostPage: Page,
  frame: Frame,
  runId: string,
  command: string,
): Promise<string> {
  const sequence = await dispatchToFrame(frame, runId, command);
  const value = await waitForHostBridgeResult(hostPage, {
    runId,
    command,
    sequence,
    participant: `content:${frame === hostPage.mainFrame() ? "main" : "main"}`,
  });
  const result = parseBridgeResult(value, { runId, command, sequence });
  if (!result) throw new Error(`Missing correlated result for ${command}`);
  return result.value;
}

async function addressedCommand(
  page: Page,
  runId: string,
  command: string,
  detail: Record<string, string> = {},
): Promise<any> {
  const output = page.locator("[data-result]");
  const before = await output.getAttribute("data-sequence");
  await page.evaluate(
    ({ command, detail, runId }) =>
      window.dispatchEvent(
        new CustomEvent("nexus-addressed-command", {
          detail: { command, runId, ...detail },
        }),
      ),
    { command, detail, runId },
  );
  await expect
    .poll(() => output.getAttribute("data-sequence"))
    .not.toBe(before);
  const value = await output.evaluate(
    (element) => (element as HTMLOutputElement).value,
  );
  const result = JSON.parse(value) as {
    readonly ok: boolean;
    readonly value?: unknown;
    readonly code?: string;
  };
  if (!result.ok) return { code: result.code };
  return result.value;
}

const frameSequences = new WeakMap<Frame, number>();

async function dispatchToFrame(
  frame: Frame,
  runId: string,
  command: string,
): Promise<number> {
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
  return sequence;
}

function frameByName(page: Page, name: string): Frame {
  if (name === "main") return page.mainFrame();
  const frame = page
    .frames()
    .find((candidate) => candidate.url().includes(`frame=${name}`));
  if (!frame) throw new Error(`Fixture frame ${name} was not found`);
  return frame;
}
