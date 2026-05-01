import { expect, test, type Page } from "@playwright/test";

interface BrowserHarness {
  callCachedChildEcho(frameId: string, value: string): Promise<string>;
  callChildEcho(frameId: string, value: string): Promise<string>;
  getTelemetry(): {
    parentCalls: Array<{ frameId: string; value: string }>;
    childCalls: Array<{ frameId: string; value: string }>;
    readyFrames: string[];
  };
  reloadFrame(frameId: string): Promise<void>;
}

interface ChildHarness {
  callParentEcho(value: string): Promise<string>;
  makeUnresponsive(): void;
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
  const frame = page.frame({ url: new RegExp(`frameId=${frameId}`) });
  if (!frame) throw new Error(`Missing child frame ${frameId}`);
  return frame.evaluate(
    (input) => (window as unknown as ChildHarness).callParentEcho(input),
    value,
  );
}

async function makeChildUnresponsive(page: Page, frameId: string) {
  const frame = page.frame({ url: new RegExp(`frameId=${frameId}`) });
  if (!frame) throw new Error(`Missing child frame ${frameId}`);
  await frame.evaluate(() =>
    (window as unknown as ChildHarness).makeUnresponsive(),
  );
}

async function postSpoofedConnectFromChild(
  page: Page,
  frameId: string,
  options: { channel?: string; nonce?: string },
) {
  const frame = page.frame({ url: new RegExp(`frameId=${frameId}`) });
  if (!frame) throw new Error(`Missing child frame ${frameId}`);
  await frame.evaluate((spoofOptions) => {
    window.parent.postMessage(
      {
        __nexusIframe: true,
        appId: "browser-app",
        channel: spoofOptions.channel ?? "nexus:iframe",
        nonce: spoofOptions.nonce ?? "browser-nonce-alpha",
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
  }, options);
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

  await postSpoofedConnectFromChild(page, "alpha", {
    channel: "wrong-channel",
  });
  await postSpoofedConnectFromChild(page, "alpha", { nonce: "wrong-nonce" });

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

  await expect
    .poll(async () => {
      try {
        return await callChildEcho(page, "alpha", "after-reload");
      } catch {
        return "rejected";
      }
    })
    .toBe("child:alpha:after-reload");
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

  await makeChildUnresponsive(page, "alpha");

  await expect
    .poll(async () => {
      try {
        await callCachedChildEcho(page, "alpha", "after-disconnect");
        return "resolved";
      } catch {
        return "rejected";
      }
    })
    .toBe("rejected");

  await page.evaluate(() =>
    (window as unknown as BrowserHarness).reloadFrame("alpha"),
  );
  await expect
    .poll(() => getTelemetry(page).then((telemetry) => telemetry.readyFrames))
    .toContain("alpha");

  await expect
    .poll(async () => {
      try {
        return await callChildEcho(page, "alpha", "after-reload");
      } catch {
        return "rejected";
      }
    })
    .toBe("child:alpha:after-reload");
});

test("isolates cross-origin iframe routes by frame id", async ({ page }) => {
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

test("documents native browser drop for wrong targetOrigin messages", async ({
  page,
}) => {
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

test("ignores messages from a non-iframe source", async ({ page }) => {
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
