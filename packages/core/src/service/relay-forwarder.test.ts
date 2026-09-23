import { describe, expect, it, vi } from "vitest";
import { Result } from "better-result";
import { RelayForwarder, type RelayPeer } from "./relay-forwarder";
import { ResourceScopeHandle } from "./resource-scope";
import { NexusMessageType, type RpcMessage } from "../types/message";

describe("RelayForwarder", () => {
  it("accounts for reverse callback hops and rejects exhaustion without closing the domain", async () => {
    const local = new ResourceScopeHandle(
      "local",
      "s",
      "a",
      "provider",
      () => {},
    );
    const remote = new ResourceScopeHandle(
      "remote",
      "s",
      "b",
      "requester",
      () => {},
    );
    let receive!: (
      message: RpcMessage,
      receivedAt: number,
    ) => Result<void, Error>;
    const send = vi.fn(() => Result.ok(undefined));
    const sendBack = vi.fn((_message: RpcMessage) => Result.ok(undefined));
    const forwarder = new RelayForwarder(
      local,
      {
        services: ["s"],
        signal: new AbortController().signal,
        acquire: async () =>
          Result.ok({
            createScope: () => Result.ok(remote),
            send,
            bind: (_scope, handler) => {
              receive = handler;
            },
          }),
      },
      sendBack,
      () => Result.ok(() => {}),
    );
    const request = {
      type: NexusMessageType.APPLY as const,
      id: 1,
      resourceId: null,
      path: ["s", "run"],
      args: [],
      scopeId: local.id,
      timeoutMs: 1_000,
      hops: 3,
    };
    try {
      expect((await forwarder.forward(request, performance.now())).isOk()).toBe(
        true,
      );
      expect(
        receive(
          {
            ...request,
            resourceId: "callback",
            scopeId: remote.id,
          },
          performance.now() - 100,
        ).isOk(),
      ).toBe(true);
      expect(sendBack).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ scopeId: local.id, hops: 2 }),
      );
      expect(sendBack.mock.calls[0][0]).toMatchObject({
        timeoutMs: expect.any(Number),
      });
      const forwarded = sendBack.mock.calls[0][0];
      expect(
        "timeoutMs" in forwarded && forwarded.timeoutMs,
      ).toBeLessThanOrEqual(900);
      expect(
        receive(
          {
            ...request,
            resourceId: "callback",
            scopeId: remote.id,
            hops: 0,
          },
          performance.now(),
        ).isOk(),
      ).toBe(true);
      expect(sendBack).toHaveBeenCalledOnce();
      expect(send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: NexusMessageType.ERR,
          scopeId: remote.id,
          error: expect.objectContaining({ code: "E_PROTOCOL_ERROR" }),
        }),
        remote,
      );
      expect(local.closed).toBe(false);
      receive(
        { ...request, resourceId: "callback", scopeId: remote.id },
        performance.now() - 1_001,
      );
      expect(sendBack).toHaveBeenCalledOnce();
      expect(send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: NexusMessageType.ERR,
          error: expect.objectContaining({ code: "E_CALL_TIMEOUT" }),
        }),
        remote,
      );
      expect(local.closed).toBe(false);
    } finally {
      local.close();
    }
  });
  it("bounds each waiting operation even when a shared acquisition remains pending", async () => {
    vi.useFakeTimers();
    const local = new ResourceScopeHandle(
      "local",
      "s",
      "a",
      "provider",
      () => {},
    );
    let finish!: (peer: Result<RelayPeer, Error>) => void;
    const acquire = vi.fn(
      () =>
        new Promise<Result<RelayPeer, Error>>((resolve) => {
          finish = resolve;
        }),
    );
    const registration = {
      services: ["s"],
      signal: new AbortController().signal,
      acquire,
    };
    const forwarder = new RelayForwarder(
      local,
      registration,
      () => Result.ok(undefined),
      () => Result.ok(() => {}),
    );
    const send = vi.fn(() => Result.ok(undefined));
    const remote = new ResourceScopeHandle(
      "remote",
      "s",
      "b",
      "requester",
      () => {},
    );
    const peer: RelayPeer = {
      createScope: () => Result.ok(remote),
      bind: () => {},
      send,
    };
    try {
      const long = forwarder.forward(
        {
          type: NexusMessageType.APPLY,
          id: 1,
          resourceId: null,
          path: ["s", "run"],
          args: [],
          timeoutMs: 100,
          scopeId: "local",
        },
        performance.now(),
      );
      const short = forwarder.forward(
        {
          type: NexusMessageType.APPLY,
          id: 2,
          resourceId: null,
          path: ["s", "run"],
          args: [],
          timeoutMs: 5,
          scopeId: "local",
        },
        performance.now(),
      );
      let shortFinished = false;
      void short.then(() => {
        shortFinished = true;
      });
      await vi.advanceTimersByTimeAsync(6);
      expect(shortFinished).toBe(true);
      expect(await short).toMatchObject({ error: { code: "E_CALL_TIMEOUT" } });
      finish(Result.ok(peer));
      expect((await long).isOk()).toBe(true);
      expect(acquire).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();
    } finally {
      local.close();
      vi.useRealTimers();
    }
  });
});
