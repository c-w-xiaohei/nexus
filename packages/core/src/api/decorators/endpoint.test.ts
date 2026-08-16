import { describe, expect, it } from "vitest";
import { Endpoint } from "./endpoint";
import { Nexus, nexus } from "../nexus";

const decoratorSnapshotOf = (instance: Nexus) =>
  (instance as any).decoratorRegistry.snapshot();

describe("@Endpoint", () => {
  it("attaches schema validation error as cause for invalid endpoint config", () => {
    expect(() => {
      Endpoint({
        meta: null as never,
      });
    }).toThrowError(
      expect.objectContaining({
        cause: expect.any(Object),
      }),
    );
  });

  it.each([null, [], new Date()])(
    "rejects non-plain defaultTarget %p before cloning",
    (defaultTarget) => {
      expect(() =>
        Endpoint({
          meta: { context: "invalid" },
          defaultTarget: defaultTarget as never,
        }),
      ).toThrow(expect.objectContaining({ code: "E_USAGE_INVALID" }));
    },
  );

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
  });
});
