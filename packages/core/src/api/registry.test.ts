import { describe, expect, it } from "vitest";
import { InstanceDecoratorRegistry } from "./registry";
import { Token } from "./token";

describe("InstanceDecoratorRegistry", () => {
  it("owns the endpoint metadata snapshot while preserving its constructor", () => {
    const registry = new InstanceDecoratorRegistry();
    class Endpoint {
      listen() {}
    }
    const options = {
      meta: { nested: { value: 1 } },
    };
    registry.registerEndpoint({ targetClass: Endpoint, options });
    const snapshot = registry.snapshot();
    options.meta.nested.value = 2;
    expect(snapshot.endpoint?.targetClass).toBe(Endpoint);
    expect(snapshot.endpoint?.options.meta).toEqual({ nested: { value: 1 } });
  });
  it("preserves instance registrations across snapshots", () => {
    const registry = new InstanceDecoratorRegistry();
    const token = new Token<object>("registered-service");

    registry.registerService(token, {
      targetClass: class RegisteredService {},
    });
    const snapshot = registry.snapshot();

    expect(snapshot.providers.has(token)).toBe(true);
    expect(registry.snapshot().providers.has(token)).toBe(true);
  });

  it("rejects a second Token with the same ID without changing the snapshot", () => {
    const registry = new InstanceDecoratorRegistry();
    const token = new Token<object>("same-service");
    const data = { targetClass: class Service {} };
    registry.registerService(token, data);
    expect(() =>
      registry.registerService(new Token("same-service"), data),
    ).toThrow(expect.objectContaining({ code: "E_DUPLICATE_PROVIDER" }));
    expect([...registry.snapshot().providers]).toEqual([[token, data]]);
    const snapshot = registry.snapshot();
    registry.registerService(new Token("later"), data);
    expect(snapshot.providers.size).toBe(1);
  });
});
