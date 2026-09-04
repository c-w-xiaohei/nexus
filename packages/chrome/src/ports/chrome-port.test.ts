import { expect, it, vi } from "vitest";
import { ChromePort } from "./chrome-port";

it("propagates synchronous native postMessage failures", () => {
  const error = new TypeError("The message port is disconnected.");
  const nativePort = {
    postMessage: vi.fn(() => {
      throw error;
    }),
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: vi.fn() },
  } as unknown as chrome.runtime.Port;
  const port = new ChromePort(nativePort);

  expect(() => port.postMessage({ type: "test" })).toThrow(error);
});
