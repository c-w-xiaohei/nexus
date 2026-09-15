import { describe, expect, it, vi } from "vitest";
import { createExposeDecorator, Expose } from "./expose";
import { Token } from "../token";

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
    const token = new Token<object>("valid-service");
    const register = vi.fn();
    const decorator = createExposeDecorator(register)(token);
    const context = { kind: "class" } as ClassDecoratorContext;

    class TestService {}
    decorator(TestService, context);

    expect(register).toHaveBeenCalledWith({
      token,
      targetClass: TestService,
      options: undefined,
    });
  });

  it("should accept policy in options", () => {
    const token = new Token<object>("policy-service");
    const policy = {
      canConnect: () => true,
      canCall: () => true,
    };

    const register = vi.fn();
    const decorator = createExposeDecorator(register)(token, { policy });
    decorator(class PolicyService {}, {
      kind: "class",
    } as ClassDecoratorContext);

    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ token, options: { policy } }),
    );
  });

  it("should accept policy with only canCall in options", () => {
    const token = new Token<object>("call-policy-service");
    const policy = {
      canCall: () => true,
    };

    const register = vi.fn();
    const decorator = createExposeDecorator(register)(token, { policy });
    decorator(class PolicyService {}, {
      kind: "class",
    } as ClassDecoratorContext);

    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ token, options: { policy } }),
    );
  });

  it("top-level Expose delegates to the default singleton", () => {
    const token = new Token<object>("singleton-delegated-service");

    class SingletonService {}
    expect(() =>
      Expose(token)(SingletonService, {
        kind: "class",
      } as ClassDecoratorContext),
    ).not.toThrow();
  });
});
