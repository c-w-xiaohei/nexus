import {
  Nexus,
  NexusDisconnectedError,
  Token,
  type AdapterModel,
} from "@nexus-js/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createMockNexus } from "./index.js";

type AppMeta = {
  readonly context: "background" | "content" | "popup";
  readonly active?: boolean;
};
type ConnectionMeta = { readonly origin: string };
interface TestAdapterModel extends AdapterModel {
  contextMeta: AppMeta;
  connectionMeta: ConnectionMeta;
  connectionTarget: Partial<AppMeta>;
}
interface ExampleService {
  readonly greet: (name: string) => string;
  readonly explode: () => string;
  readonly hold: () => Promise<never>;
  readonly version: number;
  readonly acceptCallback: (callback: (value: string) => string) => string;
  readonly createReference: () => object;
  readonly useReference: (reference: object) => object;
}

const ExampleToken = new Token<ExampleService, TestAdapterModel>(
  "testing:example",
);
const MissingToken = new Token<ExampleService, TestAdapterModel>(
  "testing:missing",
);
const service = (label: string): ExampleService => ({
  greet: vi.fn((name: string) => `${label}:${name}`),
  explode: () => {
    throw new Error(label);
  },
  hold: () => new Promise<never>(() => {}),
  version: 1,
  acceptCallback: (callback) => callback(label),
  createReference: () => ({ label }),
  useReference: (reference) => reference,
});
const provider = (context: AppMeta["context"], origin: string = context) => ({
  target: { context },
  contextMeta: { context },
  connectionMeta: { origin },
});

describe("createMockNexus", () => {
  it("supports unscoped service, configured providers, and live providers", async () => {
    const manual = createMockNexus<TestAdapterModel>();
    manual.service(ExampleToken, service("manual"));
    await expect(
      (await manual.nexus.connect({ target: { context: "background" } }))
        .get(ExampleToken)
        .greet("Ada"),
    ).resolves.toBe("manual:Ada");

    const configured = createMockNexus<TestAdapterModel>();
    configured.nexus.configure({
      providers: [{ token: ExampleToken, service: service("configured") }],
    });
    await expect(
      (await configured.nexus.connect()).get(ExampleToken).greet("Ada"),
    ).resolves.toBe("configured:Ada");

    const provided = createMockNexus<TestAdapterModel>();
    expect(provided.nexus.provide(ExampleToken, service("provided"))).toBe(
      provided.nexus,
    );
    await expect(
      (await provided.nexus.connect()).get(ExampleToken).greet("Ada"),
    ).resolves.toBe("provided:Ada");
  });

  it("supports safe configure, provide, and ready", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    expect(mock.nexus.safeConfigure({}).isOk()).toBe(true);
    expect(mock.nexus.safeProvide(ExampleToken, service("safe")).isOk()).toBe(
      true,
    );
    expect((await mock.nexus.safeReady()).isOk()).toBe(true);
    await expect(mock.nexus.ready()).resolves.toBeUndefined();
  });

  it("uses explicit targets and supports services without registration metadata", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("manual"));

    const connection = await mock.nexus.connect({
      target: { context: "background" },
    });
    await expect(connection.get(ExampleToken).greet("Ada")).resolves.toBe(
      "manual:Ada",
    );
  });

  it("filters connections using both metadata arguments", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const where = vi.fn(
      (contextMeta: AppMeta, connectionMeta: ConnectionMeta) =>
        contextMeta.context === "popup" && connectionMeta.origin === "tab-2",
    );
    mock.service(ExampleToken, service("background"), provider("background"));
    mock.service(ExampleToken, service("popup"), provider("popup", "tab-2"));

    const connection = await mock.nexus.connect({ where });
    await expect(connection.get(ExampleToken).greet("Ada")).resolves.toBe(
      "popup:Ada",
    );
    expect(where).toHaveBeenCalledWith(
      { context: "background" },
      { origin: "background" },
    );
    expect(where).toHaveBeenCalledWith(
      { context: "popup" },
      { origin: "tab-2" },
    );
  });

  it("returns Result errors for no match, ambiguity, and a throwing predicate", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const missing = await mock.nexus.safeConnect({
      target: { context: "background" },
    });
    expect(missing).toMatchObject({ error: { code: "E_SERVICE_NO_MATCH" } });

    mock.service(ExampleToken, service("one"), provider("background"));
    mock.service(ExampleToken, service("two"), provider("popup"));
    const ambiguous = await mock.nexus.safeConnect();
    expect(ambiguous).toMatchObject({ error: { code: "E_SERVICE_AMBIGUOUS" } });

    const thrown = await mock.nexus.safeConnect({
      where: () => {
        throw new Error("bad where");
      },
    });
    expect(thrown).toMatchObject({
      error: {
        code: "E_USAGE_INVALID",
        context: { connectionId: expect.any(String) },
      },
    });
  });

  it("strictly validates connection options before recording calls", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const invalidOptions: unknown[] = [
      { target: null },
      { where: "no" },
      { timeout: Number.NaN },
      { timeout: 0 },
      { signal: {} },
      { unexpected: true },
    ];
    for (const options of invalidOptions) {
      const result = await mock.nexus.safeConnect(options as never);
      expect(result).toMatchObject({ error: { code: "E_USAGE_INVALID" } });
    }
    expect(mock.calls.connect()).toHaveLength(0);
  });

  it("strictly validates multicast options and keeps call records isolated", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const invalid = await mock.nexus.safeConnectMulticast({
      targets: [{ context: "background" }, undefined],
    } as never);
    expect(invalid).toMatchObject({ error: { code: "E_USAGE_INVALID" } });
    expect(mock.calls.connectMulticast()).toHaveLength(0);
    const calls = mock.calls.connectMulticast() as unknown[];
    calls.push({ options: {} });
    expect(mock.calls.connectMulticast()).toHaveLength(0);
  });

  it("waits for a passive connection, times out, and aborts without provider selection", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockNexus<TestAdapterModel>();
      const pending = mock.nexus.safeConnect({ timeout: 50 });
      mock.service(ExampleToken, service("late"), provider("background"));
      await Promise.resolve();
      const connected = await pending;
      expect(connected.isOk()).toBe(true);
      if (connected.isOk())
        await expect(
          connected.value.get(ExampleToken).greet("Ada"),
        ).resolves.toBe("late:Ada");

      const timeoutMock = createMockNexus<TestAdapterModel>();
      const timedOut = timeoutMock.nexus.safeConnect({ timeout: 10 });
      await vi.advanceTimersByTimeAsync(10);
      expect(await timedOut).toMatchObject({
        error: { code: "E_SERVICE_ACQUISITION_TIMEOUT" },
      });

      const abortedMock = createMockNexus<TestAdapterModel>();
      const controller = new globalThis.AbortController();
      const aborted = abortedMock.nexus.safeConnect({
        signal: controller.signal,
      });
      controller.abort();
      expect(await aborted).toMatchObject({ error: { code: "E_ABORTED" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects pre-aborted connection and multicast requests before binding a session", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const controller = new globalThis.AbortController();
    controller.abort();
    expect(
      await mock.nexus.safeConnect({ signal: controller.signal }),
    ).toMatchObject({ error: { code: "E_ABORTED" } });
    expect(
      await mock.nexus.safeConnectMulticast({ signal: controller.signal }),
    ).toMatchObject({ error: { code: "E_ABORTED" } });
    expect(mock.calls.connect()).toHaveLength(0);
    expect(mock.calls.connectMulticast()).toHaveLength(0);
  });

  it("returns per-connection Results from an ordered multicast snapshot", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("background"), provider("background"));
    mock.service(ExampleToken, service("popup"), provider("popup"));

    const collection = await mock.nexus.connectMulticast({
      targets: [{ context: "popup" }, { context: "background" }],
    });
    const resources = collection.get(ExampleToken);
    expect(resources).toHaveLength(2);
    const values = await Promise.all(
      resources.map(({ result }) => {
        if (result.isErr()) throw result.error;
        return result.value.greet("Ada");
      }),
    );
    expect(values).toEqual(["popup:Ada", "background:Ada"]);
  });

  it("rejects sparse multicast targets and preserves duplicate target order", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("background"), provider("background"));
    const sparse: Array<{ context: "background" }> = [];
    sparse.length = 1;
    const invalid = await mock.nexus.safeConnectMulticast({ targets: sparse });
    expect(invalid).toMatchObject({ error: { code: "E_USAGE_INVALID" } });

    const collection = await mock.nexus.connectMulticast({
      targets: [{ context: "background" }, { context: "background" }],
    });
    expect(collection.get(ExampleToken)).toHaveLength(1);
  });

  it("keeps a multicast collection fixed after later registrations and closes members", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("first"), provider("background"));
    const collection = await mock.nexus.connectMulticast();
    mock.service(ExampleToken, service("later"), provider("popup"));
    expect(collection.get(ExampleToken)).toHaveLength(1);
    const connection = collection.connections[0];
    connection.disconnect();
    expect(collection.get(ExampleToken)[0]?.result).toMatchObject({
      error: { code: "E_CONN_CLOSED" },
    });
  });

  it("supports an empty multicast snapshot without inventing a provider", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const collection = await mock.nexus.connectMulticast({ targets: [] });
    expect(collection.connections).toEqual([]);
    expect(collection.get(ExampleToken)).toEqual([]);
  });

  it("reports missing services per multicast connection rather than rejecting the collection", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("one"), provider("background"));
    const OtherToken = new Token<ExampleService, TestAdapterModel>(
      "testing:other",
    );
    const collection = await mock.nexus.connectMulticast();
    expect(collection.get(OtherToken)[0]?.result).toMatchObject({
      error: { code: "E_SERVICE_UNAVAILABLE" },
    });
  });

  it("keeps connections session-bound and supports replacement", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("old"), provider("background"));
    const oldConnection = await mock.nexus.connect({
      target: { context: "background" },
    });
    await expect(oldConnection.get(ExampleToken).greet("Ada")).resolves.toBe(
      "old:Ada",
    );
    oldConnection.disconnect();
    expect(() => oldConnection.get(ExampleToken)).toThrow(
      NexusDisconnectedError,
    );

    mock.service(ExampleToken, service("new"), provider("background"));
    const freshConnection = await mock.nexus.connect({
      target: { context: "background" },
    });
    await expect(freshConnection.get(ExampleToken).greet("Ada")).resolves.toBe(
      "new:Ada",
    );
  });

  it("observes connection and identity lifecycle events", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const observed: string[] = [];
    const onConnect = mock.nexus.onConnect((connection) => {
      observed.push(connection.id);
      connection.subscribeIdentity((meta) => observed.push(meta.context));
      connection.onDisconnected((reason) => observed.push(reason));
    });
    mock.service(ExampleToken, service("one"), provider("background"));
    await vi.waitFor(() => expect(observed).toHaveLength(2));
    const connection = await mock.nexus.connect({
      target: { context: "background" },
    });
    connection.disconnect();
    expect(observed).toEqual([connection.id, "background", "local"]);
    onConnect();
  });

  it("preserves lazy safeCall consumption and caching", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const implementation = service("lazy");
    mock.service(ExampleToken, implementation, provider("background"));
    const proxy = (
      await mock.nexus.connect({
        target: { context: "background" },
      })
    ).get(ExampleToken);
    const call = proxy.greet("Ada");
    expect(implementation.greet).not.toHaveBeenCalled();
    const first = await Nexus.safeCall(call);
    const second = await Nexus.safeCall(call);
    expect(first).toMatchObject({ value: "lazy:Ada" });
    expect(second).toMatchObject({ value: "lazy:Ada" });
    expect(implementation.greet).toHaveBeenCalledOnce();
  });

  it("caches lazy remote failures across repeated consumption", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const implementation = service("failure");
    mock.service(ExampleToken, implementation, provider("background"));
    const proxy = (
      await mock.nexus.connect({
        target: { context: "background" },
      })
    ).get(ExampleToken);
    const call = proxy.explode();
    await expect(Nexus.safeCall(call)).resolves.toMatchObject({
      error: { code: "E_REMOTE_EXCEPTION" },
    });
    await expect(Nexus.safeCall(call)).resolves.toMatchObject({
      error: { code: "E_REMOTE_EXCEPTION" },
    });
  });

  it("preserves callbacks, references, reflection, and remote errors", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("callback"), provider("background"));
    const proxy = (
      await mock.nexus.connect({
        target: { context: "background" },
      })
    ).get(ExampleToken);
    await expect(proxy.acceptCallback((value) => `${value}:ok`)).resolves.toBe(
      "callback:ok",
    );
    const reference = await proxy.createReference();
    await expect(proxy.useReference(reference)).resolves.toEqual({
      label: "callback",
    });
    expect((proxy as unknown as { then?: unknown }).then).toBeUndefined();
    expect(() => String(proxy)).not.toThrow();
    await expect(proxy.explode()).rejects.toMatchObject({
      code: "E_REMOTE_EXCEPTION",
    });
  });

  it("enforces call timeouts and validates connection/resource options", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("timeout"), provider("background"));
    const connection = await mock.nexus.connect({
      target: { context: "background" },
    });
    const proxy = connection.get(ExampleToken, { callTimeout: 10 });
    await expect(proxy.hold()).rejects.toMatchObject({
      code: "E_CALL_TIMEOUT",
    });
    const invalid = await mock.nexus.safeConnect({ timeout: 0 } as never);
    expect(invalid).toMatchObject({ error: { code: "E_USAGE_INVALID" } });
    expect(connection.safeGet(MissingToken)).toMatchObject({
      error: {
        code: "E_SERVICE_UNAVAILABLE",
        context: { connectionId: connection.id, serviceName: MissingToken.id },
      },
    });
  });

  it("applies configured callTimeout defaults and rejects invalid resource options", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.nexus.configure({ callTimeout: 10 });
    mock.service(ExampleToken, service("configured"), provider("background"));
    const connection = await mock.nexus.connect({
      target: { context: "background" },
    });
    await expect(connection.get(ExampleToken).hold()).rejects.toMatchObject({
      code: "E_CALL_TIMEOUT",
    });
    expect(
      connection.safeGet(ExampleToken, { callTimeout: -1 } as never),
    ).toMatchObject({ error: { code: "E_USAGE_INVALID" } });
  });

  it("delivers late observer notifications and stops identity observers on unsubscribe", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("observer"), provider("background"));
    const connection = await mock.nexus.connect({
      target: { context: "background" },
    });
    const identities: string[] = [];
    const unsubscribe = connection.subscribeIdentity((meta) =>
      identities.push(meta.context),
    );
    expect(identities).toEqual(["background"]);
    unsubscribe();
    connection.disconnect();
    const reasons: string[] = [];
    connection.onDisconnected((reason) => reasons.push(reason));
    expect(reasons).toEqual(["local"]);
    expect(identities).toEqual(["background"]);
  });

  it("records lifecycle calls, supports refs, and returns independent records", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("one"), provider("background"));
    await mock.nexus.connect({ target: { context: "background" } });
    const ref = mock.nexus.ref([]);
    expect(ref.target).toEqual([]);
    mock.nexus.release({});
    await mock.nexus.updateIdentity({ active: true });
    expect(mock.calls.release()).toHaveLength(1);
    expect(mock.calls.updateIdentity()).toEqual([
      { updates: { active: true } },
    ]);
    const calls = mock.calls.connect() as unknown[];
    calls.push({ options: {} });
    expect(mock.calls.connect()).toHaveLength(1);
    mock.clear();
    expect(mock.calls.connect()).toHaveLength(0);
    expect(mock.calls.configure()).toHaveLength(0);
  });

  it("clears only token-independent lifecycle records when no token is supplied", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("one"), provider("background"));
    await mock.nexus.connect({ target: { context: "background" } });
    mock.nexus.configure({});
    mock.nexus.release({});
    await mock.nexus.updateIdentity({ active: true });
    mock.clear(ExampleToken);
    expect(mock.calls.connect()).toHaveLength(1);
    expect(mock.calls.configure()).toHaveLength(1);
    expect(mock.calls.release()).toHaveLength(1);
    expect(mock.calls.updateIdentity()).toHaveLength(1);
    mock.clear();
    expect(mock.calls.connect()).toHaveLength(0);
    expect(mock.calls.configure()).toHaveLength(0);
    expect(mock.calls.release()).toHaveLength(0);
    expect(mock.calls.updateIdentity()).toHaveLength(0);
  });

  it("keeps the connection-only public shape and safe methods typed", () => {
    const mock = createMockNexus<TestAdapterModel>();
    expectTypeOf(mock.nexus).toMatchTypeOf<
      import("@nexus-js/core").NexusInstance<TestAdapterModel>
    >();
    expect(mock.nexus).toHaveProperty("connect");
    expect(mock.nexus).toHaveProperty("safeConnect");
    expect(mock.nexus).toHaveProperty("connectMulticast");
    expect(mock.nexus).toHaveProperty("safeConnectMulticast");
    expect(mock.nexus).not.toHaveProperty("create");
    expect(mock.nexus).not.toHaveProperty("select");
  });
});
