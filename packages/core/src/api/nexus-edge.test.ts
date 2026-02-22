import { describe, expect, it, vi } from "vitest";
import { Nexus } from "./nexus";
import { NexusUsageError } from "../errors/usage-errors";
import { Token } from "./token";
import { DecoratorRegistry } from "./registry";

describe("Nexus Safe API Edge Cases", () => {
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

  it("keeps decorator registrations when initialization fails", async () => {
    const nexus = createNexus();
    await nexus.safeUpdateIdentity({ context: "ready" });

    DecoratorRegistry.clear();
    const token = new Token<object>("registered-service");
    DecoratorRegistry.registerService(token, {
      targetClass: class RegisteredService {},
    });

    const isolated = new Nexus();
    await expect((isolated as any)._initialize()).rejects.toThrow();
    expect(DecoratorRegistry.hasRegistrations()).toBe(true);

    DecoratorRegistry.clear();
  });

  it("retries initialization after listener failure", async () => {
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

    isolated.configure({
      endpoint: {
        meta: { context: "test" },
        implementation: {
          listen: () => {
            return;
          },
        },
      },
    });

    const secondAttempt = await isolated.safeUpdateIdentity({ context: "ok" });
    expect(secondAttempt.isOk()).toBe(true);
  });
});
