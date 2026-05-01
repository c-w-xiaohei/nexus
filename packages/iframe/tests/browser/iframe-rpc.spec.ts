import { expect, test, type Page } from "@playwright/test";

interface BrowserHarness {
  callCachedChildEcho(frameId: string, value: string): Promise<string>;
  callChildEcho(frameId: string, value: string): Promise<string>;
  callParentEcho(frameId: string, value: string): Promise<string>;
  getTelemetry(): {
    parentCalls: Array<{ frameId: string; value: string }>;
    childCalls: Array<{ frameId: string; value: string }>;
    readyFrames: string[];
  };
  reloadFrame(frameId: string): Promise<void>;
  sendSpoofedConnect(options: { channel?: string; nonce?: string }): void;
  makeChildUnresponsive(frameId: string): void;
  hasConnectionToFrame(frameId: string): boolean;
}

async function waitForReadyFrames(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as BrowserHarness).getTelemetry().readyFrames.sort(),
      ),
    )
    .toEqual(["alpha", "beta"]);
}

async function callChildEcho(page: Page, frameId: string, value: string) {
  return page.evaluate(
    ([targetFrameId, input]) =>
      (window as unknown as BrowserHarness).callChildEcho(targetFrameId, input),
    [frameId, value] as const,
  );
}

async function callCachedChildEcho(page: Page, frameId: string, value: string) {
  return page.evaluate(
    ([targetFrameId, input]) =>
      (window as unknown as BrowserHarness).callCachedChildEcho(
        targetFrameId,
        input,
      ),
    [frameId, value] as const,
  );
}

async function callParentEcho(page: Page, frameId: string, value: string) {
  return page.evaluate(
    ([targetFrameId, input]) =>
      (window as unknown as BrowserHarness).callParentEcho(
        targetFrameId,
        input,
      ),
    [frameId, value] as const,
  );
}

async function getTelemetry(page: Page) {
  return page.evaluate(() =>
    (window as unknown as BrowserHarness).getTelemetry(),
  );
}

test("calls a child Nexus service through a real iframe boundary", async ({
  page,
}) => {
  await page.goto("/parent.html");

  await expect.poll(() => page.evaluate(() => window.frames.length)).toBe(2);
  await waitForReadyFrames(page);

  await expect(callChildEcho(page, "alpha", "hello")).resolves.toBe(
    "child:alpha:hello",
  );

  await expect(callChildEcho(page, "alpha", "again")).resolves.toBe(
    "child:alpha:again",
  );

  await expect(callChildEcho(page, "beta", "hello")).resolves.toBe(
    "child:beta:hello",
  );

  await expect(
    getTelemetry(page).then((telemetry) => telemetry.childCalls),
  ).resolves.toEqual([
    { frameId: "alpha", value: "hello" },
    { frameId: "alpha", value: "again" },
    { frameId: "beta", value: "hello" },
  ]);
});

test("child iframe calls a parent Nexus service with frame routing metadata", async ({
  page,
}) => {
  await page.goto("/parent.html");
  await waitForReadyFrames(page);

  await expect(callParentEcho(page, "alpha", "from-child")).resolves.toBe(
    "parent:alpha:from-child",
  );

  await expect(callParentEcho(page, "beta", "from-child")).resolves.toBe(
    "parent:beta:from-child",
  );

  await expect(
    getTelemetry(page).then((telemetry) => telemetry.parentCalls),
  ).resolves.toEqual([
    { frameId: "alpha", value: "from-child" },
    { frameId: "beta", value: "from-child" },
  ]);
});

test("rejects wrong channel and nonce connect messages without accepting spoofed calls", async ({
  page,
}) => {
  await page.goto("/parent.html");
  await waitForReadyFrames(page);

  await page.evaluate(() =>
    (window as unknown as BrowserHarness).sendSpoofedConnect({
      channel: "wrong-channel",
    }),
  );
  await page.evaluate(() =>
    (window as unknown as BrowserHarness).sendSpoofedConnect({
      nonce: "wrong-nonce",
    }),
  );

  await expect(
    getTelemetry(page).then((telemetry) => telemetry.readyFrames.sort()),
  ).resolves.toEqual(["alpha", "beta"]);
  await expect(
    getTelemetry(page).then((telemetry) => telemetry.parentCalls),
  ).resolves.toEqual([]);

  await expect(callChildEcho(page, "alpha", "after-spoof")).resolves.toBe(
    "child:alpha:after-spoof",
  );
});

test("reconnects to a reloaded iframe and keeps routing isolated", async ({
  page,
}) => {
  await page.goto("/parent.html");
  await waitForReadyFrames(page);

  await expect(callChildEcho(page, "alpha", "before-reload")).resolves.toBe(
    "child:alpha:before-reload",
  );

  await page.evaluate(() =>
    (window as unknown as BrowserHarness).reloadFrame("alpha"),
  );

  await expect
    .poll(() => getTelemetry(page).then((telemetry) => telemetry.readyFrames))
    .toContain("alpha");

  await expect(callChildEcho(page, "alpha", "after-reload")).resolves.toBe(
    "child:alpha:after-reload",
  );
  await expect(callChildEcho(page, "beta", "still-connected")).resolves.toBe(
    "child:beta:still-connected",
  );
});

test("detects an unresponsive iframe through virtual port heartbeat and reconnects after reload", async ({
  page,
}) => {
  await page.goto("/parent.html");
  await waitForReadyFrames(page);

  await expect(callCachedChildEcho(page, "alpha", "before-hang")).resolves.toBe(
    "child:alpha:before-hang",
  );

  await page.evaluate(() =>
    (window as unknown as BrowserHarness).makeChildUnresponsive("alpha"),
  );

  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as BrowserHarness).hasConnectionToFrame("alpha"),
      ),
    )
    .toBe(false);
  await expect(
    callCachedChildEcho(page, "alpha", "after-disconnect"),
  ).rejects.toThrow();

  await page.evaluate(() =>
    (window as unknown as BrowserHarness).reloadFrame("alpha"),
  );
  await expect
    .poll(() => getTelemetry(page).then((telemetry) => telemetry.readyFrames))
    .toContain("alpha");

  await expect(callChildEcho(page, "alpha", "after-reload")).resolves.toBe(
    "child:alpha:after-reload",
  );
});

test("isolates same-origin iframe routes by frame id", async ({ page }) => {
  await page.goto("/parent.html");
  await waitForReadyFrames(page);

  await expect(callChildEcho(page, "alpha", "route")).resolves.toBe(
    "child:alpha:route",
  );
  await expect(callChildEcho(page, "beta", "route")).resolves.toBe(
    "child:beta:route",
  );
  await expect(callParentEcho(page, "alpha", "route")).resolves.toBe(
    "parent:alpha:route",
  );
  await expect(callParentEcho(page, "beta", "route")).resolves.toBe(
    "parent:beta:route",
  );
});

test("does not accept wrong targetOrigin messages", async ({ page }) => {
  await page.goto("/parent.html");
  await waitForReadyFrames(page);

  await page.evaluate(() => {
    window.postMessage(
      {
        __nexusIframe: true,
        appId: "browser-app",
        channel: "nexus:iframe",
        nonce: "browser-nonce-alpha",
        payload: {
          __nexusVirtualPort: true,
          version: 1,
          type: "connect",
          channelId: "wrong-origin-channel",
          from: "attacker",
          nonce: "attacker-nonce",
        },
      },
      "http://localhost:3210",
    );
  });

  await expect(
    getTelemetry(page).then((telemetry) => telemetry.parentCalls),
  ).resolves.toEqual([]);
  await expect(callChildEcho(page, "alpha", "after-origin")).resolves.toBe(
    "child:alpha:after-origin",
  );
});

test("ignores same-origin messages from a non-iframe source", async ({
  page,
}) => {
  await page.goto("/parent.html");
  await waitForReadyFrames(page);

  const before = await callChildEcho(page, "alpha", "before");
  expect(before).toBe("child:alpha:before");

  await page.evaluate(() => {
    window.postMessage(
      {
        __nexusIframe: true,
        appId: "browser-app",
        channel: "nexus:iframe",
        nonce: "browser-nonce-alpha",
        payload: {
          __nexusVirtualPort: true,
          version: 1,
          type: "connect",
          channelId: "attacker-channel",
          from: "attacker",
          nonce: "attacker-nonce",
        },
      },
      "http://127.0.0.1:3210",
    );
  });

  await expect(
    getTelemetry(page).then((telemetry) => telemetry.parentCalls),
  ).resolves.toEqual([]);
  await expect(callChildEcho(page, "alpha", "after")).resolves.toBe(
    "child:alpha:after",
  );
});
