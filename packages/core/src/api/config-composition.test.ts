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
    const matcherA = (meta: { role?: string }) => meta.role === "first";
    const matcherReplacement = (meta: { role?: string }) =>
      meta.role === "replacement";

    const composed = composeNexusConfig([
      {
        endpoint: {
          meta: { role: "first", stale: true },
          implementation: { first: true },
          connectTo: [{ descriptor: { role: "peer" } }],
        },
        policy: { canCall: firstCanCall },
        providers: [
          serviceProvider(firstToken, firstService, {
            policy: { canCall: firstCanCall },
          }),
        ],
        descriptors: { peer: { role: "peer" }, duplicate: { role: "old" } },
        matchers: { active: matcherA },
      },
      {
        endpoint: {
          meta: { role: "second" },
          implementation: { second: true },
          connectTo: [],
        },
        providers: [
          serviceProvider(firstToken, replacementService, {
            policy: { canCall: replacementCanCall },
          }),
          serviceProvider(secondToken, secondService),
        ],
        descriptors: { duplicate: { role: "new" } },
        matchers: { active: matcherReplacement },
      },
      {
        endpoint: {},
      },
    ]);

    expect(composed.endpoint?.meta).toEqual({ role: "second" });
    expect(composed.endpoint?.implementation).toEqual({ second: true });
    expect(composed.endpoint?.connectTo).toEqual([]);
    expect(composed.policy).toEqual({ canCall: firstCanCall });
    expect(composed.descriptors).toEqual({
      peer: { role: "peer" },
      duplicate: { role: "new" },
    });
    expect(composed.matchers?.active).toBe(matcherReplacement);
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
    const nexus = new Nexus<any, any>();
    const token = new Token<object>("configure:replace-provider");
    const firstService = { value: "first" };
    const replacementService = { value: "replacement" };

    nexus.configure({
      endpoint: {
        meta: { role: "first", stale: true },
        implementation: { first: true },
        connectTo: [{ descriptor: { role: "peer" } }],
      },
      providers: [serviceProvider(token, firstService)],
      descriptors: { peer: { role: "old" } },
    });
    nexus.configure({
      endpoint: {
        meta: { role: "second" },
        implementation: { listen: vi.fn() },
        connectTo: [],
      },
      providers: [serviceProvider(token, replacementService)],
      descriptors: { peer: { role: "new" } },
    });

    await nexus.ready();

    expect((nexus as any).connectionManager.localEndpointMeta).toEqual({
      role: "second",
    });
    expect((nexus as any).config.endpoint.connectTo).toEqual([]);
    expect((nexus as any).config.descriptors).toEqual({
      peer: { role: "new" },
    });
    expect(
      (nexus as any).engine.resourceManager.getExposedService(token.id),
    ).toBe(replacementService);
  });
});
