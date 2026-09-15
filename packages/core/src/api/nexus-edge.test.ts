import { Result } from "better-result";
import { describe, expect, it, vi } from "vitest";
import {
  NexusError,
  NexusConnectionConstraintFailedError,
  NexusEndpointCapabilityError,
  NexusEndpointConnectError,
  NexusHandshakeError,
  NexusProtocolIncompatibleError,
  NexusServiceError,
  NexusUsageError,
} from "../errors";
import { Nexus } from "./nexus";
import { Token } from "./token";
import { Logger } from "../logger";

const endpoint = () => ({
  listen: vi.fn(),
  connect: vi.fn(async () => ({
    port: {
      postMessage: vi.fn(),
      onMessage: vi.fn(),
      onDisconnect: vi.fn(),
      close: vi.fn(),
    },
    connectionMeta: {},
  })),
});

describe("Nexus public API", () => {
  it("contains hostile declaration inspection without replacing earlier providers", async () => {
    const nexus = new Nexus();
    const token = new Token<object>("inspection");
    const original = {};
    nexus.provide(token, original);
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("getter failed");
        },
        has() {
          throw new Error("descriptor failed");
        },
      },
    );
    expect(nexus.safeConfigure(hostile)).toMatchObject({
      error: { code: "E_USAGE_INVALID" },
    });
    expect(nexus.safeProvide(hostile as never)).toMatchObject({
      error: { code: "E_PROVIDER_BATCH_INVALID" },
    });
    expect((nexus as any).lifecycle.phase).toBe("draft");
    nexus.configure({ endpoint: { implementation: endpoint(), meta: {} } });
    await nexus.ready();
    expect(
      nexus.safeProvide([{ token, service: {} }, hostile as never]),
    ).toMatchObject({
      error: { code: "E_PROVIDER_BATCH_INVALID" },
    });
    const resources = (nexus as any).lifecycle.engine.resourceManager;
    expect(resources.getExposedService(token.id)).toBe(original);
  });
  it("rejects duplicate IDs within pre-bootstrap submissions without discarding earlier providers", () => {
    const nexus = new Nexus();
    const token = new Token<object>("duplicate");
    const original = { version: 1 };
    nexus.provide(token, original);
    const providers = [
      { token, service: { version: 2 } },
      { token: new Token<object>(token.id), service: { version: 3 } },
    ];
    expect(nexus.safeProvide(providers)).toMatchObject({
      error: { code: "E_PROVIDER_DUPLICATE_TOKEN" },
    });
    expect(nexus.safeConfigure({ providers })).toMatchObject({
      error: { code: "E_PROVIDER_DUPLICATE_TOKEN" },
    });
    expect((nexus as any).config.providers).toEqual([
      { token, service: original, policy: undefined },
    ]);
    expect((nexus as any).lifecycle).toEqual({ phase: "draft" });
  });
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
    const valid = { token: new Token<object>("valid"), service: {} };
    for (const providers of [
      [valid, null],
      [valid, , { token: new Token<object>("later"), service: {} }],
    ] as const) {
      expect(nexus.safeProvide(providers as never)).toMatchObject({
        error: { code: "E_PROVIDER_BATCH_INVALID" },
      });
      expect(
        nexus.safeConfigure({ providers: providers as never }),
      ).toMatchObject({
        error: { code: "E_PROVIDER_BATCH_INVALID" },
      });
    }
    expect(
      nexus.safeProvide([
        { token: new Token<object>("valid"), service: {} },
        { token: new Token<object>("invalid"), service: null as never },
      ]),
    ).toMatchObject({ error: { code: "E_PROVIDER_BATCH_INVALID" } });
    expect((nexus as any).config.providers).toBeUndefined();
  });

  it("passes decorated endpoint metadata to decorated service factories", async () => {
    const nexus = new Nexus();
    const token = new Token<object>("decorated-factory-meta");
    const factory = vi.fn(() => ({}));

    nexus.Expose(token, { factory })(class Service {}, {
      kind: "class",
    } as ClassDecoratorContext);
    nexus.Endpoint({ meta: { context: "decorated", scope: "worker" } })(
      class Endpoint {
        listen() {}
      } as never,
      { kind: "class" } as ClassDecoratorContext,
    );

    await nexus.ready();
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        token,
        localMeta: { context: "decorated", scope: "worker" },
      }),
    );
  });

  it("locks reentrant factory registrations while bootstrap is starting", async () => {
    const nexus = new Nexus();
    const token = new Token<object>("factory-reentrant");
    const factory = vi.fn(() => {
      expect(nexus.safeConfigure({ policy: {} })).toMatchObject({
        error: { code: "E_NEXUS_BOOTSTRAPPING_LOCKED" },
      });
      expect(nexus.safeProvide(new Token<object>("late"), {})).toMatchObject({
        error: { code: "E_NEXUS_BOOTSTRAPPING_LOCKED" },
      });
      expect(() =>
        nexus.Expose(new Token<object>("late-decorator"))(
          class LateService {},
          { kind: "class" } as ClassDecoratorContext,
        ),
      ).toThrowError(
        expect.objectContaining({ code: "E_NEXUS_BOOTSTRAPPING_LOCKED" }),
      );
      return {};
    });
    nexus.Expose(token, { factory })(class Service {}, {
      kind: "class",
    } as ClassDecoratorContext);
    nexus.configure({
      endpoint: { meta: { context: "host" }, implementation: endpoint() },
    });

    await expect(nexus.safeReady()).resolves.toMatchObject({
      value: undefined,
    });
    expect(factory).toHaveBeenCalledOnce();
  });

  it("locks synchronous listener registrations after the runtime is installed", async () => {
    const nexus = new Nexus();
    const results: unknown[] = [];
    nexus.configure({
      endpoint: {
        meta: { context: "host" },
        implementation: {
          listen: () => {
            results.push(nexus.safeConfigure({ policy: {} }));
            results.push(nexus.safeProvide(new Token<object>("late"), {}));
            expect(() =>
              nexus.Endpoint({ meta: { context: "late" } })(
                class LateEndpoint {
                  listen() {}
                } as never,
                { kind: "class" } as ClassDecoratorContext,
              ),
            ).toThrowError(
              expect.objectContaining({ code: "E_NEXUS_BOOTSTRAPPING_LOCKED" }),
            );
          },
        },
      },
    });

    await nexus.ready();
    for (const result of results)
      expect(result).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            code: "E_NEXUS_BOOTSTRAPPING_LOCKED",
          }),
        }),
      );
  });

  it("returns a factory rejection from safeReady without rejecting", async () => {
    const failure = new Error("factory rejected");
    const nexus = new Nexus();
    nexus.Expose(new Token<object>("factory-rejection"), {
      factory: async () => Promise.reject(failure),
    })(class Service {}, { kind: "class" } as ClassDecoratorContext);
    nexus.configure({
      endpoint: { meta: { context: "host" }, implementation: endpoint() },
    });

    await expect(nexus.safeReady()).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "E_NEXUS_BOOTSTRAP_FAILED" }),
      }),
    );
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

  it("rejects decorators registered after readiness", async () => {
    const nexus = new Nexus().configure({
      endpoint: { meta: { context: "host" }, implementation: endpoint() },
    }) as Nexus;
    await nexus.ready();

    expect(() =>
      nexus.Expose(new Token<object>("late-service"))(class LateService {}, {
        kind: "class",
      } as ClassDecoratorContext),
    ).toThrowError(expect.objectContaining({ code: "E_NEXUS_ALREADY_READY" }));
    expect(() =>
      nexus.Endpoint({ meta: { context: "late" } })(
        class LateEndpoint {
          listen() {}
        } as never,
        { kind: "class" } as ClassDecoratorContext,
      ),
    ).toThrowError(expect.objectContaining({ code: "E_NEXUS_ALREADY_READY" }));
  });

  it("shares one safe bootstrap failure across concurrent callers", async () => {
    const failure = new Error("listener failed");
    const nexus = new Nexus().configure({
      endpoint: {
        meta: { context: "host" },
        implementation: {
          listen: () => {
            throw failure;
          },
        },
      },
    }) as Nexus;

    const [first, second] = await Promise.all([
      nexus.safeReady(),
      nexus.safeReady(),
    ]);

    expect(first).toMatchObject({
      error: { code: "E_NEXUS_BOOTSTRAP_FAILED" },
    });
    expect(second).toMatchObject({
      error: { code: "E_NEXUS_BOOTSTRAP_FAILED" },
    });
    if (first.isErr() && second.isErr()) expect(first.error).toBe(second.error);
  });

  it("locks structural configuration during bootstrap", async () => {
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

  it("releases public capabilities through static and instance APIs", () => {
    const nexus = new Nexus();
    const release = vi.fn();
    const proxy = { [Symbol.for("nexus.proxy.release")]: release };

    expect(Nexus.safeRelease(proxy)).toMatchObject({ value: undefined });
    expect(Nexus.release(proxy)).toBeUndefined();
    expect(nexus.safeRelease(proxy)).toMatchObject({ value: undefined });
    expect(nexus.release(proxy)).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(4);
  });

  it("starts configured dials after listening without blocking ready", async () => {
    const target = { context: "host", route: { id: "original" } };
    const implementation = {
      listen: vi.fn(),
      connect: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    const nexus = new Nexus().configure({
      endpoint: {
        meta: { context: "client" },
        implementation,
        connectTo: [target],
      },
    });

    await nexus.ready();
    await vi.waitFor(() =>
      expect(implementation.connect).toHaveBeenCalledExactlyOnceWith(target),
    );
  });

  it("contains startup failures without retrying or failing local readiness", async () => {
    const failure = new Error("owner offline");
    const logged = vi.fn();
    const errorLog = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation((_message, details) => logged(details));
    try {
      const implementation = {
        listen: vi.fn(),
        connect: vi.fn(async () => {
          throw failure;
        }),
      };
      const nexus = new Nexus().configure({
        endpoint: {
          implementation,
          meta: {},
          connectTo: [{ context: "owner" }],
        },
      });

      await nexus.ready();
      await vi.waitFor(() => expect(logged).toHaveBeenCalled());
      await nexus.ready();
      expect(implementation.connect).toHaveBeenCalledOnce();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("does not initialize or dial when safeConnect receives an aborted signal", async () => {
    const ready = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const nexus = new Nexus();
    Object.assign(nexus as object, {
      lifecycle: "ready",
      initialization: Promise.resolve(),
      connectionManager: { safeResolveConnections: ready },
    });

    await expect(
      nexus.safeConnect({
        target: { context: "host" },
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ error: { code: "E_ABORTED" } });
    expect(ready).not.toHaveBeenCalled();
  });

  it("maps manager connection errors to public acquisition errors", async () => {
    const cases: readonly [NexusError, string][] = [
      [
        new NexusConnectionConstraintFailedError("constraint"),
        "E_CONNECTION_CONSTRAINT_FAILED",
      ],
      [
        new NexusProtocolIncompatibleError("protocol"),
        "E_PROTOCOL_INCOMPATIBLE",
      ],
      [
        new NexusHandshakeError("failed", "E_HANDSHAKE_FAILED"),
        "E_HANDSHAKE_FAILED",
      ],
      [
        new NexusEndpointCapabilityError("capability"),
        "E_ENDPOINT_CAPABILITY_MISMATCH",
      ],
      [new NexusEndpointConnectError("direct"), "E_ENDPOINT_CONNECT_FAILED"],
      [new NexusUsageError("usage"), "E_SERVICE_UNAVAILABLE"],
      [new NexusError("unknown", "E_UNKNOWN"), "E_SERVICE_UNAVAILABLE"],
    ];

    for (const [failure, code] of cases) {
      const nexus = new Nexus();
      const manager = {
        safeResolveConnections: vi.fn(async () => Result.err(failure)),
      };
      Object.assign(nexus as object, {
        lifecycle: {
          phase: "ready",
          engine: {},
          manager,
        },
        initialization: Promise.resolve(Result.ok(manager)),
      });
      const result = await nexus.safeConnect({ target: { context: "host" } });
      expect(result).toMatchObject({ error: { code } });
    }
  });
});
