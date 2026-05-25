import { describe, expect, expectTypeOf, it } from "vitest";
import { Token } from "./token";
import { TokenSpace } from "./token-space";
import type { InlineTarget } from "./types/config";

type EndpointMeta = { context: "background" | "content"; active?: boolean };

describe("TokenSpace defaultTarget", () => {
  it("inherits parent defaultTarget by default and allows null to clear it", () => {
    const root = new TokenSpace<EndpointMeta, object>({
      name: "root",
      defaultTarget: { descriptor: { context: "background" } },
    });

    const inherited = root.space("inherited");
    const cleared = root.space("cleared", { defaultTarget: null });

    expect(root.token<object>("service").defaultTarget).toEqual({
      descriptor: { context: "background" },
    });
    expect(inherited.token<object>("service").defaultTarget).toEqual({
      descriptor: { context: "background" },
    });
    expect(cleared.token<object>("service").defaultTarget).toBeUndefined();
  });

  it("types default targets as non-empty inline descriptor or matcher only", () => {
    expectTypeOf<InlineTarget<EndpointMeta>>().toEqualTypeOf<
      | { descriptor: Partial<EndpointMeta>; matcher?: never }
      | { matcher: (identity: EndpointMeta) => boolean; descriptor?: never }
      | {
          descriptor: Partial<EndpointMeta>;
          matcher: (identity: EndpointMeta) => boolean;
        }
    >();

    new TokenSpace<EndpointMeta, object>({
      name: "typed-descriptor",
      defaultTarget: { descriptor: { context: "content" } },
    });
    new TokenSpace<EndpointMeta, object>({
      name: "typed-matcher",
      defaultTarget: { matcher: (meta) => meta.active === true },
    });
    new TokenSpace<EndpointMeta, object>({
      name: "typed-compound-inline-target",
      defaultTarget: {
        descriptor: { context: "content" },
        matcher: (meta) => meta.active === true,
      },
    });

    expectTypeOf(
      new TokenSpace<EndpointMeta, object>({ name: "return-type" }).token<{
        ping(): string;
      }>("service"),
    ).toEqualTypeOf<
      import("./token").Token<{ ping(): string }, EndpointMeta>
    >();

    if (false) {
      new TokenSpace<EndpointMeta, object>({
        name: "no-empty-target",
        // @ts-expect-error empty defaultTarget is not a valid InlineTarget
        defaultTarget: {},
      });
      new TokenSpace<EndpointMeta, object>({
        name: "no-named-descriptor",
        // @ts-expect-error token defaults cannot use named descriptor strings
        defaultTarget: { descriptor: "background" },
      });
      new TokenSpace<EndpointMeta, object>({
        name: "no-named-matcher",
        // @ts-expect-error token defaults cannot use named matcher strings
        defaultTarget: { matcher: "active" },
      });
    }
  });

  it("rejects direct Token defaultTarget descriptor values that are not inline objects", () => {
    expect(
      () => new Token("array-descriptor", { defaultTarget: { descriptor: [] } as any }),
    ).toThrow("Token defaultTarget only supports inline descriptor objects and matcher functions.");

    expect(
      () => new Token("null-descriptor", { defaultTarget: { descriptor: null } as any }),
    ).toThrow("Token defaultTarget only supports inline descriptor objects and matcher functions.");

    expect(
      () => new Token("number-descriptor", { defaultTarget: { descriptor: 1 } as any }),
    ).toThrow("Token defaultTarget only supports inline descriptor objects and matcher functions.");
  });

  it("rejects direct Token defaultTarget matcher values that are not functions", () => {
    expect(
      () => new Token("object-matcher", { defaultTarget: { matcher: {} } as any }),
    ).toThrow("Token defaultTarget only supports inline descriptor objects and matcher functions.");

    expect(
      () => new Token("boolean-matcher", { defaultTarget: { matcher: true } as any }),
    ).toThrow("Token defaultTarget only supports inline descriptor objects and matcher functions.");
  });
});
