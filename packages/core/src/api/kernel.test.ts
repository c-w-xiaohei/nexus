import { describe, expect, it, vi } from "vitest";
import type { ServiceProvider } from "./types/config";
import { buildKernel } from "./kernel";
import type { Connection } from "./connection";
import type { AdapterModel } from "@/types/adapter-model";
import { Token } from "./token";
import { NexusConfigurationError } from "../errors/usage-errors";

describe("buildKernel", () => {
  it("should type service policy with config metadata generics", () => {
    interface Model extends AdapterModel {
      contextMeta: { role: "admin" | "guest" };
      connectionMeta: { processId: number };
    }

    const registration = {
      token: new Token<object, Model>("typed-service"),
      service: {},
      policy: {
        canCall: ({ localIdentity, platform }) =>
          localIdentity.role === "admin" && platform.processId > 0,
      },
    } satisfies ServiceProvider<object, Model>;

    expect(registration.policy.canCall).toBeTypeOf("function");
  });

  it("should fail when endpoint implementation or meta is missing", async () => {
    const getConnection = vi.fn<() => Connection>();
    const config = {
      // Empty config
    };

    const result = await buildKernel(
      config as any,
      [],
      null,
      undefined,
      getConnection,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusConfigurationError);
      expect(result.error.message).toContain(
        "endpoint implementation and meta",
      );
    }
  });

  it("should merge endpoint registration from decorator", async () => {
    const getConnection = vi.fn<() => Connection>();
    const result = await buildKernel(
      {} as any,
      [],
      {
        targetClass: class Endpoint {},
        options: { meta: { context: "bg" } },
      } as any,
      undefined,
      getConnection,
    );

    // It should succeed because we provided both implementation (via targetClass)
    // and meta (via options), satisfying the validation.
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
    const getConnection = vi.fn<() => Connection>();
    const token = new Token<object>("test");
    const factorySpy = vi.fn().mockReturnValue({});
    const serviceDeclarations = [
      {
        token,
        targetClass: class Service {},
        options: { factory: factorySpy },
      },
    ];

    const config = {
      endpoint: {
        meta: { context: "bg" },
        implementation: { listen: () => {} },
      },
    };

    const result = await buildKernel(
      config as any,
      serviceDeclarations,
      null,
      undefined,
      getConnection,
    );

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
    const getConnection = vi.fn<() => Connection>();
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

    const result = await buildKernel(
      config as any,
      [],
      null,
      undefined,
      getConnection,
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      throw result.error;
    }

    expect((result.value.connectionManager as any).config.policy).toBe(policy);
    expect((result.value.engine as any).messageHandler.context.policy).toBe(
      policy,
    );
  });

  it("should fail endpoint source conflicts before endpoint instantiation", async () => {
    const getConnection = vi.fn<() => Connection>();
    const endpointConstructor = vi.fn();

    const result = await buildKernel(
      {
        endpoint: {
          meta: { context: "configured" },
          implementation: { listen: () => {} },
        },
      } as any,
      [],
      {
        targetClass: class DecoratedEndpoint {
          constructor() {
            endpointConstructor();
          }
        },
        options: { meta: { context: "decorated" } },
      } as any,
      undefined,
      getConnection,
    );

    expect(result.isErr()).toBe(true);
    expect(endpointConstructor).not.toHaveBeenCalled();
    if (result.isErr()) {
      expect(result.error).toEqual(
        expect.objectContaining({ code: "E_ENDPOINT_SOURCE_CONFLICT" }),
      );
    }
  });

  it("rejects configured and decorated providers with the same token in one bootstrap batch", async () => {
    const getConnection = vi.fn<() => Connection>();
    const tokenA = new Token<object>("duplicate-before-instance");
    const tokenB = new Token<object>("duplicate-before-instance");
    const serviceConstructor = vi.fn();
    const factory = vi.fn(() => ({}));

    const result = await buildKernel(
      {
        endpoint: {
          meta: { context: "bg" },
          implementation: { listen: () => {} },
        },
        providers: [{ token: tokenA, service: {} }],
      } as any,
      [
        {
          token: tokenB,
          targetClass: class DecoratedService {
            constructor() {
              serviceConstructor();
            }
          },
          options: { factory },
        },
      ],
      null,
      undefined,
      getConnection,
    );

    expect(result).toMatchObject({
      error: { code: "E_PROVIDER_DUPLICATE_TOKEN" },
    });
    expect(serviceConstructor).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
});
