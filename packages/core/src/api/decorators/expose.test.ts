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

  it("preserves omitted and explicitly undefined optional option keys", () => {
    const token = new Token<object>("option-shape-service");
    const register = vi.fn();
    const decorator = createExposeDecorator(register);

    decorator(token, {})(class Omitted {}, {
      kind: "class",
    } as ClassDecoratorContext);
    decorator(token, { policy: undefined })(class Explicit {}, {
      kind: "class",
    } as ClassDecoratorContext);

    const omitted = register.mock.calls[0][0].options;
    const explicit = register.mock.calls[1][0].options;
    expect(omitted).toEqual({});
    expect(Object.hasOwn(omitted, "policy")).toBe(false);
    expect(Object.hasOwn(omitted, "factory")).toBe(false);
    expect(explicit).toEqual({ policy: undefined });
    expect(Object.hasOwn(explicit, "policy")).toBe(true);
    expect(Object.hasOwn(explicit, "factory")).toBe(false);
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
