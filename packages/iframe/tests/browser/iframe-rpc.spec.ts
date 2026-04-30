import { expect, test } from "@playwright/test";

test("calls a child Nexus service through a real iframe boundary", async ({
  page,
}) => {
  await page.goto("/parent.html");

  await expect.poll(() => page.evaluate(() => window.frames.length)).toBe(1);

  await expect(
    page.evaluate(() =>
      (
        window as unknown as { callChildEcho(value: string): Promise<string> }
      ).callChildEcho("hello"),
    ),
  ).resolves.toBe("child:hello");
});

test("ignores same-origin messages from a non-iframe source", async ({
  page,
}) => {
  await page.goto("/parent.html");

  const before = await page.evaluate(() =>
    (
      window as unknown as { callChildEcho(value: string): Promise<string> }
    ).callChildEcho("before"),
  );
  expect(before).toBe("child:before");

  await page.evaluate(() => {
    window.postMessage(
      {
        __nexusIframe: true,
        appId: "browser-app",
        channel: "nexus:iframe",
        nonce: "browser-nonce",
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
    page.evaluate(() =>
      (
        window as unknown as { callChildEcho(value: string): Promise<string> }
      ).callChildEcho("after"),
    ),
  ).resolves.toBe("child:after");
});
