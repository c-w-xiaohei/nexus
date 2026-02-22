import { describe, expect, it } from "vitest";
import { Endpoint } from "./endpoint";
import { DecoratorRegistry } from "../registry";

describe("@Endpoint", () => {
  it("accepts named descriptor in connectTo", () => {
    DecoratorRegistry.clear();

    const decorator = Endpoint({
      meta: { context: "background" },
      connectTo: [{ descriptor: "background-main" }],
    });

    class EndpointImpl {}
    decorator(
      EndpointImpl as never,
      { kind: "class" } as ClassDecoratorContext,
    );

    const snapshot = DecoratorRegistry.snapshot();
    expect(snapshot.endpoint).not.toBeNull();
    expect(snapshot.endpoint?.options.connectTo?.[0]?.descriptor).toBe(
      "background-main",
    );
  });

  it("attaches validation error as cause", () => {
    expect(() => {
      Endpoint({
        meta: { context: "background" },
        connectTo: [{} as never],
      });
    }).toThrowError(
      expect.objectContaining({
        cause: expect.any(Object),
      }),
    );
  });

  it("rejects connectTo targets without descriptor", () => {
    try {
      Endpoint({
        meta: { context: "background" },
        connectTo: [{ matcher: "is-background" } as never],
      });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("Invalid options");
      expect(
        (error as Error & { cause?: { message?: string } }).cause?.message,
      ).toContain("Schema validation failed");
    }
  });
});
