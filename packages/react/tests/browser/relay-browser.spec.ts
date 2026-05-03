import { expect, test, type Frame, type Page } from "@playwright/test";

async function gotoRelayReady(page: Page) {
  if (!page.url().includes("/relay-host.html")) {
    await page.goto("/relay-host.html");
  }
  await expect
    .poll(() => page.locator("#host-status").textContent())
    .toBe("ready");
  await expect
    .poll(() => getRelayHostTelemetry(page))
    .toMatchObject({
      relayReady: true,
      readyChildren: ["leaf-a", "leaf-b"],
    });
  for (const childId of ["leaf-a", "leaf-b"]) {
    await expect(relayChildFrame(page, childId).locator("#status")).toHaveText(
      "ready",
    );
  }
}

async function getRelayHostTelemetry(page: Page) {
  return page.evaluate(() => (window as any).getRelayHostTelemetry());
}

function relayFrame(page: Page): Frame {
  const frame = page.frame({ url: /relay-frame\.html/ });
  if (!frame) throw new Error("Missing relay frame");
  return frame;
}

function relayChildFrame(page: Page, childId: string): Frame {
  const frame = page.frame({
    url: new RegExp(`relay-child\\.html\\?childId=${childId}`),
  });
  if (!frame) throw new Error(`Missing relay child ${childId}`);
  return frame;
}

test("nested relay topology becomes ready", async ({ page }) => {
  await gotoRelayReady(page);
  expect(relayFrame(page)).toBeDefined();
  expect(relayChildFrame(page, "leaf-a")).toBeDefined();
  expect(relayChildFrame(page, "leaf-b")).toBeDefined();
});

test("nested child calls a host service through the relay frame", async ({
  page,
}) => {
  await gotoRelayReady(page);

  const result = await relayChildFrame(page, "leaf-a").evaluate(() =>
    (window as any).readProfile(),
  );

  expect(result).toEqual({ childId: "leaf-a", servedBy: "host" });
  await expect
    .poll(async () => {
      const telemetry = await getRelayHostTelemetry(page);
      return telemetry.serviceCalls.some(
        (call: { childId: string }) => call.childId === "leaf-a",
      );
    })
    .toBe(true);
  await expect
    .poll(() =>
      relayFrame(page).evaluate(() => {
        const telemetry = (window as any).getRelayFrameTelemetry();
        return telemetry.servicePolicyCalls.map(
          (call: { path: unknown[] }) => call.path,
        );
      }),
    )
    .toContainEqual(["profile", "read"]);

  const servicePolicyPaths = await relayFrame(page).evaluate(() => {
    const telemetry = (window as any).getRelayFrameTelemetry();
    return telemetry.servicePolicyCalls.map(
      (call: { path: unknown[] }) => call.path,
    );
  });

  expect(servicePolicyPaths).not.toContainEqual(["profile", "read", "apply"]);
});

test("nested children converge on host state through the relay store", async ({
  page,
}) => {
  await gotoRelayReady(page);

  const result = await relayChildFrame(page, "leaf-a").evaluate(() =>
    (window as any).increment(3),
  );

  expect(result).toMatchObject({ result: 3, state: { count: 3 } });
  await expect(relayChildFrame(page, "leaf-a").locator("#count")).toHaveText(
    "3",
  );
  await expect(relayChildFrame(page, "leaf-b").locator("#count")).toHaveText(
    "3",
  );
  await expect(
    relayChildFrame(page, "leaf-b").locator("#last-write"),
  ).toHaveText("leaf-a");
  await expect
    .poll(async () => {
      const telemetry = await getRelayHostTelemetry(page);
      return telemetry.dispatchCalls.some(
        (call: { action: string; args: unknown[] }) =>
          call.action === "increment" &&
          JSON.stringify(call.args) === JSON.stringify(["leaf-a", 3]),
      );
    })
    .toBe(true);
});

test("one nested child disconnect does not break sibling relay subscription", async ({
  page,
}) => {
  await gotoRelayReady(page);

  await relayChildFrame(page, "leaf-a").evaluate(() =>
    (window as any).increment(1),
  );

  await relayFrame(page).evaluate(() =>
    (window as any).blankRelayChild("leaf-a"),
  );

  await relayChildFrame(page, "leaf-b").evaluate(() =>
    (window as any).increment(2),
  );
  await expect(relayChildFrame(page, "leaf-b").locator("#count")).toHaveText(
    "3",
  );

  await expect
    .poll(async () => {
      const telemetry = await getRelayHostTelemetry(page);
      return telemetry.dispatchCalls
        .filter(
          (call: { action: string; args: unknown[] }) =>
            call.action === "increment",
        )
        .map((call: { args: unknown[] }) => call.args);
    })
    .toEqual([
      ["leaf-a", 1],
      ["leaf-b", 2],
    ]);

  await relayFrame(page).evaluate(() =>
    (window as any).reconnectRelayChild("leaf-a"),
  );
  await expect(relayChildFrame(page, "leaf-a").locator("#count")).toHaveText(
    "3",
  );
});

test("relay frame reload creates fresh child sessions that converge on host state", async ({
  page,
}) => {
  await gotoRelayReady(page);
  await relayChildFrame(page, "leaf-a").evaluate(() =>
    (window as any).increment(1),
  );

  await page.evaluate(() => (window as any).blankRelayFrame());

  await expect
    .poll(() => getRelayHostTelemetry(page).then((value) => value.relayReady))
    .toBe(false);

  await page.evaluate(() => (window as any).reconnectRelayFrame());
  await gotoRelayReady(page);

  await relayChildFrame(page, "leaf-b").evaluate(() =>
    (window as any).increment(2),
  );
  await expect(relayChildFrame(page, "leaf-a").locator("#count")).toHaveText(
    "3",
  );
});
