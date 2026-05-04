import { describe, expect, it } from "vitest";
import { Endpoint } from "./endpoint";
import { Nexus, nexus } from "../nexus";
import { DecoratorRegistry } from "../registry";

const decoratorSnapshotOf = (instance: Nexus) =>
  (instance as any).decoratorRegistry.snapshot();

describe("@Endpoint", () => {
  it("accepts named descriptor in connectTo", () => {
    DecoratorRegistry.clear();
    const instance = new Nexus();

    const decorator = instance.Endpoint({
      meta: { context: "background" },
      connectTo: [{ descriptor: "background-main" }],
    });

    class EndpointImpl {}
    decorator(
      EndpointImpl as never,
      { kind: "class" } as ClassDecoratorContext,
    );

    expect(decoratorSnapshotOf(instance).endpoint).not.toBeNull();
    expect(
      decoratorSnapshotOf(instance).endpoint?.options.connectTo?.[0]
        ?.descriptor,
    ).toBe("background-main");
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

  it("registers endpoint with the decorator expression Nexus instance", () => {
    const first = new Nexus();
    const second = new Nexus();

    class EndpointImpl {}
    first.Endpoint({ meta: { context: "background" } })(
      EndpointImpl as never,
      { kind: "class" } as ClassDecoratorContext,
    );

    expect(decoratorSnapshotOf(first).endpoint?.targetClass).toBe(EndpointImpl);
    expect(decoratorSnapshotOf(second).endpoint).toBeNull();
  });

  it("top-level Endpoint delegates to the default singleton", () => {
    class EndpointImpl {}
    Endpoint({ meta: { context: "singleton" } })(
      EndpointImpl as never,
      {
        kind: "class",
      } as ClassDecoratorContext,
    );

    expect(decoratorSnapshotOf(nexus).endpoint?.targetClass).toBe(EndpointImpl);
    expect(DecoratorRegistry.snapshot().endpoint).toBeNull();
  });
});
