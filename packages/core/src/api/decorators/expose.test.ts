import { describe, expect, it } from "vitest";
import { Expose } from "./expose";
import { Nexus, nexus } from "../nexus";
import { Token } from "../token";

const decoratorSnapshotOf = (instance: Nexus) =>
  (instance as any).decoratorRegistry.snapshot();

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
    const decorator = Expose(token);
    const context = { kind: "class" } as ClassDecoratorContext;

    class TestService {}
    decorator(TestService, context);

    expect(decoratorSnapshotOf(nexus).providers.has(token)).toBe(true);
    expect(decoratorSnapshotOf(nexus).providers.get(token)?.targetClass).toBe(
      TestService,
    );
  });

  it("should accept policy in options", () => {
    const token = new Token<object>("policy-service");
    const policy = {
      canConnect: () => true,
      canCall: () => true,
    };

    const decorator = Expose(token, { policy });
    decorator(class PolicyService {}, {
      kind: "class",
    } as ClassDecoratorContext);

    expect(
      decoratorSnapshotOf(nexus).providers.get(token)?.options?.policy,
    ).toBe(policy);
  });

  it("should accept policy with only canCall in options", () => {
    const token = new Token<object>("call-policy-service");
    const policy = {
      canCall: () => true,
    };

    const decorator = Expose(token, { policy });
    decorator(class PolicyService {}, {
      kind: "class",
    } as ClassDecoratorContext);

    expect(
      decoratorSnapshotOf(nexus).providers.get(token)?.options?.policy,
    ).toBe(policy);
  });

  it("registers service with the decorator expression Nexus instance", () => {
    const first = new Nexus();
    const second = new Nexus();
    const token = new Token<object>("instance-bound-service");

    class FirstService {}
    first.Expose(token)(FirstService, {
      kind: "class",
    } as ClassDecoratorContext);

    expect(decoratorSnapshotOf(first).providers.get(token)?.targetClass).toBe(
      FirstService,
    );
    expect(decoratorSnapshotOf(second).providers.size).toBe(0);
  });

  it("allows different Nexus instances to register the same token id", () => {
    const first = new Nexus();
    const second = new Nexus();
    const tokenA = new Token<object>("shared-service-id");
    const tokenB = new Token<object>("shared-service-id");

    expect(() => {
      first.Expose(tokenA)(class FirstService {}, {
        kind: "class",
      } as ClassDecoratorContext);
      second.Expose(tokenB)(class SecondService {}, {
        kind: "class",
      } as ClassDecoratorContext);
    }).not.toThrow();
  });

  it("rejects duplicate token ids in the same Nexus instance", () => {
    const instance = new Nexus();
    const tokenA = new Token<object>("duplicate-service-id");
    const tokenB = new Token<object>("duplicate-service-id");

    instance.Expose(tokenA)(class FirstService {}, {
      kind: "class",
    } as ClassDecoratorContext);

    expect(() => {
      instance.Expose(tokenB)(class SecondService {}, {
        kind: "class",
      } as ClassDecoratorContext);
    }).toThrowError(expect.objectContaining({ code: "E_DUPLICATE_PROVIDER" }));
  });

  it("top-level Expose delegates to the default singleton", () => {
    const token = new Token<object>("singleton-delegated-service");

    class SingletonService {}
    Expose(token)(SingletonService, { kind: "class" } as ClassDecoratorContext);

    expect(decoratorSnapshotOf(nexus).providers.get(token)?.targetClass).toBe(
      SingletonService,
    );
  });
});
