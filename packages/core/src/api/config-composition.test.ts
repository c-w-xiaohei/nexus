import { describe, expect, it, vi } from "vitest";
import { Nexus } from "./nexus";
import { Token } from "./token";
import { composeNexusConfig } from "./types/config";
import type { AdapterModel } from "../types/adapter-model";

describe("composeNexusConfig", () => {
  it("uses domain-aware last-wins semantics across config layers", () => {
    const firstToken = new Token<object>("config:first");
    const secondToken = new Token<object>("config:second");
    const firstService = { value: "first" };
    const replacementService = { value: "replacement" };
    const secondService = { value: "second" };
    const firstCanCall = vi.fn(() => true);
    const replacementCanCall = vi.fn(() => false);
    const firstEndpoint = { listen: vi.fn() };
    const secondEndpoint = { listen: vi.fn() };
    const composed = composeNexusConfig<AdapterModel>([
      {
        endpoint: {
          meta: { role: "first", stale: true },
          implementation: firstEndpoint,
          defaultTarget: { context: "peer" },
          connectTo: [{ context: "first-owner" }],
        },
        policy: { canCall: firstCanCall },
        providers: [
          {
            token: firstToken,
            service: firstService,
            policy: { canCall: firstCanCall },
          },
        ],
      },
      {
        endpoint: {
          meta: { role: "second" },
          implementation: secondEndpoint,
          defaultTarget: { context: "replacement" },
          connectTo: [],
        },
        providers: [
          {
            token: firstToken,
            service: replacementService,
            policy: { canCall: replacementCanCall },
          },
          { token: secondToken, service: secondService },
        ],
      },
      {
        endpoint: {},
      },
    ]);

    expect(composed.endpoint?.meta).toEqual({ role: "second" });
    expect(composed.endpoint?.implementation).toBe(secondEndpoint);
    expect(composed.endpoint?.defaultTarget).toEqual({
      context: "replacement",
    });
    expect(composed.policy).toEqual({ canCall: firstCanCall });
    expect(composed.endpoint?.connectTo).toEqual([]);
    expect(composed.providers).toEqual([
      {
        token: firstToken,
        service: replacementService,
        policy: { canCall: replacementCanCall },
      },
      { token: secondToken, service: secondService },
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
        implementation: { listen: vi.fn() },
        defaultTarget: { context: "peer" },
      },
      providers: [{ token, service: firstService }],
    });
    nexus.configure({
      endpoint: {
        meta: { role: "second" },
        implementation: { listen: vi.fn() },
        defaultTarget: { context: "replacement" },
      },
      providers: [{ token, service: replacementService }],
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
