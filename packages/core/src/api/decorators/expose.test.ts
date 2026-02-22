import { describe, expect, it } from "vitest";
import { Expose } from "./expose";
import { Token } from "../token";
import { DecoratorRegistry } from "../registry";

describe("@Expose", () => {
  it("should fail when token is invalid", () => {
    expect(() => {
      // @ts-expect-error - testing invalid input
      Expose(null)({});
    }).toThrow("Invalid inputs");
  });

  it("should fail when applied to non-class context", () => {
    const decorator = Expose(new Token<object>("test-service"));
    const context = { kind: "method" } as ClassDecoratorContext;

    expect(() => {
      decorator({} as any, context);
    }).toThrow("can only be applied to classes");
  });

  it("should register service with valid inputs", () => {
    DecoratorRegistry.clear();
    const token = new Token<object>("valid-service");
    const decorator = Expose(token);
    const context = { kind: "class" } as ClassDecoratorContext;

    class TestService {}
    decorator(TestService, context);

    const snapshot = DecoratorRegistry.snapshot();
    expect(snapshot.services.has(token)).toBe(true);
    expect(snapshot.services.get(token)?.targetClass).toBe(TestService);
  });

  it("should accept policy in options", () => {
    DecoratorRegistry.clear();
    const token = new Token<object>("policy-service");
    const policy = {
      canConnect: () => true,
      canCall: () => true,
    };

    const decorator = Expose(token, { policy });
    decorator(class PolicyService {}, {
      kind: "class",
    } as ClassDecoratorContext);

    const snapshot = DecoratorRegistry.snapshot();
    expect(snapshot.services.get(token)?.options?.policy).toBe(policy);
  });
});
