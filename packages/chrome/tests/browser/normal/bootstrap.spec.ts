import { fixtureOrigins } from "../harness/targets";
import { expect, test } from "../harness/playwright-fixtures";

test("CE-01/02 loads the generated MV3 fixture with a dynamic ID and injects only allowed origins", async ({
  diagnostics,
  extensionId,
  hostPage,
}) => {
  const negativeRunId = "bootstrap-negative";
  const positiveRunId = "bootstrap-injection";

  expect(extensionId).toMatch(/^[a-p]{32}$/);
  await hostPage.goto(
    `${fixtureOrigins.negative}/host.html?runId=${negativeRunId}`,
  );
  await expect(hostPage.locator("html")).not.toHaveAttribute(
    "data-nexus-e2e-ready",
  );
  await expect(hostPage.locator("#bridge-status")).toHaveText("loading");
  await expect(hostPage.frameLocator("#beta").locator("html")).toHaveAttribute(
    "data-nexus-e2e-ready",
    /^beta:/,
  );

  const negativeEvents = await diagnostics(negativeRunId);
  expect(
    negativeEvents.some((event) => event.participant === "content:main"),
  ).toBe(false);
  expect(
    negativeEvents.some(
      (event) =>
        event.participant === "content:main" &&
        (event.kind === "result" || event.kind === "error"),
    ),
  ).toBe(false);

  await hostPage.goto(
    `${fixtureOrigins.main}/host.html?runId=${positiveRunId}`,
  );
  await expect(hostPage.locator("html")).toHaveAttribute(
    "data-nexus-e2e-ready",
    /^main:/,
  );
  await expect(hostPage.frameLocator("#alpha").locator("html")).toHaveAttribute(
    "data-nexus-e2e-ready",
    /^alpha:/,
  );
  await expect(hostPage.frameLocator("#beta").locator("html")).toHaveAttribute(
    "data-nexus-e2e-ready",
    /^beta:/,
  );
});

test("CE-03 uses the content default target for a public background RPC", async ({
  diagnostics,
  dispatchHostCommand,
  hostPage,
  waitForResult,
}) => {
  const runId = "bootstrap-default-rpc";
  await hostPage.goto(`${fixtureOrigins.main}/host.html?runId=${runId}`);

  const cursor = await dispatchHostCommand(
    hostPage,
    runId,
    "background-summary",
  );
  const result = await waitForResult(
    runId,
    (event) =>
      event.participant === "content:main" &&
      event.value.startsWith("{") &&
      hasWorkspaceSummary(event.value),
    { after: cursor },
  );

  expect(JSON.parse(result.value)).toMatchObject({
    counter: 0,
    setting: "compact",
    generation: expect.any(Number),
    nonce: expect.any(String),
  });
  expect(
    (await diagnostics(runId)).some((event) => event.kind === "error"),
  ).toBe(false);
});

function hasWorkspaceSummary(value: string): boolean {
  try {
    const summary = JSON.parse(value) as Record<string, unknown>;
    return (
      typeof summary.counter === "number" &&
      typeof summary.setting === "string" &&
      typeof summary.generation === "number" &&
      typeof summary.nonce === "string"
    );
  } catch {
    return false;
  }
}
