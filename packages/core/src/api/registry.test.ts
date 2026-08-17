import { describe, expect, it } from "vitest";
import { InstanceDecoratorRegistry } from "./registry";
import { Token } from "./token";

describe("InstanceDecoratorRegistry", () => {
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
});
