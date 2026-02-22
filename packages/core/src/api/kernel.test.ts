import { describe, expect, it, vi } from "vitest";
import { NexusKernelBuilder } from "./kernel";
import { Nexus } from "./nexus";
import { Token } from "./token";
import { NexusConfigurationError } from "../errors/usage-errors";

describe("NexusKernelBuilder", () => {
  it("should fail when connectTo target is missing descriptor", async () => {
    const nexus = new Nexus();
    const config = {
      endpoint: {
        meta: { context: "bg" },
        implementation: {},
        connectTo: [{ matcher: "foo" } as any], // Missing descriptor
      },
    };

    const builder = NexusKernelBuilder.create(
      config as any,
      new Map(),
      null,
      nexus,
      new Map([["foo", () => true]]),
      new Map(),
    );

    const result = await builder.build();
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(NexusConfigurationError);
      expect(result.error.message).toContain(
        "connectTo targets must include a descriptor",
      );
    }
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
        "Endpoint 'implementation' and 'meta' must be provided",
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
    // The connection manager's localUserMetadata should match what we passed in the decorator
    expect((result.value.connectionManager as any).localUserMetadata).toEqual({
      context: "bg",
    });
  });

  it("should instantiate services with factory injection", async () => {
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
    expect(factorySpy).toHaveBeenCalledWith(nexus);
  });
});
