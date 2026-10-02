import { describe, expect, it, vi } from "vitest";
import { Result } from "better-result";
import { RelayForwarder, type RelayPeer } from "./relay-forwarder";
import { ResourceScopeHandle } from "./resource-scope";
import { NexusMessageType, type RpcMessage } from "../types/message";
import { NexusProtocolError } from "../errors";

describe("RelayForwarder", () => {
  it("settles a failed downstream request with one upstream error and closes its scope", async () => {
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
    const sendBack = vi.fn(async () => Result.ok(undefined));
    const send = vi.fn(async () => Result.err(new Error("downstream failed")));
    const forwarder = new RelayForwarder(
      local,
      {
        services: ["s"],
        signal: new AbortController().signal,
        acquire: async () =>
          Result.ok({
            createScope: () => Result.ok(remote),
            send,
            bind: () => {},
          }),
      },
      sendBack,
      () => Result.ok(() => {}),
    );
    const result = await forwarder.forward(
      {
        type: NexusMessageType.APPLY,
        id: 1,
        resourceId: null,
        path: ["s", "run"],
        args: [],
        timeoutMs: 1000,
        hops: 1,
      },
      performance.now(),
    );

    expect(result.isErr()).toBe(true);
    expect(sendBack).toHaveBeenCalledOnce();
    expect(sendBack.mock.calls[0][0]).toMatchObject({
      type: NexusMessageType.ERR,
      id: 1,
      error: { code: "E_PROTOCOL_ERROR" },
    });
    expect(local.closed).toBe(true);
    expect(remote.closed).toBe(true);
  });

  it("reports uncertain downstream commit distinctly and preserves the upstream scope", async () => {
    const local = new ResourceScopeHandle(
      "local-uncertain",
      "s",
      "a",
      "provider",
      () => {},
    );
    const remote = new ResourceScopeHandle(
      "remote-uncertain",
      "s",
      "b",
      "requester",
      () => {},
    );
    const sendBack = vi.fn(async () => Result.ok(undefined));
    const send = vi.fn(async () =>
      Result.err(
        new NexusProtocolError("uncertain downstream commit", {
          code: "E_TRANSFER_UNCERTAIN",
        }),
      ),
    );
    const forwarder = new RelayForwarder(
      local,
      {
        services: ["s"],
        signal: new AbortController().signal,
        acquire: async () =>
          Result.ok({
            createScope: () => Result.ok(remote),
            send,
            bind: () => {},
          }),
      },
      sendBack,
      () => Result.ok(() => {}),
    );

    const result = await forwarder.forward(
      {
        type: NexusMessageType.APPLY,
        id: 2,
        resourceId: null,
        path: ["s", "run"],
        args: [],
        timeoutMs: 1000,
        hops: 1,
      },
      performance.now(),
    );

    expect(result.isErr()).toBe(true);
    expect(sendBack).toHaveBeenCalledOnce();
    expect(sendBack.mock.calls[0][0]).toMatchObject({
      type: NexusMessageType.ERR,
      id: 2,
      error: { code: "E_TRANSFER_UNCERTAIN" },
    });
    expect(local.closed).toBe(false);
    expect(remote.closed).toBe(false);
    local.close();
  });

  it("closes the upstream request domain when sendBack fails", async () => {
    const local = new ResourceScopeHandle(
      "local-sendback-failure",
      "s",
      "a",
      "provider",
      () => {},
    );
    const remote = new ResourceScopeHandle(
      "remote-sendback-failure",
      "s",
      "b",
      "requester",
      () => {},
    );
    const upstreamFailure = new NexusProtocolError("upstream port closed");
    const sendBack = vi.fn(async () => Result.err(upstreamFailure));
    const send = vi.fn(async () => Result.err(new Error("downstream failed")));
    const forwarder = new RelayForwarder(
      local,
      {
        services: ["s"],
        signal: new AbortController().signal,
        acquire: async () =>
          Result.ok({
            createScope: () => Result.ok(remote),
            send,
            bind: () => {},
          }),
      },
      sendBack,
      () => Result.ok(() => {}),
    );

    const result = await forwarder.forward(
      {
        type: NexusMessageType.APPLY,
        id: 7,
        resourceId: null,
        path: ["s", "run"],
        args: [],
        timeoutMs: 1_000,
        hops: 1,
      },
      performance.now(),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error).toBe(upstreamFailure);
    expect(sendBack).toHaveBeenCalledOnce();
    expect(local.closed).toBe(true);
    expect(remote.closed).toBe(true);
  });

  it("closes the upstream request scope when a downstream callback response cannot be sent back", async () => {
    const local = new ResourceScopeHandle(
      "local-callback-sendback",
      "s",
      "a",
      "provider",
      () => {},
    );
    const remote = new ResourceScopeHandle(
      "remote-callback-sendback",
      "s",
      "b",
      "requester",
      () => {},
    );
    let receive!: (
      message: RpcMessage,
      receivedAt: number,
    ) => Promise<Result<void, Error>>;
    const upstreamFailure = new NexusProtocolError(
      "upstream callback send failed",
    );
    const peer: RelayPeer = {
      createScope: () => Result.ok(remote),
      send: async () => Result.ok(undefined),
      bind: (_scope, callback) => (receive = callback),
    };
    const forwarder = new RelayForwarder(
      local,
      {
        services: ["s"],
        signal: new AbortController().signal,
        acquire: async () => Result.ok(peer),
      },
      async () => Result.err(upstreamFailure),
      () => Result.ok(() => {}),
    );
    const request = {
      type: NexusMessageType.APPLY as const,
      id: 33,
      resourceId: null,
      path: ["s", "run"],
      args: [],
      scopeId: local.id,
      timeoutMs: 1000,
      hops: 2,
    };

    expect((await forwarder.forward(request, performance.now())).isOk()).toBe(
      true,
    );
    const response = await receive(
      { type: NexusMessageType.RES, id: 33, result: "ok", scopeId: remote.id },
      performance.now(),
    );

    expect(response.isErr()).toBe(true);
    if (response.isErr()) expect(response.error).toBe(upstreamFailure);
    expect(local.closed).toBe(true);
    expect(remote.closed).toBe(true);
  });

  it("forwards a response that wins over a later downstream send rejection only once", async () => {
    const local = new ResourceScopeHandle(
      "local-response-first",
      "s",
      "a",
      "provider",
      () => {},
    );
    const remote = new ResourceScopeHandle(
      "remote-response-first",
      "s",
      "b",
      "requester",
      () => {},
    );
    let receive!: (
      message: RpcMessage,
      receivedAt: number,
    ) => Promise<Result<void, Error>>;
    const downstreamFailure = new NexusProtocolError(
      "late send rejection after response",
    );
    const sendBack = vi.fn(async () => Result.ok(undefined));
    const peer: RelayPeer = {
      createScope: () => Result.ok(remote),
      bind: (_scope, callback) => (receive = callback),
      send: async (message) => {
        if (message.type === NexusMessageType.APPLY) {
          await receive(
            {
              type: NexusMessageType.RES,
              id: message.id,
              result: "won",
              scopeId: remote.id,
            },
            performance.now(),
          );
          return Result.err(downstreamFailure);
        }
        return Result.ok(undefined);
      },
    };
    const forwarder = new RelayForwarder(
      local,
      {
        services: ["s"],
        signal: new AbortController().signal,
        acquire: async () => Result.ok(peer),
      },
      sendBack,
      () => Result.ok(() => {}),
    );

    const result = await forwarder.forward(
      {
        type: NexusMessageType.APPLY,
        id: 44,
        resourceId: null,
        path: ["s", "run"],
        args: [],
        scopeId: local.id,
        timeoutMs: 1000,
        hops: 2,
      },
      performance.now(),
    );

    expect(result.isOk()).toBe(true);
    expect(sendBack).toHaveBeenCalledOnce();
    expect(sendBack.mock.calls[0]?.[0]).toMatchObject({
      type: NexusMessageType.RES,
      id: 44,
      result: "won",
    });
    expect(local.closed).toBe(false);
    local.close();
  });

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
    ) => Promise<Result<void, Error>>;
    const send = vi.fn(async () => Result.ok(undefined));
    const sendBack = vi.fn(async (_message: RpcMessage) =>
      Result.ok(undefined),
    );
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
        (
          await receive(
            {
              ...request,
              resourceId: "callback",
              scopeId: remote.id,
            },
            performance.now() - 100,
          )
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
        (
          await receive(
            {
              ...request,
              resourceId: "callback",
              scopeId: remote.id,
              hops: 0,
            },
            performance.now(),
          )
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
      await receive(
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

  it("subtracts upstream acquisition time from the forwarded deadline", async () => {
    vi.useFakeTimers();
    const local = new ResourceScopeHandle(
      "local-budget",
      "s",
      "a",
      "provider",
      () => {},
    );
    const remote = new ResourceScopeHandle(
      "remote-budget",
      "s",
      "b",
      "requester",
      () => {},
    );
    let finish!: (peer: Result<RelayPeer, Error>) => void;
    const send = vi.fn(async () => Result.ok(undefined));
    const peer: RelayPeer = {
      createScope: () => Result.ok(remote),
      bind: () => {},
      send,
    };
    const forwarder = new RelayForwarder(
      local,
      {
        services: ["s"],
        signal: new AbortController().signal,
        acquire: () => new Promise((resolve) => (finish = resolve)),
      },
      async () => Result.ok(undefined),
      () => Result.ok(() => {}),
    );
    try {
      const forwarding = forwarder.forward(
        {
          type: NexusMessageType.APPLY,
          id: 3,
          resourceId: null,
          path: ["s", "run"],
          args: [],
          timeoutMs: 100,
          hops: 2,
        },
        performance.now(),
      );
      await vi.advanceTimersByTimeAsync(30);
      finish(Result.ok(peer));

      expect((await forwarding).isOk()).toBe(true);
      expect(send.mock.calls[0]?.[0]).toMatchObject({
        timeoutMs: expect.any(Number),
        hops: 1,
      });
      const forwarded = send.mock.calls[0]?.[0];
      expect("timeoutMs" in forwarded && forwarded.timeoutMs).toBeLessThan(100);
      expect("timeoutMs" in forwarded && forwarded.timeoutMs).toBeGreaterThan(
        0,
      );
    } finally {
      local.close();
      vi.useRealTimers();
    }
  });
});
