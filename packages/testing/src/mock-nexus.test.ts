import {
  NexusUsageError,
  Token,
  type Asyncified,
  type NexusConfig,
  type NexusInstance,
} from "@nexus-js/core";
import {
  connectNexusStore,
  defineNexusStore,
  provideNexusStore,
} from "@nexus-js/core/state";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createMockNexus, NexusMockError } from "./index";

type AppMeta = {
  context: "background" | "content" | "popup";
  active?: boolean;
  instance?: string;
};

type PlatformMeta = {
  origin?: string;
};

interface ExampleService {
  greet(name: string): string;
  greetAsync(name: string): Promise<string>;
  explode(): string;
  version: number;
  delayedVersion: Promise<number>;
  nested: {
    label: string;
    getLabel(): string;
  };
}

const ExampleToken = new Token<ExampleService>("testing:example");
const OtherToken = new Token<ExampleService>("testing:other");
const MissingToken = new Token<ExampleService>("testing:missing");

const createOptions = {
  target: { descriptor: { context: "background" as const } },
};

const createExampleService = () =>
  ({
    greet: vi.fn((name: string) => `hello ${name}`),
    greetAsync: vi.fn(async (name: string) => `async ${name}`),
    explode: vi.fn(() => {
      throw new Error("boom");
    }),
    version: 3,
    delayedVersion: Promise.resolve(4),
    nested: {
      label: "raw-nested",
      getLabel: () => "nested-label",
    },
  }) satisfies ExampleService;

describe("NexusMockError", () => {
  it("preserves code, context, name, and cause", () => {
    const cause = new Error("root cause");
    const error = new NexusMockError(
      "missing service",
      "E_MOCK_SERVICE_NOT_FOUND",
      { tokenId: "testing:missing" },
      { cause },
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NexusMockError");
    expect(error.message).toBe("missing service");
    expect(error.code).toBe("E_MOCK_SERVICE_NOT_FOUND");
    expect(error.context).toEqual({ tokenId: "testing:missing" });
    expect(error.cause).toBe(cause);
  });
});

describe("createMockNexus", () => {
  it("returns an async proxy for a registered service", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    const service = createExampleService();
    mock.service(ExampleToken, service);

    const proxy = await mock.nexus.create(ExampleToken, createOptions);

    await expect(proxy.greet("Ada")).resolves.toBe("hello Ada");
    expect(service.greet).toHaveBeenCalledWith("Ada");
    await expect(proxy.greetAsync("Ada")).resolves.toBe("async Ada");
    expect(service.greetAsync).toHaveBeenCalledWith("Ada");
    await expect(proxy.version).resolves.toBe(3);
    await expect(proxy.delayedVersion).resolves.toBe(4);
  });

  it("keeps nested object values raw inside the resolved property promise", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    const service = createExampleService();
    mock.service(ExampleToken, service);

    const proxy = await mock.nexus.create(ExampleToken, createOptions);
    const nested = await proxy.nested;

    expect(nested).toBe(service.nested);
    expect(nested.label).toBe("raw-nested");
    expect(nested.getLabel()).toBe("nested-label");
  });

  it("converts service method throws into rejected promises", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    const service = createExampleService();
    mock.service(ExampleToken, service);

    const proxy = await mock.nexus.create(ExampleToken, createOptions);

    await expect(proxy.explode()).rejects.toThrow("boom");
    expect(service.explode).toHaveBeenCalledOnce();
  });

  it("creates proxies that are not thenable and tolerate reflection", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    mock.service(ExampleToken, createExampleService());

    const proxy = await mock.nexus.create(ExampleToken, createOptions);

    expect((proxy as unknown as { then?: unknown }).then).toBeUndefined();
    expect(typeof (proxy as unknown as { toString: unknown }).toString).toBe(
      "function",
    );
    expect(() => String(proxy)).not.toThrow();
    expect(() => Reflect.ownKeys(proxy)).not.toThrow();
  });

  it("rejects create with E_MOCK_SERVICE_NOT_FOUND for an unregistered token", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();

    await expect(
      mock.nexus.create(MissingToken, createOptions),
    ).rejects.toMatchObject({
      name: "NexusMockError",
      code: "E_MOCK_SERVICE_NOT_FOUND",
      context: { tokenId: "testing:missing" },
    });
  });

  it("returns ok from safeCreate for a registered service", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    mock.service(ExampleToken, createExampleService());

    const result = await mock.nexus.safeCreate(ExampleToken, createOptions);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      await expect(result.value.greet("Grace")).resolves.toBe("hello Grace");
    }
  });

  it("returns err from safeCreate for an unregistered token", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();

    const result = await mock.nexus.safeCreate(MissingToken, createOptions);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusMockError);
      expect(result.error).toMatchObject({
        code: "E_MOCK_SERVICE_NOT_FOUND",
        context: { tokenId: "testing:missing" },
      });
    }
  });

  it("returns err from safeCreate for malformed runtime input", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    mock.service(ExampleToken, createExampleService());

    const result = await mock.nexus.safeCreate(
      ExampleToken,
      undefined as never,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusUsageError);
    }
  });

  it("makes create and safeCreate expose the same injected failure", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    const service = createExampleService();
    const injected = new Error("offline");
    mock.service(ExampleToken, service);
    mock.failCreate(ExampleToken, injected);

    await expect(mock.nexus.create(ExampleToken, createOptions)).rejects.toBe(
      injected,
    );
    const result = await mock.nexus.safeCreate(ExampleToken, createOptions);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBe(injected);
    }
    expect(service.greet).not.toHaveBeenCalled();
  });

  it("records create calls and filters them by token", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    const service = createExampleService();
    const options = {
      target: { descriptor: { context: "background" as const } },
      timeout: 123,
    };
    mock.service(ExampleToken, service);

    await mock.nexus.create(ExampleToken, options);

    expect(mock.calls.create()).toHaveLength(1);
    expect(mock.calls.create(ExampleToken)).toHaveLength(1);
    expect(mock.calls.create(OtherToken)).toHaveLength(0);
    expect(mock.calls.create(ExampleToken)[0]).toMatchObject({
      tokenId: "testing:example",
      token: ExampleToken,
      options,
    });
  });

  it("records failed create attempts", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();

    await expect(
      mock.nexus.create(MissingToken, createOptions),
    ).rejects.toThrow();

    expect(mock.calls.create()).toHaveLength(1);
    expect(mock.calls.create(MissingToken)[0]).toMatchObject({
      tokenId: "testing:missing",
      token: MissingToken,
      options: createOptions,
    });
  });

  it("returns create call copies", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    mock.service(ExampleToken, createExampleService());

    await mock.nexus.create(ExampleToken, createOptions);

    const calls = mock.calls.create() as unknown as unknown[];
    calls.push({ tokenId: "mutated" });

    expect(mock.calls.create()).toHaveLength(1);
    expect(mock.calls.create()[0]?.tokenId).toBe("testing:example");
  });

  it("accepts an empty target when the token has a default target", async () => {
    const tokenWithDefault = new Token<ExampleService>(
      "testing:default-target",
      { descriptor: { context: "background" } },
    );
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    mock.service(tokenWithDefault, createExampleService());

    const proxy = await mock.nexus.create(tokenWithDefault, { target: {} });

    await expect(proxy.greet("Ada")).resolves.toBe("hello Ada");
  });

  it("accepts an empty target when endpoint connectTo has one target", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    mock.service(ExampleToken, createExampleService());
    mock.nexus.configure({
      endpoint: {
        meta: { context: "content" },
        connectTo: [{ descriptor: { context: "background" } }],
      },
    });

    const proxy = await mock.nexus.create(ExampleToken, { target: {} });

    await expect(proxy.greet("Ada")).resolves.toBe("hello Ada");
  });

  it("uses an explicit target before ambiguous connectTo fallback", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    mock.service(ExampleToken, createExampleService());
    mock.nexus.configure({
      endpoint: {
        meta: { context: "content" },
        connectTo: [
          { descriptor: { context: "background" } },
          { descriptor: { context: "popup" } },
        ],
      },
    });

    const proxy = await mock.nexus.create(ExampleToken, createOptions);

    await expect(proxy.greet("Ada")).resolves.toBe("hello Ada");
  });

  it("rejects an empty target when connectTo fallback is ambiguous", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    mock.service(ExampleToken, createExampleService());
    mock.nexus.configure({
      endpoint: {
        meta: { context: "content" },
        connectTo: [
          { descriptor: { context: "background" } },
          { descriptor: { context: "popup" } },
        ],
      },
    });

    await expect(
      mock.nexus.create(ExampleToken, { target: {} }),
    ).rejects.toMatchObject({ code: "E_TARGET_UNEXPECTED_COUNT" });
  });

  it("rejects an empty target without a default target or connectTo fallback", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    mock.service(ExampleToken, createExampleService());

    await expect(
      mock.nexus.create(ExampleToken, { target: {} }),
    ).rejects.toMatchObject({ code: "E_TARGET_NO_MATCH" });
  });

  it("records configure, registers services, and does not execute policy", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    const service = createExampleService();
    const canConnect = vi.fn(() => true);
    const canCall = vi.fn(() => true);
    const config = {
      services: [{ token: ExampleToken, implementation: service }],
      matchers: {
        active: (identity: AppMeta) => identity.active === true,
      },
      descriptors: {
        background: { context: "background" },
      },
      endpoint: {
        meta: { context: "content" },
        connectTo: [{ descriptor: "background" }],
      },
      policy: { canConnect, canCall },
    } satisfies NexusConfig<AppMeta, PlatformMeta>;

    const configured = mock.nexus.configure(config);
    const proxy = await configured.create(ExampleToken, {
      target: { descriptor: "background" },
    });

    expect(configured).toBe(mock.nexus);
    expect(mock.calls.configure()).toEqual([{ config }]);
    await expect(proxy.greet("Ada")).resolves.toBe("hello Ada");
    expect(canConnect).not.toHaveBeenCalled();
    expect(canCall).not.toHaveBeenCalled();
  });

  it("preserves endpoint configuration across incremental configure calls", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();

    mock.nexus.configure({
      endpoint: {
        meta: { context: "content" },
        connectTo: [{ descriptor: { context: "background" } }],
      },
    });
    mock.nexus.configure({
      services: [
        { token: ExampleToken, implementation: createExampleService() },
      ],
    });

    const proxy = await mock.nexus.create(ExampleToken, { target: {} });

    await expect(proxy.greet("Ada")).resolves.toBe("hello Ada");
  });

  it("rejects unknown named descriptors and matchers during create", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    const configured = mock.nexus.configure({
      services: [
        { token: ExampleToken, implementation: createExampleService() },
      ],
      descriptors: { background: { context: "background" } },
      matchers: { active: (identity) => identity.active === true },
    });

    await expect(
      configured.create(ExampleToken, {
        target: { descriptor: "missing" as never },
      }),
    ).rejects.toBeInstanceOf(NexusUsageError);
    await expect(
      configured.create(ExampleToken, {
        target: { matcher: "missing" as never },
      }),
    ).rejects.toBeInstanceOf(NexusUsageError);
  });

  it("returns ok from safeConfigure with the same nexus", () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    const service = createExampleService();
    const config = {
      services: [{ token: ExampleToken, implementation: service }],
    } satisfies NexusConfig<AppMeta, PlatformMeta>;

    const result = mock.nexus.safeConfigure(config);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(mock.nexus);
    }
    expect(mock.calls.configure()).toEqual([{ config }]);
  });

  it("returns configure call copies", () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    mock.nexus.configure({});

    const calls = mock.calls.configure() as unknown as unknown[];
    calls.push({ config: { mutated: true } });

    expect(mock.calls.configure()).toHaveLength(1);
    expect(mock.calls.configure()[0]?.config).toEqual({});
  });

  it("matches inline and configured named matchers", () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    const configured = mock.nexus.configure({
      matchers: {
        active: (identity) => identity.active === true,
      },
    });

    const andMatcher = configured.matchers.and(
      "active",
      (identity) => identity.context === "background",
    );
    const orMatcher = configured.matchers.or(
      "active",
      (identity) => identity.context === "popup",
    );
    const notMatcher = configured.matchers.not("active");

    expect(andMatcher({ context: "background", active: true })).toBe(true);
    expect(andMatcher({ context: "background", active: false })).toBe(false);
    expect(orMatcher({ context: "popup", active: false })).toBe(true);
    expect(orMatcher({ context: "content", active: false })).toBe(false);
    expect(notMatcher({ context: "background", active: true })).toBe(false);
    expect(notMatcher({ context: "background", active: false })).toBe(true);
  });

  it("matches unknown named matchers with core combinator semantics", () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    const identity = { context: "background", active: true } satisfies AppMeta;

    const runtimeMatchers = mock.nexus.matchers as unknown as {
      and(name: string): (identity: AppMeta) => boolean;
      or(name: string): (identity: AppMeta) => boolean;
      not(name: string): (identity: AppMeta) => boolean;
    };

    expect(runtimeMatchers.and("missing")(identity)).toBe(false);
    expect(runtimeMatchers.or("missing")(identity)).toBe(false);
    expect(runtimeMatchers.not("missing")(identity)).toBe(true);
  });

  it("records release and safeRelease calls", () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    const firstProxy = {};
    const secondProxy = {};

    mock.nexus.release(firstProxy);
    const result = mock.nexus.safeRelease(secondProxy);

    expect(result.isOk()).toBe(true);
    expect(mock.calls.release()).toEqual([
      { proxy: firstProxy },
      { proxy: secondProxy },
    ]);
  });

  it("records updateIdentity and safeUpdateIdentity calls", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();

    await mock.nexus.updateIdentity({ active: true, instance: "one" });
    const result = await mock.nexus.safeUpdateIdentity({ active: false });

    expect(result.isOk()).toBe(true);
    expect(mock.calls.updateIdentity()).toEqual([
      { updates: { active: true, instance: "one" } },
      { updates: { active: false } },
    ]);
  });

  it("returns release and updateIdentity call copies", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    mock.nexus.release({});
    await mock.nexus.updateIdentity({ active: true });

    const releaseCalls = mock.calls.release() as unknown as unknown[];
    const updateCalls = mock.calls.updateIdentity() as unknown as unknown[];
    releaseCalls.push({ proxy: "mutated" });
    updateCalls.push({ updates: { mutated: true } });

    expect(mock.calls.release()).toHaveLength(1);
    expect(mock.calls.updateIdentity()).toHaveLength(1);
  });

  it("wraps object refs and rejects invalid refs", () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    const target = { value: 1 };

    const ref = mock.nexus.ref(target);
    const safeRef = mock.nexus.safeRef(target);
    const invalid = mock.nexus.safeRef(null as never);

    expect(ref.target).toBe(target);
    expect((ref as any)[Symbol.for("nexus.ref.wrapper")]).toBe(true);
    expect(safeRef.isOk()).toBe(true);
    if (safeRef.isOk()) {
      expect(safeRef.value.target).toBe(target);
    }
    expect(() => mock.nexus.ref(null as never)).toThrow(NexusUsageError);
    expect(() => mock.nexus.ref(123 as never)).toThrow(NexusUsageError);
    expect(invalid.isErr()).toBe(true);
    if (invalid.isErr()) {
      expect(invalid.error).toBeInstanceOf(NexusUsageError);
    }
  });

  it("rejects unsupported multicast APIs", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();

    await expect(
      mock.nexus.createMulticast(ExampleToken, {
        target: { descriptor: { context: "background" } },
      }),
    ).rejects.toMatchObject({
      name: "NexusMockError",
      code: "E_MOCK_UNSUPPORTED_OPERATION",
    });

    const result = await mock.nexus.safeCreateMulticast(ExampleToken, {
      target: { descriptor: { context: "background" } },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusMockError);
      expect(result.error).toMatchObject({
        code: "E_MOCK_UNSUPPORTED_OPERATION",
      });
    }
  });

  it("clear(token) removes only that token service, failure, and create calls", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    mock.service(ExampleToken, createExampleService());
    mock.service(OtherToken, createExampleService());
    await mock.nexus.create(ExampleToken, createOptions);
    await mock.nexus.create(OtherToken, createOptions);
    mock.failCreate(ExampleToken, new Error("blocked"));
    mock.nexus.release({});
    mock.nexus.configure({});
    await mock.nexus.updateIdentity({ active: true });

    mock.clear(ExampleToken);

    expect(mock.calls.create(ExampleToken)).toHaveLength(0);
    expect(mock.calls.create(OtherToken)).toHaveLength(1);
    await expect(
      mock.nexus.create(ExampleToken, createOptions),
    ).rejects.toMatchObject({ code: "E_MOCK_SERVICE_NOT_FOUND" });
    const otherProxy = await mock.nexus.create(OtherToken, createOptions);
    await expect(otherProxy.greet("Ada")).resolves.toBe("hello Ada");
    expect(mock.calls.configure()).toHaveLength(1);
    expect(mock.calls.release()).toHaveLength(1);
    expect(mock.calls.updateIdentity()).toHaveLength(1);
  });

  it("clear() removes all services, failures, and call records", async () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    mock.service(ExampleToken, createExampleService());
    mock.failCreate(OtherToken, new Error("blocked"));
    await mock.nexus.create(ExampleToken, createOptions);
    await expect(
      mock.nexus.create(OtherToken, createOptions),
    ).rejects.toThrow();
    mock.nexus.configure({});
    mock.nexus.release({});
    await mock.nexus.updateIdentity({ active: true });

    mock.clear();

    expect(mock.calls.create()).toHaveLength(0);
    expect(mock.calls.configure()).toHaveLength(0);
    expect(mock.calls.release()).toHaveLength(0);
    expect(mock.calls.updateIdentity()).toHaveLength(0);
    await expect(
      mock.nexus.create(ExampleToken, createOptions),
    ).rejects.toMatchObject({ code: "E_MOCK_SERVICE_NOT_FOUND" });
    const result = await mock.nexus.safeCreate(OtherToken, createOptions);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toMatchObject({ code: "E_MOCK_SERVICE_NOT_FOUND" });
    }
  });

  it("supports connectNexusStore with a provided store service", async () => {
    const CounterToken = new Token<any>("testing:counter-store");
    const counterStore = defineNexusStore({
      token: CounterToken,
      state: () => ({ count: 0 }),
      actions: ({ getState, setState }) => ({
        increment(by: number) {
          const next = getState().count + by;
          setState({ count: next });
          return next;
        },
      }),
    });
    const mock = createMockNexus<AppMeta, PlatformMeta>();
    mock.nexus.configure({
      services: [provideNexusStore(counterStore)],
      endpoint: {
        meta: { context: "background" },
        connectTo: [{ descriptor: { context: "background" } }],
      },
    });

    const remote = await connectNexusStore(mock.nexus, counterStore, {
      target: { descriptor: { context: "background" } },
    });

    expect(remote.getState()).toEqual({ count: 0 });
    await expect(remote.actions.increment(2)).resolves.toBe(2);
    expect(remote.getState()).toEqual({ count: 2 });
    expect(mock.calls.create(counterStore.token)).toHaveLength(1);
    remote.destroy();
  });

  it("preserves public types", () => {
    const mock = createMockNexus<AppMeta, PlatformMeta>();

    mock.service(ExampleToken, createExampleService());
    // @ts-expect-error missing required service members
    mock.service(ExampleToken, { greet: (name: string) => name });

    expectTypeOf(mock.nexus.create(ExampleToken, createOptions)).toEqualTypeOf<
      Promise<Asyncified<ExampleService>>
    >();
    expectTypeOf(mock.nexus).toMatchTypeOf<
      NexusInstance<AppMeta, PlatformMeta>
    >();

    const configured = mock.nexus.configure({
      matchers: {
        active: (identity: AppMeta) => identity.active === true,
      },
      descriptors: {
        background: { context: "background" },
      },
    });

    expectTypeOf(configured).toMatchTypeOf<
      NexusInstance<AppMeta, PlatformMeta, "active", "background">
    >();
    configured.matchers.and("active");
    configured.matchers.or("active");
    configured.matchers.not("active");
    configured.create(ExampleToken, {
      target: { descriptor: "background", matcher: "active" },
    });

    // @ts-expect-error mock.nexus does not evolve in place
    mock.nexus.matchers.and("active");
    expectTypeOf(mock.nexus.create).parameter(1).toEqualTypeOf<{
      target: {
        descriptor?: Partial<AppMeta>;
        matcher?: (identity: AppMeta) => boolean;
      };
      expects?: "one" | "first";
      timeout?: number;
    }>();

    mock.nexus.matchers.and((identity) => identity.context === "background");
    mock.nexus.matchers.or((identity) => identity.active === true);
    mock.nexus.matchers.not((identity) => identity.context === "popup");
  });
});
