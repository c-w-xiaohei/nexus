import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { WebSocketServerEndpoint } from "../../endpoints/websocket-server-endpoint.js";
import { normalizeTargetUrl } from "../../runtime/validation.js";
import {
  createWebSocketHost,
  createRawWebSocketHost,
  openWs,
  waitForClose,
} from "../integration/fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

describe("WebSocket runtime boundaries", () => {
  test("canonicalizes valid targets and excludes URL credentials and fragments", () => {
    expect(normalizeTargetUrl("WS://example.test:80/nexus?x=1")).toBe(
      "ws://example.test/nexus?x=1",
    );
    expect(() => normalizeTargetUrl("https://example.test")).toThrow();
    expect(() => normalizeTargetUrl("ws://user@example.test")).toThrow();
    expect(() => normalizeTargetUrl("ws://example.test/#secret")).toThrow();
  });

  test("attaches only while listening and leaves rejected sockets with the host", async () => {
    const endpoint = new WebSocketServerEndpoint({ maxConnections: 1 });
    const socket = await createSocket();

    const beforeListen = endpoint.safeAttach(socket, {});
    expect(beforeListen.isErr()).toBe(true);
    if (beforeListen.isErr())
      expect(beforeListen.error.code).toBe("E_WEBSOCKET_NOT_LISTENING");
    expect(socket.terminate).not.toHaveBeenCalled();
    endpoint.listen(() => {});
    expect(endpoint.safeAttach(socket, {}).isOk()).toBe(true);
    const duplicate = endpoint.safeAttach(socket, {});
    expect(duplicate.isErr()).toBe(true);
    if (duplicate.isErr())
      expect(duplicate.error.code).toBe("E_WEBSOCKET_ATTACH_REJECTED");
    endpoint.close();
    expect(socket.terminate).toHaveBeenCalledOnce();

    const closed = new WebSocketServerEndpoint();
    closed.close();
    const afterClose = closed.safeAttach(socket, {});
    expect(afterClose.isErr()).toBe(true);
    if (afterClose.isErr())
      expect(afterClose.error.code).toBe("E_WEBSOCKET_ENDPOINT_CLOSED");
  });

  test("rejects a non-open socket and a full endpoint without closing either socket", async () => {
    const endpoint = new WebSocketServerEndpoint({ maxConnections: 1 });
    endpoint.listen(() => {});
    const closed = await createSocket();
    const closedState = vi
      .spyOn(closed, "readyState", "get")
      .mockReturnValue(WebSocket.CLOSED);
    const rejected = endpoint.safeAttach(closed, {});
    expect(rejected.isErr()).toBe(true);
    if (rejected.isErr())
      expect(rejected.error.code).toBe("E_WEBSOCKET_ATTACH_REJECTED");
    expect(closed.readyState).toBe(3);
    expect(closed.terminate).not.toHaveBeenCalled();
    closedState.mockRestore();

    const first = await createSocket();
    const second = await createSocket();
    endpoint.safeAttach(first, {});
    const full = endpoint.safeAttach(second, {});
    expect(full.isErr()).toBe(true);
    if (full.isErr()) expect(full.error.code).toBe("E_WEBSOCKET_CAPACITY");
    expect(second.readyState).toBe(1);
    expect(second.terminate).not.toHaveBeenCalled();
    endpoint.close();
  });

  test("accepts real host upgrades synchronously and endpoint close does not close HTTP", async () => {
    const endpoint = new WebSocketServerEndpoint<{ source: string }>();
    let accepted = 0;
    endpoint.listen((_port, meta) => {
      accepted += 1;
      expect(meta).toEqual({ source: "host", role: "server" });
    });
    const host = await createWebSocketHost(endpoint, { source: "host" });
    const socket = await openWs(host.url);
    expect(accepted).toBe(1);
    endpoint.close();
    await waitForClose(socket);
    const response = await globalThis.fetch(
      host.url.replace("ws://", "http://"),
    );
    expect(await response.text()).toBe("host-alive");
    await host.close();
  });
});

async function createSocket(): Promise<WebSocket> {
  const host = await createRawWebSocketHost(() => {});
  cleanup.push(host.close);
  const socket = await openWs(host.url);
  vi.spyOn(socket, "terminate");
  return socket;
}
