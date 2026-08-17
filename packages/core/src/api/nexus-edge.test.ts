import { Result } from "better-result";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectionManagerError,
  ConnectionManagerHandshakeFailedError,
} from "../connection/connection-manager";
import {
  NexusEndpointCapabilityError,
  NexusEndpointConnectError,
  NexusHandshakeError,
  NexusProtocolIncompatibleError,
  NexusServiceError,
  NexusUsageError,
} from "../errors";
import { Nexus } from "./nexus";
import { Token } from "./token";

const { ok } = Result;

const endpoint = () => ({
  listen: vi.fn(),
  connect: vi.fn(async () => ({ port: undefined, connectionMeta: {} })),
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const trackAbortSignal = () => {
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, "addEventListener");
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  return { controller, add, remove };
};

describe("Nexus service acquisition API", () => {
  it("normalizes token and registration provider overloads", () => {
    const nexus = new Nexus();
    const first = new Token<object>("first");
    const second = new Token<object>("second");
    expect(nexus.safeProvide(first, {})).toMatchObject({ value: nexus });
    expect(nexus.safeProvide({ token: second, service: {} })).toMatchObject({
      value: nexus,
    });
  });

  it("rejects invalid provider batches atomically", () => {
    const nexus = new Nexus();
    expect(
      nexus.safeProvide([
        { token: new Token<object>("valid"), service: {} },
        { token: new Token<object>("invalid"), service: null as never },
      ]),
    ).toMatchObject({ error: { code: "E_PROVIDER_BATCH_INVALID" } });
    expect((nexus as any).config.providers).toBeUndefined();
  });

  it("replaces a live provider by token id", async () => {
    const nexus = new Nexus().configure({
      endpoint: { meta: { context: "host" }, implementation: endpoint() },
    }) as Nexus;
    const token = new Token<object>("service");
    await nexus.ready();
    expect(nexus.safeProvide(token, { version: 1 })).toMatchObject({
      value: nexus,
    });
    expect(nexus.safeProvide(token, { version: 2 })).toMatchObject({
      value: nexus,
    });
  });

  it("locks structural configuration during bootstrap and reuses terminal failure", async () => {
    let releaseListen!: () => void;
    const nexus = new Nexus().configure({
      endpoint: {
        meta: { context: "client" },
        implementation: {
          listen: vi.fn(
            () => new Promise<void>((resolve) => (releaseListen = resolve)),
          ),
          connect: vi.fn(),
        },
      },
    });
    const ready = nexus.safeReady();
    await vi.waitFor(() => expect(releaseListen).toBeTypeOf("function"));
    expect(nexus.safeConfigure({ policy: {} })).toMatchObject({
      error: { code: "E_NEXUS_BOOTSTRAPPING_LOCKED" },
    });
    releaseListen();
    await ready;
  });

  it("returns safe ref and release results without throwing", () => {
    const nexus = new Nexus();
    expect(nexus.safeRef(null as never)).toMatchObject({
      error: { code: "E_USAGE_INVALID" },
    });
    expect(nexus.safeRelease(null as never)).toMatchObject({
      value: undefined,
    });
    expect(nexus.safeRelease({})).toMatchObject({ value: undefined });
  });

  it("does not expose recipient IDs from all or stream settlements", async () => {
    const { PendingCallManager } =
      await import("../service/pending-call-manager");
    const manager = PendingCallManager.create();
    const pending = manager.register(1, {
      strategy: "all",
      isBroadcast: true,
      sentConnectionIds: ["private"],
      timeout: 1_000,
    }) as Promise<Array<Record<string, unknown>>>;
    manager.handleResponse(1, "value", null, "private");
    await expect(pending).resolves.toEqual([
      { status: "fulfilled", value: "value" },
    ]);
  });
  it("does not connect while readying a defaultTarget endpoint", async () => {
    const implementation = endpoint();
    const nexus = new Nexus().configure({
      endpoint: {
        meta: { context: "client" },
        implementation,
        defaultTarget: { context: "host" },
      },
    });
    await nexus.ready();
    expect(implementation.connect).not.toHaveBeenCalled();
  });

  it("returns safe usage errors for invalid acquisition options", async () => {
    const nexus = new Nexus();
    const token = new Token<object>("service");
    await expect(
      nexus.safeCreate(token, { target: null } as never),
    ).resolves.toMatchObject({
      error: { code: "E_USAGE_INVALID" },
    });
    await expect(
      nexus.safeSelect(token, { wait: { timeout: -1 } }),
    ).resolves.toMatchObject({
      error: { code: "E_USAGE_INVALID" },
    });
    await expect(
      nexus.safeSelectMulticast(token, { callTimeout: Infinity }),
    ).resolves.toMatchObject({
      error: { code: "E_USAGE_INVALID" },
    });
    expect(
      nexus.safeConfigure({
        endpoint: { defaultTarget: null as never },
      }),
    ).toMatchObject({ error: { code: "E_USAGE_INVALID" } });
  });

  it("does not let one caller abort a shared bootstrap for another caller", async () => {
    let releaseListen!: () => void;
    const nexus = new Nexus().configure({
      endpoint: {
        meta: { context: "client" },
        implementation: {
          listen: vi.fn(
            () => new Promise<void>((resolve) => (releaseListen = resolve)),
          ),
          connect: vi.fn(),
        },
      },
    }) as Nexus;
    const signal = new AbortController();
    const aborted = nexus.safeCreate(new Token<object>("service"), {
      target: { context: "host" },
      signal: signal.signal,
    });
    const survivor = nexus.safeReady();
    await vi.waitFor(() => expect(releaseListen).toBeTypeOf("function"));
    signal.abort();
    await expect(aborted).resolves.toMatchObject({
      error: { code: "E_ABORTED" },
    });
    releaseListen();
    await expect(survivor).resolves.toMatchObject({ value: undefined });
  });

  it("times out and aborts create after bootstrap while target connection is pending", async () => {
    vi.useFakeTimers();
    try {
      const pendingConnection = deferred<ReturnType<typeof ok<any>>>();
      const manager = {
        safeResolveConnections: vi.fn(() => pendingConnection.promise),
        getReadyTargetConnections: vi.fn(() => []),
        subscribeAvailabilityChanged: vi.fn(),
      };
      const nexus = readyNexus(manager, vi.fn());
      const aborted = trackAbortSignal();
      const timeout = nexus.safeCreate(new Token<object>("timeout"), {
        target: { context: "host" },
        timeout: 10,
      });
      const abort = nexus.safeCreate(new Token<object>("abort"), {
        target: { context: "host" },
        signal: aborted.controller.signal,
      });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      aborted.controller.abort();
      await expect(abort).resolves.toMatchObject({
        error: { code: "E_ABORTED" },
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(timeout).resolves.toMatchObject({
        error: { code: "E_SERVICE_ACQUISITION_TIMEOUT" },
      });
      expect(manager.safeResolveConnections).toHaveBeenCalledTimes(2);
      expect(aborted.add).toHaveBeenCalledOnce();
      expect(aborted.remove).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps shared target connection work alive when concurrent callers time out or abort", async () => {
    vi.useFakeTimers();
    try {
      const connection = {
        connectionId: "late",
        isReady: () => true,
        remoteProviders: new Set(["service"]),
      };
      const sharedResolution = deferred<ReturnType<typeof ok<any>>>();
      const manager = {
        safeResolveConnections: vi.fn(() => sharedResolution.promise),
        getReadyTargetConnections: vi.fn(() => [connection]),
        subscribeAvailabilityChanged: vi.fn(),
      };
      const createServiceProxy = vi.fn(() => ({}));
      const nexus = readyNexus(manager, createServiceProxy);
      const aborted = new AbortController();
      const timedOut = nexus.safeCreate(new Token<object>("service"), {
        target: { context: "host" },
        timeout: 10,
      });
      const cancelled = nexus.safeCreate(new Token<object>("service"), {
        target: { context: "host" },
        signal: aborted.signal,
      });
      const survivor = nexus.safeCreate(new Token<object>("service"), {
        target: { context: "host" },
        timeout: 100,
      });

      aborted.abort();
      await vi.advanceTimersByTimeAsync(10);
      await expect(timedOut).resolves.toMatchObject({
        error: { code: "E_SERVICE_ACQUISITION_TIMEOUT" },
      });
      await expect(cancelled).resolves.toMatchObject({
        error: { code: "E_ABORTED" },
      });
      sharedResolution.resolve(ok([connection]));
      await expect(survivor).resolves.toMatchObject({ value: {} });
      await expect(
        nexus.safeCreate(new Token<object>("service"), {
          target: { context: "host" },
        }),
      ).resolves.toMatchObject({ value: {} });
      expect(createServiceProxy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects create without a target source", async () => {
    const nexus = new Nexus().configure({
      endpoint: { meta: { context: "client" }, implementation: endpoint() },
    });
    const result = await nexus.safeCreate(new Token<object>("service"));
    expect(result).toMatchObject({ error: { code: "E_TARGET_REQUIRED" } });
  });

  it("does not expose broadcast", () => {
    expect("broadcast" in new Nexus()).toBe(false);
  });

  it("selects one stable live provider per multicast target and deduplicates IDs", async () => {
    const token = new Token<object>("service");
    const shared = {
      connectionId: "shared",
      isReady: () => true,
      remoteProviders: new Set([token.id]),
    };
    const alternate = {
      connectionId: "alternate",
      isReady: () => true,
      remoteProviders: new Set([token.id]),
    };
    const manager = {
      safeResolveConnections: vi.fn(async () => ok([shared, alternate])),
      getReadyTargetConnections: vi.fn(() => [shared, alternate]),
      subscribeAvailabilityChanged: vi.fn(() => () => undefined),
    };
    const createServiceProxy = vi.fn(() => ({}));
    const nexus = readyNexus(manager, createServiceProxy);

    await expect(
      nexus.safeCreateMulticast(token, {
        targets: [{ context: "first" }, { context: "second" }],
      }),
    ).resolves.toMatchObject({ value: {} });
    expect(createServiceProxy).toHaveBeenCalledWith(token.id, {
      target: { connectionIds: ["shared"] },
      strategy: "all",
      timeout: 5_000,
    });
  });

  it("rescans after final multicast liveness loss and binds a replacement provider", async () => {
    const token = new Token<object>("service");
    const first = {
      connectionId: "first",
      isReady: () => true,
      remoteProviders: new Set([token.id]),
    };
    const unavailable = {
      connectionId: "unavailable",
      isReady: () => true,
      remoteProviders: new Set<string>(),
    };
    const replacement = {
      connectionId: "replacement",
      isReady: () => true,
      remoteProviders: new Set([token.id]),
    };
    let notify: (() => void) | undefined;
    const scans = [[unavailable], [unavailable], [replacement], [replacement]];
    const manager = {
      safeResolveConnections: vi.fn(async () => ok([first])),
      getReadyTargetConnections: vi.fn(() => scans.shift() ?? [replacement]),
      subscribeAvailabilityChanged: vi.fn((listener) => {
        notify = listener;
        return () => undefined;
      }),
    };
    const createServiceProxy = vi.fn(() => ({}));
    const nexus = readyNexus(manager, createServiceProxy);
    const acquisition = nexus.safeCreateMulticast(token, {
      targets: [{ context: "host" }],
    });

    await vi.waitFor(() => expect(notify).toBeTypeOf("function"));
    notify!();

    await expect(acquisition).resolves.toMatchObject({ value: {} });
    expect(createServiceProxy).toHaveBeenCalledWith(token.id, {
      target: { connectionIds: ["replacement"] },
      strategy: "all",
      timeout: 5_000,
    });
  });

  it("returns unavailable immediately when the final multicast scan loses a reached target", async () => {
    vi.useFakeTimers();
    try {
      const token = new Token<object>("service");
      const provider = {
        connectionId: "provider",
        isReady: () => true,
        remoteProviders: new Set([token.id]),
      };
      const manager = {
        safeResolveConnections: vi.fn(async () => ok([provider])),
        getReadyTargetConnections: vi.fn(() => []),
        subscribeAvailabilityChanged: vi.fn(() => () => undefined),
      };

      const acquisition = readyNexus(manager, vi.fn()).safeCreateMulticast(
        token,
        { targets: [{ context: "host" }], timeout: 10 },
      );

      await Promise.resolve();
      await Promise.resolve();
      await expect(acquisition).resolves.toMatchObject({
        error: { code: "E_SERVICE_UNAVAILABLE" },
      });
      expect(manager.subscribeAvailabilityChanged).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the first terminal multicast resolution while another target remains pending", async () => {
    vi.useFakeTimers();
    try {
      const token = new Token<object>("service");
      const unresolved = deferred<ReturnType<typeof ok<any>>>();
      const manager = {
        safeResolveConnections: vi
          .fn()
          .mockResolvedValueOnce(
            Result.err(new ConnectionManagerError("denied", "E_AUTH_DENIED")),
          )
          .mockReturnValueOnce(unresolved.promise),
        getReadyTargetConnections: vi.fn(),
        subscribeAvailabilityChanged: vi.fn(),
      };

      const acquisition = readyNexus(manager, vi.fn()).safeCreateMulticast(
        token,
        {
          targets: [{ context: "first" }, { context: "second" }],
          timeout: 10,
        },
      );

      await expect(acquisition).resolves.toMatchObject({
        error: { code: "E_SERVICE_UNAVAILABLE" },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires multicast provider waiting once under the shared acquisition deadline", async () => {
    vi.useFakeTimers();
    try {
      const token = new Token<object>("service");
      const accepted = {
        connectionId: "accepted",
        isReady: () => true,
        remoteProviders: new Set<string>(),
      };
      const subscribed = deferred<void>();
      const unsubscribe = vi.fn();
      const manager = {
        safeResolveConnections: vi.fn(async () => ok([accepted])),
        getReadyTargetConnections: vi.fn(() => [accepted]),
        subscribeAvailabilityChanged: vi.fn(() => {
          subscribed.resolve();
          return unsubscribe;
        }),
      };

      const acquisition = readyNexus(manager, vi.fn()).safeCreateMulticast(
        token,
        { targets: [{ context: "host" }], timeout: 10 },
      );

      await subscribed.promise;
      await vi.advanceTimersByTimeAsync(10);
      await expect(acquisition).resolves.toMatchObject({
        error: { code: "E_SERVICE_ACQUISITION_TIMEOUT" },
      });
      expect(manager.subscribeAvailabilityChanged).toHaveBeenCalledOnce();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a provider after target acquisition and shares the acquisition deadline", async () => {
    const token = new Token<object>("service");
    const accepted = {
      connectionId: "accepted",
      isReady: () => true,
      remoteProviders: new Set<string>(),
    };
    const provider = {
      connectionId: "provider",
      isReady: () => true,
      remoteProviders: new Set([token.id]),
    };
    let notify: (() => void) | undefined;
    const manager = {
      safeResolveConnections: vi.fn(async () => ok([accepted])),
      getReadyTargetConnections: vi
        .fn()
        .mockReturnValueOnce([accepted])
        .mockReturnValueOnce([accepted])
        .mockImplementation(() => [provider]),
      subscribeAvailabilityChanged: vi.fn((listener) => {
        notify = listener;
        return () => undefined;
      }),
    };
    const createServiceProxy = vi.fn(() => ({}));
    const nexus = readyNexus(manager, createServiceProxy);
    const pending = nexus.safeCreate(token, {
      target: { context: "host" },
      timeout: 1_000,
    });

    await vi.waitFor(() => expect(notify).toBeTypeOf("function"));
    notify!();
    await expect(pending).resolves.toMatchObject({ value: {} });
    expect(createServiceProxy).toHaveBeenCalledWith(
      token.id,
      expect.objectContaining({
        target: { connectionId: "provider" },
      }),
    );
  });

  it("returns unavailable immediately when a reached target has no accepted candidate", async () => {
    const manager = {
      safeResolveConnections: vi.fn(async () => ok([])),
      getReadyTargetConnections: vi.fn(() => []),
      subscribeAvailabilityChanged: vi.fn(),
    };
    const nexus = readyNexus(manager, vi.fn());

    await expect(
      nexus.safeCreate(new Token<object>("service"), {
        target: { context: "host" },
      }),
    ).resolves.toMatchObject({ error: { code: "E_SERVICE_UNAVAILABLE" } });
    expect(manager.subscribeAvailabilityChanged).not.toHaveBeenCalled();
  });

  it("maps direct and nested endpoint failures to public endpoint connect errors", async () => {
    const direct = new NexusEndpointConnectError("direct");
    const nested = new ConnectionManagerError("nested", "E_UNKNOWN", {
      cause: new NexusEndpointConnectError("nested cause"),
    });
    for (const error of [direct, nested]) {
      const manager = {
        safeResolveConnections: vi.fn(async () => Result.err(error)),
        getReadyTargetConnections: vi.fn(),
        subscribeAvailabilityChanged: vi.fn(),
      };
      const result = await readyNexus(manager, vi.fn()).safeCreate(
        new Token<object>("service"),
        { target: { context: "host" } },
      );
      expect(result.error).toBeInstanceOf(NexusEndpointConnectError);
      expect(result.error).not.toBeInstanceOf(ConnectionManagerError);
      expect(result.error).toMatchObject({ code: "E_ENDPOINT_CONNECT_FAILED" });
    }
  });

  it("maps every manager terminal error to a public Nexus error", async () => {
    const cases: readonly [
      ConnectionManagerError | Error,
      new (...args: any[]) => Error,
      string,
    ][] = [
      [
        new ConnectionManagerError(
          "constraint",
          "E_CONNECTION_CONSTRAINT_FAILED",
        ),
        NexusServiceError,
        "E_TARGET_CONSTRAINT_FAILED",
      ],
      [
        new ConnectionManagerError("protocol", "E_PROTOCOL_INCOMPATIBLE"),
        NexusProtocolIncompatibleError,
        "E_PROTOCOL_INCOMPATIBLE",
      ],
      [
        new ConnectionManagerHandshakeFailedError("failed"),
        NexusHandshakeError,
        "E_HANDSHAKE_FAILED",
      ],
      [
        new ConnectionManagerError("rejected", "E_AUTH_CONNECT_DENIED"),
        NexusHandshakeError,
        "E_HANDSHAKE_REJECTED",
      ],
      [
        new ConnectionManagerError(
          "capability",
          "E_ENDPOINT_CAPABILITY_MISMATCH",
        ),
        NexusEndpointCapabilityError,
        "E_ENDPOINT_CAPABILITY_MISMATCH",
      ],
      [
        new NexusEndpointConnectError("direct"),
        NexusEndpointConnectError,
        "E_ENDPOINT_CONNECT_FAILED",
      ],
      [
        new ConnectionManagerError("nested", "E_UNKNOWN", {
          cause: new NexusEndpointConnectError("nested"),
        }),
        NexusEndpointConnectError,
        "E_ENDPOINT_CONNECT_FAILED",
      ],
      [
        new ConnectionManagerError("usage", "E_USAGE_INVALID"),
        NexusUsageError,
        "E_USAGE_INVALID",
      ],
      [
        new ConnectionManagerError("unknown", "E_UNKNOWN"),
        NexusServiceError,
        "E_SERVICE_UNAVAILABLE",
      ],
    ];
    for (const [terminal, ErrorType, code] of cases) {
      const manager = {
        safeResolveConnections: vi.fn(async () => Result.err(terminal)),
        getReadyTargetConnections: vi.fn(),
        subscribeAvailabilityChanged: vi.fn(),
      };
      const result = await readyNexus(manager, vi.fn()).safeCreate(
        new Token<object>("service"),
        { target: { context: "host" } },
      );
      expect(result.error).toBeInstanceOf(ErrorType);
      expect(result.error).not.toBeInstanceOf(ConnectionManagerError);
      expect(result.error).toMatchObject({ code });
    }
  });

  it("preserves serialized causes for handshake and capability terminal mappings", async () => {
    const cases = [
      new ConnectionManagerHandshakeFailedError("handshake", {
        cause: new Error("peer rejected"),
      }),
      new ConnectionManagerError(
        "capability",
        "E_ENDPOINT_CAPABILITY_MISMATCH",
        {
          cause: new NexusEndpointCapabilityError("missing connect"),
        },
      ),
    ];
    for (const error of cases) {
      const manager = {
        safeResolveConnections: vi.fn(async () => Result.err(error)),
        getReadyTargetConnections: vi.fn(),
        subscribeAvailabilityChanged: vi.fn(),
      };
      const result = await readyNexus(manager, vi.fn()).safeCreate(
        new Token<object>("service"),
        { target: { context: "host" } },
      );
      expect(result.error).not.toBeInstanceOf(ConnectionManagerError);
      expect(result.error).toMatchObject({
        cause: expect.objectContaining({ message: expect.any(String) }),
      });
    }
  });

  it("subscribes before rescanning select wait and cleans subscriptions after success", async () => {
    const token = new Token<object>("service");
    const provider = { connectionId: "provider", isReady: () => true };
    let notify: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const manager = {
      getReadyProviderConnections: vi
        .fn()
        .mockReturnValueOnce([])
        .mockImplementation(() => [provider]),
      subscribeAvailabilityChanged: vi.fn((listener) => {
        notify = listener;
        return unsubscribe;
      }),
    };
    const nexus = readyNexus(
      manager,
      vi.fn(() => ({})),
    );
    const selected = nexus.safeSelect(token, { wait: { timeout: 1_000 } });

    await vi.waitFor(() => expect(notify).toBeTypeOf("function"));
    notify!();
    await expect(selected).resolves.toMatchObject({ value: {} });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("returns where predicate failures from safe select APIs", async () => {
    const token = new Token<object>("service");
    const where = () => {
      throw new Error("where failed");
    };
    const manager = {
      getReadyProviderConnections: vi.fn((_token, predicate) => {
        predicate?.({}, {});
        return [{ connectionId: "provider", isReady: () => true }];
      }),
    };
    const nexus = readyNexus(manager, vi.fn());

    await expect(nexus.safeSelect(token, { where })).resolves.toMatchObject({
      error: { message: "where failed" },
    });
    await expect(
      nexus.safeSelectMulticast(token, { where }),
    ).resolves.toMatchObject({ error: { message: "where failed" } });
  });

  it("rejects create options that contain expects at runtime", async () => {
    const result = await readyNexus({}, vi.fn()).safeCreate(
      new Token<object>("service"),
      { target: { context: "host" }, expects: "all" } as any,
    );

    expect(result).toMatchObject({ error: { code: "E_USAGE_INVALID" } });
  });

  it("cleans each create caller deadline on success, timeout, abort, and terminal error", async () => {
    vi.useFakeTimers();
    try {
      const connection = {
        connectionId: "provider",
        isReady: () => true,
      };
      const cases = [
        {
          name: "success",
          resolve: () => ok([connection]),
          settle: async () => undefined,
          code: undefined,
        },
        {
          name: "timeout",
          resolve: () => deferred<ReturnType<typeof ok<any>>>().promise,
          settle: () => vi.advanceTimersByTimeAsync(10),
          code: "E_SERVICE_ACQUISITION_TIMEOUT",
        },
        {
          name: "abort",
          resolve: () => deferred<ReturnType<typeof ok<any>>>().promise,
          settle: (controller: AbortController) => controller.abort(),
          code: "E_ABORTED",
        },
        {
          name: "terminal error",
          resolve: () =>
            Result.err(new ConnectionManagerError("bad", "E_UNKNOWN")),
          settle: async () => undefined,
          code: "E_SERVICE_UNAVAILABLE",
        },
      ];
      for (const testCase of cases) {
        const signal = trackAbortSignal();
        const manager = {
          safeResolveConnections: vi.fn(async () => testCase.resolve()),
          getReadyTargetConnections: vi.fn(() => [connection]),
          subscribeAvailabilityChanged: vi.fn(),
        };
        const acquisition = readyNexus(manager, vi.fn()).safeCreate(
          new Token<object>(`service-${testCase.name}`),
          {
            target: { context: "host" },
            timeout: 10,
            signal: signal.controller.signal,
          },
        );
        await Promise.resolve();
        await testCase.settle(signal.controller);
        const result = await acquisition;
        if (testCase.code)
          expect(result).toMatchObject({ error: { code: testCase.code } });
        else expect(result).toMatchObject({ value: {} });
        expect(signal.add).toHaveBeenCalledOnce();
        expect(signal.remove).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans select wait deadlines, reports ambiguity after waiting, and skips disconnected candidates", async () => {
    vi.useFakeTimers();
    try {
      const disconnected = { connectionId: "gone", isReady: () => false };
      const first = { connectionId: "first", isReady: () => true };
      const second = { connectionId: "second", isReady: () => true };
      const provider = { connectionId: "provider", isReady: () => true };
      let notify: (() => void) | undefined;
      const unsubscribe = vi.fn();
      const scans = [[], [disconnected], [first, second]];
      const manager = {
        getReadyProviderConnections: vi.fn(() => scans.shift() ?? [provider]),
        subscribeAvailabilityChanged: vi.fn((listener) => {
          notify = listener;
          return unsubscribe;
        }),
      };
      const signal = trackAbortSignal();
      const ambiguous = readyNexus(manager, vi.fn()).safeSelect(
        new Token<object>("service"),
        { wait: { timeout: 10, signal: signal.controller.signal } },
      );
      await vi.advanceTimersByTimeAsync(0);
      notify!();
      await expect(ambiguous).resolves.toMatchObject({
        error: { code: "E_SERVICE_AMBIGUOUS" },
      });
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(signal.add).toHaveBeenCalledOnce();
      expect(signal.remove).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);

      let wake: (() => void) | undefined;
      const subscribed = deferred<void>();
      const selectedManager = {
        getReadyProviderConnections: vi
          .fn()
          .mockReturnValueOnce([])
          .mockReturnValueOnce([])
          .mockReturnValueOnce([provider]),
        subscribeAvailabilityChanged: vi.fn((listener) => {
          wake = listener;
          subscribed.resolve();
          return vi.fn();
        }),
      };
      const selected = readyNexus(
        selectedManager,
        vi.fn(() => ({})),
      ).safeSelect(new Token<object>("later-provider"), {
        wait: { timeout: 10 },
      });
      await subscribed.promise;
      wake?.();
      await expect(selected).resolves.toMatchObject({ value: {} });
    } finally {
      vi.useRealTimers();
    }
  });
});

const readyNexus = (
  manager: object,
  createServiceProxy: ReturnType<typeof vi.fn>,
) => {
  const nexus = new Nexus();
  Object.assign(nexus as object, {
    lifecycle: "ready",
    initialization: Promise.resolve(),
    connectionManager: manager,
    engine: { createServiceProxy },
  });
  return nexus;
};
