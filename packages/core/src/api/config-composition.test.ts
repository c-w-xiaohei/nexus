import { describe, expect, it, vi } from "vitest";
import { Nexus } from "./nexus";
import { Token } from "./token";
import { composeNexusConfig, serviceProvider } from "./types/config";

describe("composeNexusConfig", () => {
  it("uses domain-aware last-wins semantics across config layers", () => {
    const firstToken = new Token<object>("config:first");
    const secondToken = new Token<object>("config:second");
    const firstService = { value: "first" };
    const replacementService = { value: "replacement" };
    const secondService = { value: "second" };
    const firstCanCall = vi.fn(() => true);
    const replacementCanCall = vi.fn(() => false);
    const composed = composeNexusConfig([
      {
        endpoint: {
          meta: { role: "first", stale: true },
          implementation: { first: true },
          defaultTarget: { context: "peer" },
        },
        policy: { canCall: firstCanCall },
        providers: [
          serviceProvider(firstToken, firstService, {
            policy: { canCall: firstCanCall },
          }),
        ],
      },
      {
        endpoint: {
          meta: { role: "second" },
          implementation: { second: true },
          defaultTarget: { context: "replacement" },
        },
        providers: [
          serviceProvider(firstToken, replacementService, {
            policy: { canCall: replacementCanCall },
          }),
          serviceProvider(secondToken, secondService),
        ],
      },
      {
        endpoint: {},
      },
    ]);

    expect(composed.endpoint?.meta).toEqual({ role: "second" });
    expect(composed.endpoint?.implementation).toEqual({ second: true });
    expect(composed.endpoint?.defaultTarget).toEqual({
      context: "replacement",
    });
    expect(composed.policy).toEqual({ canCall: firstCanCall });
    expect(composed.providers).toEqual([
      serviceProvider(firstToken, replacementService, {
        policy: { canCall: replacementCanCall },
      }),
      serviceProvider(secondToken, secondService),
    ]);
  });
});

describe("Nexus.configure config layering", () => {
  it("shares composeNexusConfig last-wins semantics before bootstrap", async () => {
    const nexus = new Nexus();
    const token = new Token<object>("configure:replace-provider");
    const firstService = { value: "first" };
    const replacementService = { value: "replacement" };

    nexus.configure({
      endpoint: {
        meta: { role: "first", stale: true },
        implementation: { first: true },
        defaultTarget: { context: "peer" },
      },
      providers: [serviceProvider(token, firstService)],
    });
    nexus.configure({
      endpoint: {
        meta: { role: "second" },
        implementation: { listen: vi.fn() },
        defaultTarget: { context: "replacement" },
      },
      providers: [serviceProvider(token, replacementService)],
    });

    await nexus.ready();

    expect((nexus as any).connectionManager.localEndpointMeta).toEqual({
      role: "second",
    });
    expect((nexus as any).config.endpoint.defaultTarget).toEqual({
      context: "replacement",
    });
    expect(
      (nexus as any).engine.resourceManager.getExposedService(token.id),
    ).toBe(replacementService);
  });
});
