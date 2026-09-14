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
      Object.assign(nexus as object, {
        lifecycle: "ready",
        initialization: Promise.resolve(),
        engine: {},
        connectionManager: {
          safeResolveConnections: vi.fn(async () => Result.err(failure)),
        },
      });
      const result = await nexus.safeConnect({ target: { context: "host" } });
      expect(result).toMatchObject({ error: { code } });
    }
  });
});
