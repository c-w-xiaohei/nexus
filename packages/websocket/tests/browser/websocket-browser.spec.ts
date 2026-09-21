import { expect } from "@playwright/test";
import { test } from "./fixtures";

test("runs browser RPC, callback, Ref, and State over a negotiated WebSocket", async ({
  page,
  websocket,
}) => {
  await page.goto(`${websocket.origin}/app.html`);
  const result = await page.evaluate(
    (url) => globalThis.window.websocketHarness.runRpcScenario(url),
    websocket.websocketUrl,
  );
  expect(result).toEqual({
    protocol: "nexus-browser.v1",
    echoed: "browser-rpc",
    callback: ["browser-callback"],
    ref: { first: 1, current: 1 },
    state: { actionResult: 3, count: 3 },
  });
});

test("reconnects with fresh session-bound Refs and retains daemon-owned State", async ({
  page,
  websocket,
}) => {
  await page.goto(`${websocket.origin}/app.html`);
  try {
    const initial = await page.evaluate(
      (url) =>
        globalThis.window.websocketHarness.prepareDisconnectScenario(url),
      websocket.websocketUrl,
    );
    expect(initial.ref).toBe(1);
    expect(initial.state).toBe(2);
    websocket.dropConnections();
    expect(
      await page.evaluate(() =>
        globalThis.window.websocketHarness.waitForDisconnect(),
      ),
    ).toBe("remote");
    const result = await page.evaluate(() =>
      globalThis.window.websocketHarness.reconnect(),
    );
    expect(result.freshSessionId).not.toBe(initial.sessionId);
    expect(result).toMatchObject({
      initialSessionStatus: "disconnected",
      staleCallCode: "E_CONN_CLOSED",
      staleRefCode: "E_CONN_CLOSED",
      freshSessionStatus: "connected",
      freshRefInitial: 0,
      freshRefValue: 1,
      initialState: 2,
      state: 7,
      snapshot: 7,
    });
  } finally {
    await page.evaluate(() => globalThis.window.websocketHarness.cleanup());
  }
});
