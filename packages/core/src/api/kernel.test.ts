import { describe, expect, it, vi } from "vitest";
import type { ServiceProvider } from "./types/config";
import { NexusKernelBuilder } from "./kernel";
import { Nexus } from "./nexus";
import { Token } from "./token";
import { NexusConfigurationError } from "../errors/usage-errors";

describe("NexusKernelBuilder", () => {
  it("should type service policy with config metadata generics", () => {
    type UserMeta = { role: "admin" | "guest" };
    type ConnectionMeta = { processId: number };

    const registration = {
      token: { id: "typed-service" },
      service: {},
      policy: {
        canCall: ({ localIdentity, platform }) =>
          localIdentity.role === "admin" && platform.processId > 0,
      },
    } satisfies ServiceProvider<object, UserMeta, ConnectionMeta>;

    expect(registration.policy.canCall).toBeTypeOf("function");
  });

  it("should fail when endpoint implementation or meta is missing", async () => {
    const nexus = new Nexus();
    const config = {
      // Empty config
    };

    const builder = NexusKernelBuilder.create(
      config as any,
      new Map(),
      null,
      nexus,
      new Map(),
      new Map(),
    );

    const result = await builder.build();
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusConfigurationError);
      expect(result.error.message).toContain(
        "endpoint implementation and meta",
      );
    }
  });

  it("should merge endpoint registration from decorator", async () => {
    const nexus = new Nexus();
    const builder = NexusKernelBuilder.create(
      {} as any,
      new Map(),
      {
        targetClass: class Endpoint {},
        options: { meta: { context: "bg" } },
      } as any,
      nexus,
      new Map(),
      new Map(),
    );

    // It should succeed because we provided both implementation (via targetClass)
    // and meta (via options), satisfying the validation.
    const result = await builder.build();
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }

    expect(result.value.connectionManager).toBeDefined();
    // Verify the merged metadata is present
    // The connection manager's localEndpointMeta should match what we passed in the decorator
    expect((result.value.connectionManager as any).localEndpointMeta).toEqual({
      context: "bg",
    });
  });

  it("should instantiate providers with factory injection", async () => {
    const nexus = new Nexus();
    const token = new Token<object>("test");
    const serviceMap = new Map();
    const factorySpy = vi.fn().mockReturnValue({});

    serviceMap.set(token, {
      targetClass: class Service {},
      options: { factory: factorySpy },
    });

    const config = {
      endpoint: {
        meta: { context: "bg" },
        implementation: { listen: () => {} },
      },
    };

    const builder = NexusKernelBuilder.create(
      config as any,
      serviceMap,
      null,
      nexus,
      new Map(),
      new Map(),
    );

    const result = await builder.build();
    expect(result.isOk()).toBe(true);
    expect(factorySpy).toHaveBeenCalledWith({
      targetClass: expect.any(Function),
      token,
      localMeta: { context: "bg" },
    });
    expect(factorySpy.mock.calls[0]?.[0]).not.toEqual(
      expect.objectContaining({
        ready: expect.any(Function),
        create: expect.any(Function),
        provide: expect.any(Function),
        configure: expect.any(Function),
        updateIdentity: expect.any(Function),
      }),
    );
  });

  it("should pass NexusConfig.policy into ConnectionManager and Engine", async () => {
    const nexus = new Nexus();
    const policy = {
      canConnect: vi.fn(() => true),
      canCall: vi.fn(() => true),
    };
    const config = {
      endpoint: {
        meta: { context: "bg" },
        implementation: { listen: () => {} },
      },
      policy,
    };

    const builder = NexusKernelBuilder.create(
      config as any,
      new Map(),
      null,
      nexus,
      new Map(),
      new Map(),
    );

    const result = await builder.build();
    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }

    expect((result.value.connectionManager as any).config.policy).toBe(policy);
    expect((result.value.engine as any).policy).toBe(policy);
  });

  it("should fail endpoint source conflicts before endpoint instantiation", async () => {
    const nexus = new Nexus();
    const endpointConstructor = vi.fn();

    const builder = NexusKernelBuilder.create(
      {
        endpoint: {
          meta: { context: "configured" },
          implementation: { listen: () => {} },
        },
      } as any,
      new Map(),
      {
        targetClass: class DecoratedEndpoint {
          constructor() {
            endpointConstructor();
          }
        },
        options: { meta: { context: "decorated" } },
      } as any,
      nexus,
      new Map(),
      new Map(),
    );

    const result = await builder.build();

    expect(result.isErr()).toBe(true);
    expect(endpointConstructor).not.toHaveBeenCalled();
    if (result.isErr()) {
      expect(result.error).toEqual(
        expect.objectContaining({ code: "E_ENDPOINT_SOURCE_CONFLICT" }),
      );
    }
  });

  it("should fail endpoint source conflicts when configured endpoint has a defaultTarget", async () => {
    const nexus = new Nexus();

    const builder = NexusKernelBuilder.create(
      {
        endpoint: {
          defaultTarget: { context: "peer" },
        },
      } as any,
      new Map(),
      {
        targetClass: class DecoratedEndpoint {},
        options: { meta: { context: "decorated" } },
      } as any,
      nexus,
      new Map(),
      new Map(),
    );

    const result = await builder.build();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual(
        expect.objectContaining({ code: "E_ENDPOINT_SOURCE_CONFLICT" }),
      );
    }
  });

  it("should allow decorated providers to replace configured providers by id", async () => {
    const nexus = new Nexus();
    const tokenA = new Token<object>("duplicate-before-instance");
    const tokenB = new Token<object>("duplicate-before-instance");
    const serviceConstructor = vi.fn();
    const factory = vi.fn(() => ({}));

    const builder = NexusKernelBuilder.create(
      {
        endpoint: {
          meta: { context: "bg" },
          implementation: { listen: () => {} },
        },
        providers: [{ token: tokenA, service: {} }],
      } as any,
      new Map([
        [
          tokenB,
          {
            targetClass: class DecoratedService {
              constructor() {
                serviceConstructor();
              }
            },
            options: { factory },
          },
        ],
      ]),
      null,
      nexus,
      new Map(),
      new Map(),
    );

    const result = await builder.build();

    expect(result.isOk()).toBe(true);
    expect(serviceConstructor).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
    if (result.isErr()) {
      throw result.error;
    }
    expect(
      (result.value.engine as any).resourceManager.getExposedService(tokenA.id),
    ).toEqual({});
  });
});
