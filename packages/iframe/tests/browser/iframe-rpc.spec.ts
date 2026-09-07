import { expect, test, type Page } from "@playwright/test";

interface BrowserHarness {
  callConnectToSelectedChild(value: string): Promise<string>;
  callCachedChildEcho(frameId: string, value: string): Promise<string>;
  callChildEcho(frameId: string, value: string): Promise<string>;
  getTelemetry(): {
    parentCalls: Array<{ frameId: string; value: string }>;
    childCalls: Array<{ frameId: string; value: string }>;
    binaryDataEnvelopes: number;
    loadedFrames: string[];
    parentConnectAttempts: number;
    selectResolved: boolean;
  };
  reloadFrame(frameId: string): Promise<void>;
  startConnectToSelection(bootstrap?: string): Promise<void>;
  selectConnectToChild(): void;
}

interface ChildHarness {
  callParentEcho(value: string): Promise<string>;
  getTelemetry(): { binaryDataEnvelopes: number };
  makeUnresponsive(): void;
}

async function waitForLoadedFrames(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as BrowserHarness)
          .getTelemetry()
          .loadedFrames.sort(),
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

async function getChildTelemetry(page: Page, frameId: string) {
  const frame = page.frame({ url: new RegExp(`frameId=${frameId}`) });
  if (!frame) throw new Error(`Missing child frame ${frameId}`);
  return frame.evaluate(() =>
    (window as unknown as ChildHarness).getTelemetry(),
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
  await waitForLoadedFrames(page);

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

test("select waits for a child connectTo provider without parent demand", async ({
  page,
}) => {
  let releaseChild: (() => void) | undefined;
  const childRequest = new Promise<void>((resolve) => {
    void page.route(
      /http:\/\/127\.0\.0\.1:3211\/child\.html\?.*mode=connect-to/,
      async (route) => {
        resolve();
        await new Promise<void>((release) => {
          releaseChild = release;
        });
        await route.continue();
      },
    );
  });

  await page.goto("/parent.html?mode=connect-to");
  await page.evaluate(() =>
    (window as unknown as BrowserHarness).startConnectToSelection(),
  );
  await childRequest;

  expect(await getTelemetry(page)).toMatchObject({
    parentConnectAttempts: 0,
    selectResolved: false,
  });

  if (!releaseChild) throw new Error("Child request was not intercepted");
  releaseChild();
  await expect
    .poll(() =>
      getTelemetry(page).then((telemetry) => telemetry.selectResolved),
    )
    .toBe(true);
  await expect(
    page.evaluate(() =>
      (window as unknown as BrowserHarness).callConnectToSelectedChild(
        "connect-to",
      ),
    ),
  ).resolves.toBe("child:alpha:connect-to");
  expect((await getTelemetry(page)).parentConnectAttempts).toBe(0);
});

test("startup connection survives a child whose initial load finishes after bootstrap", async ({
  page,
}) => {
  let finishLoad!: () => void;
  const loading = new Promise<void>((resolve) => {
    finishLoad = resolve;
  });
  await page.route("**/hold-child-load.svg", async (route) => {
    await loading;
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
  });
  await page.route(/child\.html\?.*mode=connect-to/, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({
      response,
      body: body.replace("</body>", '<img src="/hold-child-load.svg"></body>'),
    });
  });
  await page.goto("/parent.html?mode=connect-to");
  await page.evaluate(() =>
    (window as unknown as BrowserHarness).startConnectToSelection(),
  );
  try {
    await expect
      .poll(() => getTelemetry(page).then((value) => value.loadedFrames))
      .toContain("alpha");
    const frame = page.frame({ url: /frameId=alpha/ });
    if (!frame) throw new Error("Missing child iframe");
    await frame.evaluate(() =>
      (
        window as unknown as { childNexus: { ready(): Promise<void> } }
      ).childNexus.ready(),
    );
    expect(await frame.evaluate(() => document.readyState)).not.toBe(
      "complete",
    );
    expect((await getTelemetry(page)).selectResolved).toBe(false);
    // The child is locally ready, but its connection must not race the parent's
    // mandatory router reset on this document's iframe load event.
    const loaded = frame.waitForLoadState("load");
    finishLoad();
    await loaded;
    const result = await page.evaluate(() =>
      (window as unknown as BrowserHarness).callConnectToSelectedChild(
        "after-load",
      ),
    );
    expect(result).toBe("child:alpha:after-load");
    expect((await getTelemetry(page)).parentConnectAttempts).toBe(0);
  } finally {
    finishLoad();
  }
});

for (const bootstrap of ["load", "complete"]) {
  test(`child connectTo works when bootstrapped at ${bootstrap}`, async ({
    page,
  }) => {
    await page.goto("/parent.html?mode=connect-to");
    await page.evaluate(
      (phase) =>
        (window as unknown as BrowserHarness).startConnectToSelection(phase),
      bootstrap,
    );
    if (bootstrap === "complete") {
      await expect
        .poll(() =>
          page.frames().some((frame) => /frameId=alpha/.test(frame.url())),
        )
        .toBe(true);
      const frame = page.frame({ url: /frameId=alpha/ });
      if (!frame) throw new Error("Missing child iframe");
      await frame.waitForLoadState("load");
      expect((await getTelemetry(page)).selectResolved).toBe(false);
      await frame.evaluate(() =>
        (window as unknown as { bootstrapChild(): void }).bootstrapChild(),
      );
    }
    await expect(
      page.evaluate(() =>
        (window as unknown as BrowserHarness).callConnectToSelectedChild(
          "late-bootstrap",
        ),
      ),
    ).resolves.toBe("child:alpha:late-bootstrap");
    expect((await getTelemetry(page)).parentConnectAttempts).toBe(0);
  });
}

test("a reloaded child connects back to a fresh selection without parent demand", async ({
  page,
}) => {
  await page.goto("/parent.html?mode=connect-to");
  await page.evaluate(() =>
    (window as unknown as BrowserHarness).startConnectToSelection(),
  );
  await expect(
    page.evaluate(() =>
      (window as unknown as BrowserHarness).callConnectToSelectedChild(
        "before-reload",
      ),
    ),
  ).resolves.toBe("child:alpha:before-reload");

  const frame = page.frame({ url: /frameId=alpha/ });
  if (!frame) throw new Error("Missing child iframe");
  const url = frame.url();
  let releaseReload!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });
  await page.route("**/hold-reload.svg", async (route) => {
    await blocked;
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
  });
  await page.route(/child\.html\?.*reload=1/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        "</body>",
        '<img src="/hold-reload.svg"></body>',
      ),
    });
  });
  try {
    await frame.goto(`${url}&reload=1`, { waitUntil: "domcontentloaded" });
    const oldProxyError = await page.evaluate(async () => {
      try {
        await (window as unknown as BrowserHarness).callConnectToSelectedChild(
          "stale",
        );
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code;
      }
    });
    expect(oldProxyError).toBe("E_CONN_CLOSED");
    await page.evaluate(() =>
      (window as unknown as BrowserHarness).selectConnectToChild(),
    );
    expect((await getTelemetry(page)).selectResolved).toBe(false);
    releaseReload();
    await expect(
      page.evaluate(() =>
        (window as unknown as BrowserHarness).callConnectToSelectedChild(
          "after-reload",
        ),
      ),
    ).resolves.toBe("child:alpha:after-reload");
    expect((await getTelemetry(page)).parentConnectAttempts).toBe(0);
  } finally {
    releaseReload();
  }
});

test("uses binary ArrayBuffer transport packets across cross-origin iframe RPC", async ({
  page,
}) => {
  await page.goto("/parent.html");
  await waitForLoadedFrames(page);

  const childBefore = await getChildTelemetry(page, "alpha");
  await expect(
    callChildEcho(page, "alpha", "binary-parent-child"),
  ).resolves.toBe("child:alpha:binary-parent-child");
  const childAfter = await getChildTelemetry(page, "alpha");
  expect(childAfter.binaryDataEnvelopes).toBeGreaterThan(
    childBefore.binaryDataEnvelopes,
  );

  const parentBefore = await getTelemetry(page);
  await expect(
    callParentEcho(page, "alpha", "binary-child-parent"),
  ).resolves.toBe("parent:alpha:binary-child-parent");
  const parentAfter = await getTelemetry(page);
  expect(parentAfter.binaryDataEnvelopes).toBeGreaterThan(
    parentBefore.binaryDataEnvelopes,
  );
});

test("child iframe calls a parent Nexus service with frame routing metadata", async ({
  page,
}) => {
  await page.goto("/parent.html");
  await waitForLoadedFrames(page);

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
  await waitForLoadedFrames(page);

  await postSpoofedConnectFromChild(page, "alpha", {
    channel: "wrong-channel",
  });
  await postSpoofedConnectFromChild(page, "alpha", { nonce: "wrong-nonce" });

  await expect(
    getTelemetry(page).then((telemetry) => telemetry.loadedFrames.sort()),
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
  await waitForLoadedFrames(page);

  await expect(callChildEcho(page, "alpha", "before-reload")).resolves.toBe(
    "child:alpha:before-reload",
  );

  await page.evaluate(() =>
    (window as unknown as BrowserHarness).reloadFrame("alpha"),
  );

  await expect
    .poll(() => getTelemetry(page).then((telemetry) => telemetry.loadedFrames))
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
  await waitForLoadedFrames(page);

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
    .poll(() => getTelemetry(page).then((telemetry) => telemetry.loadedFrames))
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
  await waitForLoadedFrames(page);

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
  await waitForLoadedFrames(page);

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
  await waitForLoadedFrames(page);

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
