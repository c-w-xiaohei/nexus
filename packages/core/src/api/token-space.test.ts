import { describe, expect, it } from "vitest";
import { Token } from "./token";
import { TokenSpace } from "./token-space";

type Model = {
  contextMeta: object;
  connectionMeta: object;
  connectionTarget: { id: string };
};

describe("TokenSpace defaultTarget", () => {
  it("inherits a plain-object defaultTarget", () => {
    const space = new TokenSpace<Model>({
      name: "app",
      defaultTarget: { id: "host" },
    });
    expect(space.space("child").defaultTarget).toEqual({ id: "host" });
  });

  it("rejects null, arrays, and non-plain targets", () => {
    expect(() => new Token("null", { defaultTarget: null as never })).toThrow(
      /plain object/,
    );
    expect(() => new Token("array", { defaultTarget: [] as never })).toThrow(
      /plain object/,
    );
    expect(
      () => new Token("date", { defaultTarget: new Date() as never }),
    ).toThrow(/plain object/);
    expect(
      () =>
        new TokenSpace<Model>({ name: "app", defaultTarget: null as never }),
    ).toThrow(/plain object/);
  });

  it("accepts exact plain target objects", () => {
    expect(
      new Token<Model>("service", { defaultTarget: { id: "host" } } as never),
    ).toBeDefined();
  });
});
