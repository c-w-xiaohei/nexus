import { describe, expect, it, vi } from "vitest";
import { Nexus } from "./nexus";
import { NexusUsageError } from "../errors/usage-errors";
import { Token } from "./token";
import { okAsync } from "neverthrow";
describe("Nexus Safe API Edge Cases", () => {
  const waitForLifecycleState = async (nexus: Nexus, state: string) => {
    await vi.waitFor(() => {
      expect((nexus as any).lifecycleState).toBe(state);
    });
  };

  const createNexus = () => {
    const instance = new Nexus();
    instance.configure({
      endpoint: {
        meta: { context: "test" },
        implementation: {},
      },
    });
    return instance;
  };

  describe("safeConfigure", () => {
    it("should return error for invalid input", () => {
      const nexus = createNexus();
      const result = nexus.safeConfigure(null as any);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(NexusUsageError);
      }
    });

    it("preserves configured service implementation identity and symbol hooks", async () => {
      const nexus = new Nexus();
      const hook = Symbol("service hook");
      const implementation = {
        ping: () => "pong",
        [hook]: vi.fn(),
      };
      const token = new Token<typeof implementation>("service-with-hook");

      nexus.configure({
        endpoint: {
          meta: { context: "test" },
          implementation: {},
        },
      });
      nexus.configure({
        services: [{ token, implementation }],
      });

      await nexus.safeUpdateIdentity({ context: "ready" });

      const registered = (
        nexus as any
      ).engine.resourceManager.getExposedService(token.id);
      expect(registered).toBe(implementation);
      expect((registered as typeof implementation)[hook]).toBe(
        implementation[hook],
      );
    });

    it("appends services across repeated configure calls by reference", async () => {
      const nexus = new Nexus();
      const first = { ping: () => "first" };
      const second = { ping: () => "second" };
      const firstToken = new Token<typeof first>("first-service");
      const secondToken = new Token<typeof second>("second-service");

      nexus.configure({
        endpoint: {
          meta: { context: "test" },
          implementation: {},
        },
        services: [{ token: firstToken, implementation: first }],
      });
      nexus.configure({
        services: [{ token: secondToken, implementation: second }],
      });

      await nexus.safeUpdateIdentity({ context: "ready" });

      const resourceManager = (nexus as any).engine.resourceManager;
      expect(resourceManager.getExposedService(firstToken.id)).toBe(first);
      expect(resourceManager.getExposedService(secondToken.id)).toBe(second);
    });

    it("returns an error for invalid input after ready instead of throwing", async () => {
      const nexus = createNexus();
      await nexus.ready();

      expect(() => nexus.safeConfigure(null as any)).not.toThrow();
      const result = nexus.safeConfigure(null as any);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect((result.error as any).code).toBe("E_USAGE_INVALID");
      }
    });
  });

  describe("provide", () => {
    it("normalizes token and registration overloads into the same provider registry", async () => {
      const nexus = new Nexus();
      const first = { ping: () => "first" };
      const second = { ping: () => "second" };
      const firstToken = new Token<typeof first>("provide:first");
      const secondToken = new Token<typeof second>("provide:second");

      nexus.provide(firstToken, first).provide({
        token: secondToken,
        implementation: second,
      });
      nexus.configure({
        endpoint: {
          meta: { context: "test" },
          implementation: {},
        },
      });

      await nexus.ready();

      const resourceManager = (nexus as any).engine.resourceManager;
      expect(resourceManager.getExposedService(firstToken.id)).toBe(first);
      expect(resourceManager.getExposedService(secondToken.id)).toBe(second);
    });

    it("rejects duplicate token ids without partially registering a batch", async () => {
      const nexus = new Nexus();
      const existing = { ping: () => "existing" };
      const duplicate = { ping: () => "duplicate" };
      const added = { ping: () => "added" };
      const existingToken = new Token<typeof existing>("provide:duplicate");
      const sameIdToken = new Token<typeof duplicate>("provide:duplicate");
      const addedToken = new Token<typeof added>("provide:added");

      nexus.provide(existingToken, existing);

      const result = nexus.safeProvide([
        { token: sameIdToken, implementation: duplicate },
        { token: addedToken, implementation: added },
      ]);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect((result.error as any).code).toBe("E_PROVIDER_BATCH_INVALID");
        expect((result.error as any).context.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "E_PROVIDER_DUPLICATE_TOKEN" }),
          ]),
        );
      }

      nexus.configure({
        endpoint: {
          meta: { context: "test" },
          implementation: {},
        },
      });
      await nexus.ready();

      const resourceManager = (nexus as any).engine.resourceManager;
      expect(resourceManager.getExposedService(existingToken.id)).toBe(
        existing,
      );
      expect(resourceManager.getExposedService(addedToken.id)).toBeUndefined();
    });

    it("live-registers providers after ready", async () => {
      const nexus = createNexus();
      await nexus.ready();

      const service = { ping: () => "pong" };
      const token = new Token<typeof service>("provide:live");
      const result = nexus.safeProvide(token, service);

      expect(result.isOk()).toBe(true);
      expect(
        (nexus as any).engine.resourceManager.getExposedService(token.id),
      ).toBe(service);
    });

    it("rejects structural configure after ready", async () => {
      const nexus = createNexus();
      await nexus.ready();

      const token = new Token<object>("configure:late-service");
      const cases = [
        { services: [{ token, implementation: {} }] },
        { endpoint: { meta: { context: "late" } } },
        { endpoint: { implementation: {} } },
        { endpoint: { connectTo: [{ descriptor: { context: "peer" } }] } },
        { implementation: {} },
        { policy: {} },
        { matchers: { any: () => true } },
        { descriptors: { peer: { context: "peer" } } },
      ];

      for (const config of cases) {
        const result = nexus.safeConfigure(config as any);
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect((result.error as any).code).toBe("E_NEXUS_ALREADY_READY");
        }
      }
    });

    it("does not schedule bootstrap when provide is called alone", () => {
      const nexus = new Nexus();
      const token = new Token<object>("provide:no-schedule");

      const result = nexus.safeProvide(token, {});

      expect(result.isOk()).toBe(true);
      expect((nexus as any).initializationPromise).toBeNull();
      expect((nexus as any).lifecycleState).toBe("draft");
    });

    it("captures synchronous provide before and after configure in the bootstrap snapshot", async () => {
      const before = new Nexus();
      const beforeService = { ping: () => "before" };
      const beforeToken = new Token<typeof beforeService>(
        "provide:before-configure",
      );
      before.provide(beforeToken, beforeService).configure({
        endpoint: { meta: { context: "test" }, implementation: {} },
      });

      const after = new Nexus();
      const afterService = { ping: () => "after" };
      const afterToken = new Token<typeof afterService>(
        "provide:after-configure",
      );
      after
        .configure({
          endpoint: { meta: { context: "test" }, implementation: {} },
        })
        .provide(afterToken, afterService);

      await before.ready();
      await after.ready();

      expect(
        (before as any).engine.resourceManager.getExposedService(
          beforeToken.id,
        ),
      ).toBe(beforeService);
      expect(
        (after as any).engine.resourceManager.getExposedService(afterToken.id),
      ).toBe(afterService);
    });

    it("rejects provide and configure while bootstrapping", async () => {
      let releaseListen: () => void = () => {};
      const listenStarted = vi.fn();
      const nexus = new Nexus();
      nexus.configure({
        endpoint: {
          meta: { context: "test" },
          implementation: {
            listen: () =>
              new Promise<void>((resolve) => {
                listenStarted();
                releaseListen = resolve;
              }),
          },
        },
      });

      const readyPromise = nexus.safeReady();
      await vi.waitFor(() => expect(listenStarted).toHaveBeenCalled());
      await waitForLifecycleState(nexus, "bootstrapping");

      const provideResult = nexus.safeProvide(
        new Token<object>("provide:locked"),
        {},
      );
      const configureResult = nexus.safeConfigure({
        descriptors: { late: {} },
      });

      expect(provideResult.isErr()).toBe(true);
      expect(configureResult.isErr()).toBe(true);
      if (provideResult.isErr()) {
        expect((provideResult.error as any).code).toBe(
          "E_NEXUS_BOOTSTRAPPING_LOCKED",
        );
      }
      if (configureResult.isErr()) {
        expect((configureResult.error as any).code).toBe(
          "E_NEXUS_BOOTSTRAPPING_LOCKED",
        );
      }

      releaseListen();
      expect((await readyPromise).isOk()).toBe(true);
    });

    it("returns aggregate errors and preserves live batch atomicity", async () => {
      const nexus = createNexus();
      await nexus.ready();
      const existing = { ping: () => "existing" };
      const added = { ping: () => "added" };
      const token = new Token<typeof existing>("provide:live-duplicate");
      const addedToken = new Token<typeof added>("provide:live-added");

      expect(nexus.safeProvide(token, existing).isOk()).toBe(true);
      const result = nexus.safeProvide([
        {
          token: new Token<typeof existing>("provide:live-duplicate"),
          implementation: {},
        },
        { token: addedToken, implementation: added },
        { token: {} as any, implementation: null as any },
      ]);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect((result.error as any).code).toBe("E_PROVIDER_BATCH_INVALID");
        expect((result.error as any).context.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "E_PROVIDER_DUPLICATE_TOKEN" }),
            expect.objectContaining({ code: "E_USAGE_INVALID" }),
          ]),
        );
      }
      const resourceManager = (nexus as any).engine.resourceManager;
      expect(resourceManager.getExposedService(token.id)).toBe(existing);
      expect(resourceManager.getExposedService(addedToken.id)).toBeUndefined();
    });

    it("accepts function implementations", async () => {
      const nexus = new Nexus();
      const implementation = () => "pong";
      const token = new Token<typeof implementation>("provide:function");

      nexus.provide(token, implementation).configure({
        endpoint: { meta: { context: "test" }, implementation: {} },
      });
      await nexus.ready();

      expect(
        (nexus as any).engine.resourceManager.getExposedService(token.id),
      ).toBe(implementation);
    });

    it("returns an error for invalid provider input instead of throwing", () => {
      const nexus = new Nexus();

      expect(() => nexus.safeProvide(null as any)).not.toThrow();
      expect(() => nexus.safeProvide(123 as any)).not.toThrow();

      const nullResult = nexus.safeProvide(null as any);
      const primitiveResult = nexus.safeProvide(123 as any);

      expect(nullResult.isErr()).toBe(true);
      expect(primitiveResult.isErr()).toBe(true);
      if (nullResult.isErr() && primitiveResult.isErr()) {
        expect((nullResult.error as any).code).toBe("E_PROVIDER_BATCH_INVALID");
        expect((primitiveResult.error as any).code).toBe(
          "E_PROVIDER_BATCH_INVALID",
        );
      }
    });
  });

  describe("bootstrap snapshot validation", () => {
    it("does not let late mutable config changes pollute the snapshot", async () => {
      let releaseListen: () => void = () => {};
      const listenStarted = vi.fn();
      const nexus = new Nexus();
      const token = new Token<object>("snapshot:late-service");
      nexus.configure({
        endpoint: {
          meta: { context: "test" },
          implementation: {
            listen: () =>
              new Promise<void>((resolve) => {
                listenStarted();
                releaseListen = resolve;
              }),
          },
        },
      });

      const readyPromise = nexus.ready();
      await vi.waitFor(() => expect(listenStarted).toHaveBeenCalled());
      (nexus as any).config.services = [{ token, implementation: {} }];

      releaseListen();
      await readyPromise;

      expect(
        (nexus as any).engine.resourceManager.getExposedService(token.id),
      ).toBeUndefined();
    });

    it("does not let nested config object mutations pollute the snapshot", async () => {
      let releaseConnect: () => void = () => {};
      const implementation = {
        connect: vi.fn(
          () =>
            new Promise<any>((resolve) => {
              releaseConnect = () => resolve([{}, { from: "peer" }]);
            }),
        ),
        listen: vi.fn(),
      };
      const meta = { context: "test", version: "before" };
      const connectToTarget = { descriptor: { context: "peer" } };
      const service = { ping: () => "pong" };
      const token = new Token<typeof service>("snapshot:nested-service");
      const registration = { token, implementation: service };
      const nexus = new Nexus<any, any>();

      nexus.configure({
        endpoint: {
          meta,
          implementation,
          connectTo: [connectToTarget],
        },
        services: [registration],
      });

      const readyPromise = nexus.ready();
      await vi.waitFor(() => expect(implementation.connect).toHaveBeenCalled());
      meta.version = "after";
      connectToTarget.descriptor.context = "mutated";
      registration.implementation = { ping: () => "mutated" };
      releaseConnect();
      await readyPromise;

      expect((nexus as any).connectionManager.localUserMetadata.version).toBe(
        "before",
      );
      expect(implementation.connect).toHaveBeenCalledWith(
        expect.objectContaining({ context: "peer" }),
      );
      expect(
        (nexus as any).engine.resourceManager.getExposedService(token.id),
      ).toBe(service);
    });

    it("keeps instance-bound decorator registrations when initialization fails", async () => {
      const isolated = new Nexus();
      const token = new Token<object>("registered-service");
      isolated.Expose(token)(class RegisteredService {}, {
        kind: "class",
      } as ClassDecoratorContext);

      const result = await isolated.safeReady();
      expect(result.isErr()).toBe(true);
      expect(
        (isolated as any).decoratorRegistry.snapshot().services.has(token),
      ).toBe(true);
    });

    it("rejects duplicate token ids after decorator services are merged", async () => {
      const token = new Token<object>("decorator:duplicate");

      const nexus = new Nexus();
      nexus.Expose(new Token<object>("decorator:duplicate"))(
        class DecoratedService {},
        { kind: "class" } as ClassDecoratorContext,
      );
      nexus.configure({
        endpoint: { meta: { context: "test" }, implementation: {} },
        services: [{ token, implementation: {} }],
      });

      const result = await nexus.safeReady();

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect((result.error as any).code).toBe("E_PROVIDER_BATCH_INVALID");
        expect((result.error as any).context.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "E_PROVIDER_DUPLICATE_TOKEN" }),
          ]),
        );
      }
    });

    it("rejects duplicate service token ids in configure services", async () => {
      const nexus = new Nexus();
      const tokenA = new Token<object>("snapshot:duplicate");
      const tokenB = new Token<object>("snapshot:duplicate");
      nexus.configure({
        endpoint: { meta: { context: "test" }, implementation: {} },
        services: [
          { token: tokenA, implementation: { first: true } },
          { token: tokenB, implementation: { second: true } },
        ],
      });

      const result = await nexus.safeReady();

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect((result.error as any).code).toBe("E_PROVIDER_BATCH_INVALID");
        expect((result.error as any).context.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "E_PROVIDER_DUPLICATE_TOKEN" }),
          ]),
        );
      }
    });

    it("rejects endpoint implementation source conflicts", async () => {
      const nexus = new Nexus();
      nexus.configure({
        endpoint: { meta: { context: "test" }, implementation: {} },
        implementation: {},
      });

      const result = await nexus.safeReady();

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect((result.error as any).code).toBe("E_CONFIGURATION_INVALID");
        expect(result.error.message).toContain("endpoint implementation");
      }
    });

    it("does not retry demand operations after bootstrap failure", async () => {
      const nexus = new Nexus();
      const listen = vi.fn(() => {
        throw new Error("listen failed");
      });
      nexus.configure({
        endpoint: {
          meta: { context: "test" },
          implementation: { listen },
        },
      });

      const firstReady = nexus.safeReady();
      const secondReady = nexus.safeReady();
      const [first, second] = await Promise.all([firstReady, secondReady]);
      const terminalPromise = (nexus as any).initializationPromise;
      const createResult = await nexus.safeCreate(
        new Token<object>("failed:create"),
        {
          target: { descriptor: { context: "peer" } },
        },
      );
      const updateResult = await nexus.safeUpdateIdentity({ context: "retry" });

      expect(first.isErr()).toBe(true);
      expect(second.isErr()).toBe(true);
      expect(createResult.isErr()).toBe(true);
      expect(updateResult.isErr()).toBe(true);
      expect(terminalPromise).not.toBeNull();
      expect((nexus as any).initializationPromise).toBe(terminalPromise);
      expect(listen).toHaveBeenCalledTimes(1);
      if (
        first.isErr() &&
        second.isErr() &&
        createResult.isErr() &&
        updateResult.isErr()
      ) {
        expect(first.error).toBe(second.error);
        expect((createResult.error as any).code).toBe(
          "E_NEXUS_BOOTSTRAP_FAILED",
        );
        expect((updateResult.error as any).code).toBe(
          "E_NEXUS_BOOTSTRAP_FAILED",
        );
      }
    });
  });

  describe("safeCreate", () => {
    it("should return error when named descriptor is missing", async () => {
      const nexus = createNexus();
      const token = new Token<object>("test");
      const result = await nexus.safeCreate(token, {
        target: { descriptor: "missing" } as any,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain(
          'Descriptor with name "missing"',
        );
      }
    });

    it("should return error when named matcher is missing", async () => {
      const nexus = createNexus();
      const token = new Token<object>("test");
      const result = await nexus.safeCreate(token, {
        target: { matcher: "missing" } as any,
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain('Matcher with name "missing"');
      }
    });

    it("uses token default target when create options are omitted", async () => {
      const nexus = createNexus();
      await nexus.safeUpdateIdentity({ context: "ready" });
      const resolveSpy = vi
        .spyOn((nexus as any).connectionManager, "safeResolveConnections")
        .mockReturnValue(okAsync([{ connectionId: "conn-default" }] as any));
      const token = new Token<object>("test", {
        defaultCreate: { target: { descriptor: { context: "ready" } } },
      });

      const result = await nexus.safeCreate(token, { expects: "first" });

      expect(result.isOk()).toBe(true);
      expect(resolveSpy).toHaveBeenCalledWith({
        descriptor: { context: "ready" },
        matcher: undefined,
      });
    });

    it("uses explicit target instead of token default target", async () => {
      const nexus = createNexus();
      await nexus.safeUpdateIdentity({ context: "ready" });
      const resolveSpy = vi
        .spyOn((nexus as any).connectionManager, "safeResolveConnections")
        .mockReturnValue(okAsync([{ connectionId: "conn-explicit" }] as any));
      const token = new Token<object>("test", {
        defaultCreate: { target: { descriptor: { context: "missing" } } },
      });

      const result = await nexus.safeCreate(token, {
        target: { descriptor: { context: "ready" } },
      });

      expect(result.isOk()).toBe(true);
      expect(resolveSpy).toHaveBeenCalledWith({
        descriptor: { context: "ready" },
        matcher: undefined,
      });
    });

    it("returns unexpected count when expects one matches multiple candidates", async () => {
      const nexus = createNexus();
      await nexus.safeUpdateIdentity({ context: "ready" });
      vi.spyOn(
        (nexus as any).connectionManager,
        "safeResolveConnections",
      ).mockReturnValue(
        okAsync([
          { connectionId: "conn-1" },
          { connectionId: "conn-2" },
        ] as any),
      );
      const token = new Token<object>("test", {
        defaultCreate: { target: { descriptor: { context: "ready" } } },
      });

      const result = await nexus.safeCreate(token, { expects: "one" });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toMatchObject({
          code: "E_TARGET_UNEXPECTED_COUNT",
        });
      }
    });

    it("uses first candidate for expects first", async () => {
      const nexus = createNexus();
      await nexus.safeUpdateIdentity({ context: "ready" });
      vi.spyOn(
        (nexus as any).connectionManager,
        "safeResolveConnections",
      ).mockReturnValue(
        okAsync([
          { connectionId: "conn-first" },
          { connectionId: "conn-second" },
        ] as any),
      );
      const token = new Token<object>("test", {
        defaultCreate: { target: { descriptor: { context: "ready" } } },
      });
      const createSpy = vi.spyOn((nexus as any).engine, "createServiceProxy");

      const result = await nexus.safeCreate(token, { expects: "first" });

      expect(result.isOk()).toBe(true);
      expect(createSpy).toHaveBeenCalledWith(
        "test",
        expect.objectContaining({
          target: { connectionId: "conn-first" },
          strategy: "first",
        }),
      );
    });

    it("normalizes empty create targets at the API layer", async () => {
      const nexus = createNexus();
      await nexus.safeUpdateIdentity({ context: "ready" });
      const resolveSpy = vi
        .spyOn((nexus as any).connectionManager, "safeResolveConnections")
        .mockReturnValue(okAsync([{ connectionId: "conn-default" }] as any));
      const token = new Token<object>("test", {
        defaultCreate: { target: { descriptor: { context: "ready" } } },
      });

      await nexus.safeCreate(token);
      await nexus.safeCreate(token, {});
      await nexus.safeCreate(token, { target: null });
      await nexus.safeCreate(token, {
        target: { descriptor: undefined, matcher: undefined },
      });

      expect(resolveSpy).toHaveBeenCalledTimes(4);
      for (const call of resolveSpy.mock.calls) {
        expect(call[0]).toEqual({
          descriptor: { context: "ready" },
          matcher: undefined,
        });
      }
    });

    it("uses instance-bound endpoint connectTo as unique fallback target", async () => {
      const nexus = new Nexus<any, any>();
      const token = new Token<object>("decorator:connect-to-fallback");
      const safeResolveConnections = vi
        .fn()
        .mockReturnValue(okAsync([{ connectionId: "conn-fallback" }] as any));

      nexus.Endpoint({
        meta: { context: "self" },
        connectTo: [{ descriptor: { context: "peer" } }],
      })(
        class DecoratedEndpoint {
          public readonly listen = vi.fn();
          public readonly connect = vi.fn(async () => {
            throw new Error("connect should be mocked via connection manager");
          });
        },
        {
          kind: "class",
        } as ClassDecoratorContext,
      );

      await nexus.ready();
      vi.spyOn(
        (nexus as any).connectionManager,
        "safeResolveConnections",
      ).mockReturnValue(safeResolveConnections());

      const result = await nexus.safeCreate(token);

      expect(result.isOk()).toBe(true);
      expect(
        (nexus as any).connectionManager.safeResolveConnections,
      ).toHaveBeenCalledWith({
        descriptor: { context: "peer" },
        matcher: undefined,
      });
    });

    it("freezes decorator connectTo fallback at bootstrap so late registry changes do not affect create", async () => {
      const nexus = new Nexus<any, any>();
      const token = new Token<object>("decorator:connect-to-frozen");

      nexus.Endpoint({
        meta: { context: "self" },
        connectTo: [{ descriptor: { context: "peer" } }],
      })(
        class DecoratedEndpoint {
          public readonly listen = vi.fn();
          public readonly connect = vi.fn(async () => {
            throw new Error("connect should be mocked via connection manager");
          });
        },
        {
          kind: "class",
        } as ClassDecoratorContext,
      );

      await nexus.ready();
      const resolveSpy = vi
        .spyOn((nexus as any).connectionManager, "safeResolveConnections")
        .mockReturnValue(okAsync([{ connectionId: "conn-frozen" }] as any));

      const liveEndpoint = (nexus as any).decoratorRegistry.snapshot().endpoint;
      expect(liveEndpoint).not.toBeNull();
      liveEndpoint.options.connectTo = [
        { descriptor: { context: "mutated-peer" } },
      ];

      const result = await nexus.safeCreate(token);

      expect(result.isOk()).toBe(true);
      expect(resolveSpy).toHaveBeenCalledWith({
        descriptor: { context: "peer" },
        matcher: undefined,
      });
      expect(resolveSpy).not.toHaveBeenCalledWith({
        descriptor: { context: "mutated-peer" },
        matcher: undefined,
      });
    });

    it("freezes configured connectTo fallback at bootstrap so late config mutations do not affect create", async () => {
      const nexus = new Nexus<any, any>();
      const token = new Token<object>("configured:connect-to-frozen");

      nexus.configure({
        endpoint: {
          meta: { context: "self" },
          implementation: {
            listen: vi.fn(),
            connect: vi.fn(async () => {
              throw new Error(
                "connect should be mocked via connection manager",
              );
            }),
          },
          connectTo: [{ descriptor: { context: "peer" } }],
        },
      });

      await nexus.ready();
      const resolveSpy = vi
        .spyOn((nexus as any).connectionManager, "safeResolveConnections")
        .mockReturnValue(okAsync([{ connectionId: "conn-configured" }] as any));

      (nexus as any).config.endpoint.connectTo[0].descriptor.context =
        "mutated-peer";

      const result = await nexus.safeCreate(token);

      expect(result.isOk()).toBe(true);
      expect(resolveSpy).toHaveBeenCalledWith({
        descriptor: { context: "peer" },
        matcher: undefined,
      });
      expect(resolveSpy).not.toHaveBeenCalledWith({
        descriptor: { context: "mutated-peer" },
        matcher: undefined,
      });
    });

    it("keeps endpoint source conflict when configured connectTo coexists with decorator endpoint", async () => {
      const nexus = new Nexus();

      nexus.Endpoint({
        meta: { context: "self" },
        connectTo: [{ descriptor: { context: "peer" } }],
      })(class DecoratedEndpoint {}, {
        kind: "class",
      } as ClassDecoratorContext);

      nexus.configure({
        endpoint: {
          connectTo: [{ descriptor: { context: "configured-peer" } }],
        },
      } as any);

      const result = await nexus.safeReady();

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect((result.error as any).cause?.code).toBe(
          "E_ENDPOINT_SOURCE_CONFLICT",
        );
      }
    });

    it("preserves explicit target and token default precedence over connectTo fallback", async () => {
      const nexus = new Nexus<any, any>();
      const safeResolveConnections = vi
        .fn()
        .mockReturnValue(okAsync([{ connectionId: "conn-priority" }] as any));

      nexus.Endpoint({
        meta: { context: "self" },
        connectTo: [{ descriptor: { context: "fallback-peer" } }],
      })(class DecoratedEndpoint {}, {
        kind: "class",
      } as ClassDecoratorContext);

      vi.spyOn(nexus as any, "safeEnsureKernelReady").mockReturnValue(
        okAsync({
          engine: {
            createServiceProxy: vi.fn(() => ({})),
          },
          connectionManager: {
            safeResolveConnections,
          },
        } as any),
      );

      const explicitToken = new Token<object>("decorator:explicit-target", {
        defaultCreate: { target: { descriptor: { context: "token-default" } } },
      });
      const explicitResult = await nexus.safeCreate(explicitToken, {
        target: { descriptor: { context: "explicit-peer" } },
      });

      expect(explicitResult.isOk()).toBe(true);
      expect(safeResolveConnections).toHaveBeenNthCalledWith(1, {
        descriptor: { context: "explicit-peer" },
        matcher: undefined,
      });

      const tokenDefaultOnly = new Token<object>("decorator:token-default", {
        defaultCreate: { target: { descriptor: { context: "token-default" } } },
      });
      const tokenDefaultResult = await nexus.safeCreate(tokenDefaultOnly);

      expect(tokenDefaultResult.isOk()).toBe(true);
      expect(safeResolveConnections).toHaveBeenNthCalledWith(2, {
        descriptor: { context: "token-default" },
        matcher: undefined,
      });
    });
  });

  describe("safeRef/safeRelease", () => {
    it("safeRef should return error for null input", () => {
      const nexus = createNexus();
      const result = nexus.safeRef(null as any);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(NexusUsageError);
      }
    });

    it("safeRef should return error for non-object input", () => {
      const nexus = createNexus();
      const result = nexus.safeRef(123 as any);
      expect(result.isErr()).toBe(true);
    });

    it("safeRelease should gracefully handle non-proxy objects", () => {
      const nexus = createNexus();
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = nexus.safeRelease({});
      expect(result.isOk()).toBe(true);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("not a valid Nexus proxy"),
      );
      consoleSpy.mockRestore();
    });

    it("safeRelease should gracefully handle null/primitive input", () => {
      const nexus = createNexus();
      const resultNull = nexus.safeRelease(null as any);
      expect(resultNull.isOk()).toBe(true);

      const resultPrim = nexus.safeRelease(123 as any);
      expect(resultPrim.isOk()).toBe(true);
    });
  });

  describe("Multicast Target Building", () => {
    it("should handle multicast target branches correctly", async () => {
      const nexus = createNexus();
      // We indirectly test buildMulticastProxyTarget through safeCreateMulticast
      const token = new Token<object>("multi");

      await nexus.safeCreateMulticast(token, {
        target: { groupName: "warmup" },
      });

      // Branch 1: Group Name
      // We spy on the engine to verify the correct target structure is passed
      const createSpy = vi.spyOn((nexus as any).engine, "createServiceProxy");

      await nexus.safeCreateMulticast(token, {
        target: { groupName: "g1" },
      });
      expect(createSpy).toHaveBeenLastCalledWith(
        "multi",
        expect.objectContaining({
          target: { groupName: "g1" },
        }),
      );

      // Branch 2: Descriptor
      await nexus.safeCreateMulticast(token, {
        target: { descriptor: { active: true } },
      });
      expect(createSpy).toHaveBeenLastCalledWith(
        "multi",
        expect.objectContaining({
          target: { descriptor: { active: true } },
        }),
      );

      // Branch 3: Matcher only
      const matcher = () => true;
      await nexus.safeCreateMulticast(token, {
        target: { matcher },
      });
      expect(createSpy).toHaveBeenLastCalledWith(
        "multi",
        expect.objectContaining({
          target: { matcher },
        }),
      );

      createSpy.mockRestore();
    });
  });

  it("keeps instance-bound decorator registrations when initialization fails", async () => {
    const isolated = new Nexus();
    const token = new Token<object>("registered-service");
    isolated.Expose(token)(class RegisteredService {}, {
      kind: "class",
    } as ClassDecoratorContext);

    await expect((isolated as any)._initialize()).rejects.toThrow();
    expect(
      (isolated as any).decoratorRegistry.snapshot().services.has(token),
    ).toBe(true);
  });

  it("does not allow in-place repair after listener failure", async () => {
    const isolated = new Nexus();
    isolated.configure({
      endpoint: {
        meta: { context: "test" },
        implementation: {
          listen: () => {
            throw new Error("listen failed");
          },
        },
      },
    });

    const firstAttempt = await isolated.safeUpdateIdentity({
      context: "retry",
    });
    expect(firstAttempt.isErr()).toBe(true);

    const repair = isolated.safeConfigure({
      endpoint: {
        meta: { context: "test" },
        implementation: {
          listen: () => {
            return;
          },
        },
      },
    });

    expect(repair.isErr()).toBe(true);
    if (repair.isErr()) {
      expect((repair.error as any).code).toBe("E_NEXUS_BOOTSTRAP_FAILED");
    }
  });
});
