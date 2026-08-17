import {
  NexusUsageError,
  Token,
  type AdapterModel,
  type Asyncified,
  type NexusInstance,
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
  readonly version: number;
}

const ExampleToken = new Token<ExampleService, TestAdapterModel>(
  "testing:example",
  { defaultTarget: { context: "background" } },
);
const MissingToken = new Token<ExampleService, TestAdapterModel>(
  "testing:missing",
);
const service = (label: string) =>
  ({
    greet: vi.fn((name: string) => `${label}:${name}`),
    explode: () => {
      throw new Error(label);
    },
    version: 1,
  }) satisfies ExampleService;
const provider = (context: AppMeta["context"], origin: string = context) => ({
  target: { context },
  contextMeta: { context },
  connectionMeta: { origin },
});

describe("createMockNexus", () => {
  it("accepts unscoped mock.service, configure providers, and provide providers", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("manual"));
    await expect(
      (await mock.nexus.create(ExampleToken)).greet("Ada"),
    ).resolves.toBe("manual:Ada");
    const configured = createMockNexus<TestAdapterModel>();
    configured.nexus.configure({
      providers: [{ token: ExampleToken, service: service("configured") }],
    });
    await expect(
      (await configured.nexus.create(ExampleToken)).greet("Ada"),
    ).resolves.toBe("configured:Ada");
    const provided = createMockNexus<TestAdapterModel>();
    expect(provided.nexus.provide(ExampleToken, service("provided"))).toBe(
      provided.nexus,
    );
    await expect(
      (await provided.nexus.create(ExampleToken)).greet("Ada"),
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

  it("creates an async proxy from the first stable matching provider", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("first"), provider("background"));
    mock.service(
      ExampleToken,
      service("second"),
      provider("background", "two"),
    );

    const proxy = await mock.nexus.create(ExampleToken, {
      target: { context: "background" },
    });

    await expect(proxy.greet("Ada")).resolves.toBe("first:Ada");
    expect(mock.calls.create(ExampleToken)).toHaveLength(1);
  });

  it("resolves create targets explicitly, then from Token, then endpoint defaultTarget", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("background"), provider("background"));
    mock.service(ExampleToken, service("popup"), provider("popup"));
    mock.nexus.configure({ endpoint: { defaultTarget: { context: "popup" } } });

    await expect(
      (await mock.nexus.create(ExampleToken)).greet("Ada"),
    ).resolves.toBe("background:Ada");
    await expect(
      (
        await mock.nexus.create(ExampleToken, { target: { context: "popup" } })
      ).greet("Ada"),
    ).resolves.toBe("popup:Ada");
    const noDefault = new Token<ExampleService, TestAdapterModel>(
      "testing:configured",
    );
    mock.service(noDefault, service("configured"), provider("popup"));
    await expect(
      (await mock.nexus.create(noDefault)).greet("Ada"),
    ).resolves.toBe("configured:Ada");
  });

  it("selects immediately with exact two-argument where metadata", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const where = vi.fn(
      (contextMeta: AppMeta, connectionMeta: ConnectionMeta) =>
        contextMeta.context === "popup" && connectionMeta.origin === "tab-2",
    );
    mock.service(ExampleToken, service("background"), provider("background"));
    mock.service(ExampleToken, service("popup"), provider("popup", "tab-2"));

    const proxy = await mock.nexus.select(ExampleToken, { where });

    await expect(proxy.greet("Ada")).resolves.toBe("popup:Ada");
    expect(where).toHaveBeenCalledWith(
      { context: "background" },
      { origin: "background" },
    );
    expect(where).toHaveBeenCalledWith(
      { context: "popup" },
      { origin: "tab-2" },
    );
  });

  it("returns no-match and ambiguity errors for immediate select", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    await expect(mock.nexus.select(MissingToken)).rejects.toMatchObject({
      code: "E_SERVICE_NO_MATCH",
    });
    mock.service(ExampleToken, service("one"), provider("background"));
    mock.service(ExampleToken, service("two"), provider("popup"));
    const result = await mock.nexus.safeSelect(ExampleToken);
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toMatchObject({ code: "E_SERVICE_AMBIGUOUS" });
  });

  it("uses production codes for missing create targets and select wait timeout", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const unconfigured = new Token<ExampleService, TestAdapterModel>(
      "testing:unconfigured",
    );
    const targetResult = await mock.nexus.safeCreate(unconfigured);
    expect(targetResult).toMatchObject({
      error: { code: "E_TARGET_REQUIRED" },
    });

    vi.useFakeTimers();
    try {
      const pending = mock.nexus.safeSelect(MissingToken, {
        wait: { timeout: 10 },
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({
        error: { code: "E_SERVICE_WAIT_TIMEOUT" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers select rescan so same-turn provider registrations are ambiguous", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const pending = mock.nexus.safeSelect(ExampleToken, {
      wait: { timeout: 1_000 },
    });
    mock.service(ExampleToken, service("one"), provider("background"));
    mock.service(ExampleToken, service("two"), provider("popup"));

    const result = await pending;

    expect(result).toMatchObject({ error: { code: "E_SERVICE_AMBIGUOUS" } });
  });

  it("waits race-safely for a matching later provider and ignores unrelated registrations", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const pending = mock.nexus.select(ExampleToken, {
      where: (contextMeta: AppMeta) => contextMeta.context === "popup",
      wait: { timeout: 1_000 },
    });
    mock.service(ExampleToken, service("background"), provider("background"));
    mock.service(ExampleToken, service("popup"), provider("popup"));

    await expect((await pending).greet("Ada")).resolves.toBe("popup:Ada");
  });

  it("cleans waiting selection on abort", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const controller = new globalThis.AbortController();
    const pending = mock.nexus.safeSelect(ExampleToken, {
      wait: { signal: controller.signal },
    });
    controller.abort();
    const result = await pending;
    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toMatchObject({
        code: "E_ABORTED",
      });
  });

  it("does not let failCreate affect selection", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const failure = new Error("blocked");
    mock.service(ExampleToken, service("available"), provider("background"));
    mock.failCreate(ExampleToken, failure);
    await expect(mock.nexus.create(ExampleToken)).rejects.toBe(failure);
    await expect(
      (await mock.nexus.select(ExampleToken)).greet("Ada"),
    ).resolves.toBe("available:Ada");
  });

  it("accepts explicitly undefined optional acquisition options", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("available"), provider("background"));
    await expect(
      mock.nexus.create(ExampleToken, {
        timeout: undefined,
        callTimeout: undefined,
        signal: undefined,
      }),
    ).resolves.toBeDefined();
    await expect(
      mock.nexus.select(ExampleToken, {
        callTimeout: undefined,
        wait: { timeout: undefined, signal: undefined },
      }),
    ).resolves.toBeDefined();
  });

  it("rejects pre-aborted create and multicast signals before binding a provider", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("available"), provider("background"));
    const controller = new globalThis.AbortController();
    controller.abort();
    await expect(
      mock.nexus.create(ExampleToken, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "E_ABORTED" });
    await expect(
      mock.nexus.createMulticast(ExampleToken, {
        targets: [{ context: "background" }],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "E_ABORTED" });
  });

  it("waits for a late create provider with fake timers", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockNexus<TestAdapterModel>();
      const pending = mock.nexus.create(ExampleToken, { timeout: 50 });
      globalThis.setTimeout(
        () =>
          mock.service(ExampleToken, service("late"), provider("background")),
        10,
      );
      await vi.advanceTimersByTimeAsync(10);
      await expect((await pending).greet("Ada")).resolves.toBe("late:Ada");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses one deadline while waiting for staggered multicast targets", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockNexus<TestAdapterModel>();
      const pending = mock.nexus.safeCreateMulticast(ExampleToken, {
        targets: [{ context: "background" }, { context: "popup" }],
        timeout: 30,
      });
      globalThis.setTimeout(
        () =>
          mock.service(
            ExampleToken,
            service("background"),
            provider("background"),
          ),
        10,
      );
      globalThis.setTimeout(
        () => mock.service(ExampleToken, service("popup"), provider("popup")),
        35,
      );
      await vi.advanceTimersByTimeAsync(35);
      const result = await pending;
      expect(result.isErr()).toBe(true);
      if (result.isErr())
        expect(result.error).toMatchObject({
          code: "E_SERVICE_ACQUISITION_TIMEOUT",
        });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves staggered multicast targets in stable target order", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockNexus<TestAdapterModel>();
      const pending = mock.nexus.createMulticast(ExampleToken, {
        targets: [{ context: "background" }, { context: "popup" }],
        timeout: 30,
      });
      globalThis.setTimeout(
        () =>
          mock.service(
            ExampleToken,
            service("target-a"),
            provider("background"),
          ),
        10,
      );
      globalThis.setTimeout(
        () =>
          mock.service(ExampleToken, service("target-b"), provider("popup")),
        20,
      );

      await vi.advanceTimersByTimeAsync(20);
      const multicast = await pending;

      await expect(multicast.greet("Ada")).resolves.toEqual([
        { status: "fulfilled", value: "target-a:Ada" },
        { status: "fulfilled", value: "target-b:Ada" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails multicast if any explicit target has no provider and deduplicates matching providers", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("background"), provider("background"));
    const missing = await mock.nexus.safeCreateMulticast(ExampleToken, {
      targets: [{ context: "background" }, { context: "popup" }],
      timeout: 0,
    });
    expect(missing.isErr()).toBe(true);
    const all = await mock.nexus.createMulticast(ExampleToken, {
      targets: [{ context: "background" }, { context: "background" }],
    });
    await expect(all.greet("Ada")).resolves.toEqual([
      { status: "fulfilled", value: "background:Ada" },
    ]);
  });

  it("returns all and stream select multicast snapshots without from metadata", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("background"), provider("background"));
    mock.service(ExampleToken, service("popup"), provider("popup"));
    const all = await mock.nexus.selectMulticast(ExampleToken);
    const stream = await mock.nexus.selectMulticast(ExampleToken, {
      expects: "stream",
    });
    const streamed = [];
    for await (const value of await stream.greet("Ada")) streamed.push(value);
    await expect(all.greet("Ada")).resolves.toEqual([
      { status: "fulfilled", value: "background:Ada" },
      { status: "fulfilled", value: "popup:Ada" },
    ]);
    expect(streamed).toEqual([
      { status: "fulfilled", value: "background:Ada" },
      { status: "fulfilled", value: "popup:Ada" },
    ]);
    expect(streamed[0]).not.toHaveProperty("from");
  });

  it("settles multicast value properties for all and stream", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("background"), provider("background"));
    const all = await mock.nexus.createMulticast(ExampleToken, {
      targets: [{ context: "background" }],
    });
    const stream = await mock.nexus.createMulticast(ExampleToken, {
      targets: [{ context: "background" }],
      expects: "stream",
    });
    await expect(all.version).resolves.toEqual([
      { status: "fulfilled", value: 1 },
    ]);
    const values = [];
    for await (const value of await stream.version) values.push(value);
    expect(values).toEqual([{ status: "fulfilled", value: 1 }]);
  });

  it("preserves proxy reflection and rejects service method errors", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("boom"));
    const proxy = await mock.nexus.create(ExampleToken);
    expect((proxy as unknown as { then?: unknown }).then).toBeUndefined();
    expect(() => String(proxy)).not.toThrow();
    await expect(proxy.explode()).rejects.toThrow("boom");
  });

  it("records release and identity updates, and accepts array refs", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    const ref = mock.nexus.ref([]);
    expect(ref.target).toEqual([]);
    mock.nexus.release({});
    await mock.nexus.updateIdentity({ active: true });
    expect(mock.calls.release()).toHaveLength(1);
    expect(mock.calls.updateIdentity()).toEqual([
      { updates: { active: true } },
    ]);
    expect(mock.nexus.safeRef(null as never).isErr()).toBe(true);
  });

  it("clears token acquisition records without clearing unrelated lifecycle records", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("one"), provider("background"));
    await mock.nexus.create(ExampleToken);
    await mock.nexus.createMulticast(ExampleToken, {
      targets: [{ context: "background" }],
    });
    await mock.nexus.select(ExampleToken);
    await mock.nexus.selectMulticast(ExampleToken);
    mock.nexus.configure({});
    mock.nexus.release({});
    await mock.nexus.updateIdentity({ active: true });
    mock.clear(ExampleToken);
    expect(mock.calls.create(ExampleToken)).toHaveLength(0);
    expect(mock.calls.createMulticast(ExampleToken)).toHaveLength(0);
    expect(mock.calls.select(ExampleToken)).toHaveLength(0);
    expect(mock.calls.selectMulticast(ExampleToken)).toHaveLength(0);
    expect(mock.calls.configure()).toHaveLength(1);
    expect(mock.calls.release()).toHaveLength(1);
    expect(mock.calls.updateIdentity()).toHaveLength(1);
  });

  it("returns independent call record arrays and clears all records", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    mock.service(ExampleToken, service("one"));
    await mock.nexus.create(ExampleToken);
    const calls = mock.calls.create() as unknown as unknown[];
    calls.push({});
    expect(mock.calls.create()).toHaveLength(1);
    mock.clear();
    expect(mock.calls.create()).toHaveLength(0);
    expect(mock.calls.configure()).toHaveLength(0);
  });

  it("strictly validates acquisition option keys and values before recording", async () => {
    const mock = createMockNexus<TestAdapterModel>();
    for (const options of [
      { target: null },
      { where: "no" },
      { timeout: Number.NaN },
      { signal: {} },
      { callTimeout: -1 },
      { unexpected: true },
    ]) {
      await expect(
        mock.nexus.create(ExampleToken, options as never),
      ).rejects.toBeInstanceOf(NexusUsageError);
    }
    await expect(
      mock.nexus.select(ExampleToken, {
        target: { context: "background" },
      } as never),
    ).rejects.toBeInstanceOf(NexusUsageError);
    expect(mock.calls.create()).toHaveLength(0);
    expect(mock.calls.select()).toHaveLength(0);
  });

  it("keeps safe methods as Promise<Result> and exposes final required methods", () => {
    const mock = createMockNexus<TestAdapterModel>();
    expectTypeOf(mock.nexus).toMatchTypeOf<NexusInstance<TestAdapterModel>>();
    if (false) {
      expectTypeOf(mock.nexus.create(ExampleToken)).toEqualTypeOf<
        Promise<Asyncified<ExampleService>>
      >();
    }
    expect(mock.nexus).toHaveProperty("select");
    expect(mock.nexus).toHaveProperty("safeSelect");
    expect(mock.nexus).toHaveProperty("selectMulticast");
    expect(mock.nexus).toHaveProperty("safeSelectMulticast");
  });
});
