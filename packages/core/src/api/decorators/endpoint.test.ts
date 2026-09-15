import { describe, expect, it, vi } from "vitest";
import { createEndpointDecorator, Endpoint } from "./endpoint";
import { Nexus } from "../nexus";

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

  it("passes endpoint registration to its callback", () => {
    const register = vi.fn();
    const decorator = createEndpointDecorator(register);

    class EndpointImpl {}
    decorator({ meta: { context: "background" } })(
      EndpointImpl as never,
      { kind: "class" } as ClassDecoratorContext,
    );

    expect(register).toHaveBeenCalledWith({
      targetClass: EndpointImpl,
      options: { meta: { context: "background" } },
    });
  });

  it.each([{}, [null]])(
    "rejects invalid connectTo %p before registration",
    (connectTo) => {
      expect(() =>
        new Nexus().Endpoint({
          meta: {},
          connectTo: connectTo as never,
        }),
      ).toThrow(expect.objectContaining({ code: "E_USAGE_INVALID" }));
    },
  );

  it("carries decorated startup targets through bootstrap", async () => {
    const instance = new Nexus();
    const connect = vi.fn(async () => {
      throw new Error("offline");
    });
    class EndpointImpl {
      listen() {}
      connect = connect;
    }
    instance.Endpoint({
      meta: { context: "child" },
      connectTo: [{ context: "owner" }],
    })(EndpointImpl, { kind: "class" } as ClassDecoratorContext);
    await instance.ready();
    expect(connect).toHaveBeenCalledExactlyOnceWith({ context: "owner" });
  });

  it("top-level Endpoint delegates to the default singleton", () => {
    class EndpointImpl {}
    expect(() =>
      Endpoint({ meta: { context: "singleton" } })(
        EndpointImpl as never,
        { kind: "class" } as ClassDecoratorContext,
      ),
    ).not.toThrow();
  });
});
