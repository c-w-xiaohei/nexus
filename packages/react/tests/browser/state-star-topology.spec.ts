import { expect, test, type Frame, type Page } from "@playwright/test";
import type { CounterState, FrameId } from "./shared";

interface HostTelemetry {
  readyFrames: string[];
  subscribeCalls: number;
  unsubscribeCalls: number;
  activeSubscriptions: number;
  dispatchCalls: Array<{ action: string; args: unknown[] }>;
  snapshots: Array<{ version: number; count: number; writes: number }>;
  subscriptionOwners?: Array<[string, string]>;
}

interface ChildTelemetry {
  commits: CounterState[];
  statuses: string[];
  errors: string[];
  currentState: CounterState | null;
  currentStatus: string;
}

const frameIds: FrameId[] = ["alpha", "beta"];

async function gotoReady(page: Page) {
  await page.goto("/host.html");
  await expect.poll(() => page.evaluate(() => window.frames.length)).toBe(2);
  await expect
    .poll(() =>
      getHostTelemetry(page).then((value) => value.readyFrames.sort()),
    )
    .toEqual(frameIds);
  await expect
    .poll(() =>
      getHostTelemetry(page).then((value) => value.activeSubscriptions),
    )
    .toBe(2);
  for (const frameId of frameIds) {
    await expect
      .poll(() =>
        getChildTelemetry(page, frameId).then((value) => value.currentStatus),
      )
      .toBe("ready");
  }
}

function childFrame(page: Page, frameId: FrameId): Frame {
  const frame = page.frame({ url: new RegExp(`frameId=${frameId}`) });
  if (!frame) throw new Error(`Missing child frame ${frameId}`);
  return frame;
}

async function getHostTelemetry(page: Page): Promise<HostTelemetry> {
  return page.evaluate(() => (window as any).getHostTelemetry());
}

async function getChildTelemetry(
  page: Page,
  frameId: FrameId,
): Promise<ChildTelemetry> {
  return childFrame(page, frameId).evaluate(() =>
    (window as any).getTelemetry(),
  );
}

async function childAction<T = any>(
  page: Page,
  frameId: FrameId,
  expression: () => Promise<T>,
): Promise<T> {
  return childFrame(page, frameId).evaluate(expression);
}

async function expectActiveSubscriptions(page: Page, count: number) {
  await expect
    .poll(() =>
      getHostTelemetry(page).then((value) => value.activeSubscriptions),
    )
    .toBe(count);
}

async function expectCounts(page: Page, count: number, writes: number) {
  for (const frameId of frameIds) {
    const frame = childFrame(page, frameId);
    await expect(frame.locator("#count")).toHaveText(String(count));
    await expect(frame.locator("#writes")).toHaveText(String(writes));
  }
  await expect
    .poll(() => getHostTelemetry(page).then((value) => value.snapshots.at(-1)))
    .toMatchObject({
      count,
      writes,
    });
}

async function expectFrameCount(
  page: Page,
  frameId: FrameId,
  count: number,
  writes: number,
) {
  const frame = childFrame(page, frameId);
  await expect(frame.locator("#count")).toHaveText(String(count));
  await expect(frame.locator("#writes")).toHaveText(String(writes));
}

test("two iframe React clients converge on the host-owned store", async ({
  page,
}) => {
  await gotoReady(page);

  await expectCounts(page, 0, 0);
  expect(await getHostTelemetry(page)).toMatchObject({
    activeSubscriptions: 2,
  });
});

test("action resolves after the caller observes the committed snapshot", async ({
  page,
}) => {
  await gotoReady(page);

  const result = await childAction(page, "alpha", () =>
    (window as any).increment(3),
  );

  expect(result).toMatchObject({ result: 3, state: { count: 3 } });
  await expectCounts(page, 3, 1);
});

test("dispatch from one child fans out to the sibling and host with actor evidence", async ({
  page,
}) => {
  await gotoReady(page);

  await childAction(page, "beta", () => (window as any).increment(2));

  await expectCounts(page, 2, 1);
  await expect(childFrame(page, "alpha").locator("#last-write")).toHaveText(
    "beta",
  );
  await expect(childFrame(page, "beta").locator("#last-write")).toHaveText(
    "beta",
  );
  const host = await getHostTelemetry(page);
  expect(host.dispatchCalls).toContainEqual({
    action: "increment",
    args: ["beta", 2],
  });
});

test("concurrent slow actions from alpha and beta serialize without lost updates", async ({
  page,
}) => {
  await gotoReady(page);

  const [alpha, beta] = await Promise.all([
    childAction(page, "alpha", () => (window as any).asyncIncrementSlow(4, 80)),
    childAction(page, "beta", () => (window as any).asyncIncrementSlow(5, 10)),
  ]);

  expect([alpha.result, beta.result]).toContain(9);
  await expectCounts(page, 9, 2);
  const alphaState = await getChildTelemetry(page, "alpha");
  expect(
    alphaState.currentState?.writes.map((write) => write.actor).sort(),
  ).toEqual(["alpha", "beta"]);
});

test("throwing action rolls back state and later actions still work", async ({
  page,
}) => {
  await gotoReady(page);
  await childAction(page, "alpha", () => (window as any).increment(1));

  const failed = await childAction(page, "alpha", () =>
    (window as any).failAfterNoCommit(),
  );

  expect(failed).toMatchObject({ ok: false, state: { count: 1 } });
  await expectCounts(page, 1, 1);
  await childAction(page, "beta", () => (window as any).increment(2));
  await expectCounts(page, 3, 2);
});

test("one iframe reload cleans only its subscription and the other child keeps working", async ({
  page,
}) => {
  await gotoReady(page);
  await childAction(page, "alpha", () => (window as any).increment(1));

  await childAction(page, "alpha", () => {
    (window as any).makeUnresponsive();
    return Promise.resolve();
  });
  await expect
    .poll(() =>
      getChildTelemetry(page, "alpha").then((value) => value.currentStatus),
    )
    .toBe("disconnected");
  expect(
    await childAction(page, "alpha", () =>
      (window as any).callOldHandleAfterDisconnect(),
    ),
  ).toBe("rejected");
  await expectActiveSubscriptions(page, 1);
  expect((await getHostTelemetry(page)).dispatchCalls).toEqual([
    { action: "increment", args: ["alpha", 1] },
  ]);
  await page.evaluate(() => (window as any).reloadFrame("alpha", false));
  const betaResult = await childAction(page, "beta", () =>
    (window as any).increment(2),
  );
  expect(betaResult).toMatchObject({ state: { count: 3 } });
  await expectFrameCount(page, "beta", 3, 2);
  await expect
    .poll(() => getHostTelemetry(page).then((value) => value.snapshots.at(-1)))
    .toMatchObject({ count: 3, writes: 2 });
});

test("a reloaded iframe reacquires a fresh remote store and old handle rejects", async ({
  page,
}) => {
  await gotoReady(page);
  await childAction(page, "alpha", () => (window as any).increment(2));

  await childAction(page, "alpha", () => {
    (window as any).unmount();
    return Promise.resolve();
  });
  await page.evaluate(() => (window as any).reloadFrame("alpha", false));
  await expectActiveSubscriptions(page, 1);
  await childAction(page, "beta", () => (window as any).increment(3));
  await expectFrameCount(page, "beta", 5, 2);

  await page.evaluate(() => (window as any).reconnectFrame("alpha"));
  await expect
    .poll(() => getHostTelemetry(page).then((value) => value.readyFrames))
    .toContain("alpha");

  await expectActiveSubscriptions(page, 2);
  await expectFrameCount(page, "alpha", 5, 2);
});

test("unmount and remount in one child cleans subscription and receives latest snapshot", async ({
  page,
}) => {
  await gotoReady(page);
  await childAction(page, "beta", () => (window as any).setCount(7));

  await childAction(page, "alpha", () => {
    (window as any).unmount();
    return Promise.resolve();
  });
  await expectActiveSubscriptions(page, 1);
  await childAction(page, "beta", () => (window as any).increment(1));
  await childAction(page, "alpha", () => {
    (window as any).remount();
    return Promise.resolve();
  });

  await expectActiveSubscriptions(page, 2);
  await expect(childFrame(page, "alpha").locator("#count")).toHaveText("8");
});

// Host endpoint teardown is not covered here: the public browser harness exposes
// frame reload/removal and React unmount, but no public API to close the host
// Nexus iframe endpoint without reaching through implementation internals.

test("route and nonce isolation keep actor evidence scoped to real clients", async ({
  page,
}) => {
  await gotoReady(page);
  const before = await getHostTelemetry(page);

  await childAction(page, "alpha", () => {
    (window as any).postForgedParentEnvelope("wrong-nonce", "connect");
    (window as any).postForgedParentEnvelope("wrong-channel", "connect", {
      channel: "nexus:wrong-channel",
    });
    (window as any).postForgedParentEnvelope("wrong-route", "connect", {
      frameId: "beta",
      payload: {
        channelId: "beta:forged-channel",
        from: "beta",
        nonce: "wrong-route",
      },
    });
    return Promise.resolve();
  });
  await childAction(page, "alpha", () => (window as any).increment(1));
  await childAction(page, "beta", () => (window as any).increment(1));

  await expectCounts(page, 2, 2);
  const host = await getHostTelemetry(page);
  expect(host.activeSubscriptions).toBe(2);
  expect(host.subscribeCalls).toBe(before.subscribeCalls);
  expect(host.readyFrames).toEqual(before.readyFrames);
  expect(host.dispatchCalls).toHaveLength(before.dispatchCalls.length + 2);
  expect(
    host.dispatchCalls
      .slice(before.dispatchCalls.length)
      .map((call) => call.args[0]),
  ).toEqual(["alpha", "beta"]);
});
