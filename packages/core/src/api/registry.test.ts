import { describe, expect, it, vi } from "vitest";
import { DecoratorRegistry } from "./registry";
import { Token } from "./token";
import type { EndpointRegistrationData } from "./registry";

describe("DecoratorRegistry", () => {
  it("should enforce owner claim semantics", () => {
    DecoratorRegistry.clear();

    const ownerA = Symbol("a");
    const ownerB = Symbol("b");

    expect(DecoratorRegistry.claim(ownerA)).toBe(true);
    expect(DecoratorRegistry.claim(ownerA)).toBe(true);
    expect(DecoratorRegistry.claim(ownerB)).toBe(false);
  });

  it("should warn on duplicate service and endpoint registrations", () => {
    DecoratorRegistry.clear();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const token = new Token<object>("service-a");
    const serviceData = {
      targetClass: class ServiceA {},
    };

    DecoratorRegistry.registerService(token, serviceData);
    DecoratorRegistry.registerService(token, serviceData);

    const endpointData: EndpointRegistrationData = {
      targetClass: class EndpointA {},
      options: { meta: { context: "bg" } },
    };
    DecoratorRegistry.registerEndpoint(endpointData);
    DecoratorRegistry.registerEndpoint(endpointData);

    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("snapshot() should copy services and clear() should reset all state", () => {
    DecoratorRegistry.clear();
    const owner = Symbol("owner");
    DecoratorRegistry.claim(owner);

    const token = new Token<object>("service-b");
    DecoratorRegistry.registerService(token, {
      targetClass: class ServiceB {},
    });

    const snapshot = DecoratorRegistry.snapshot();
    expect(snapshot.services.size).toBe(1);
    expect(DecoratorRegistry.hasRegistrations()).toBe(true);

    DecoratorRegistry.clear();
    const postClearSnapshot = DecoratorRegistry.snapshot();
    expect(postClearSnapshot.services.size).toBe(0);
    expect(postClearSnapshot.endpoint).toBeNull();
    expect(DecoratorRegistry.hasRegistrations()).toBe(false);

    expect(DecoratorRegistry.claim(Symbol("new-owner"))).toBe(true);
  });
});
