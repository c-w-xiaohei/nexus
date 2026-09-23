import { afterEach, describe, expect, it, vi } from "vitest";
import { Nexus } from "../../src/api/nexus";
import type { NexusInstance } from "../../src/api/types";
import { SERVICE_INVOKE_START } from "../../src/service/service-invocation-hooks";
import type { ResourceScope } from "../../src/service/resource-scope";
import {
  connectNexusStore,
  createNexusStore,
  createStoreToken,
} from "../../src/state";
import type { IEndpoint } from "../../src/transport/types/endpoint";
import type { IPort } from "../../src/transport/types/port";
import type { TestAdapterModel } from "../../src/utils/test-utils";
import { createMockPortPair } from "../../src/utils/test-utils";

type Model = TestAdapterModel<{ context: string }, { edge: string }>;
type State = { count: number };
type Actions = { add(by: number): number };
const token = createStoreToken<State & Actions, Model>("state:scoped-relay");
type Name = "A1" | "A2" | "B" | "C" | "E";

class StateRelayNetwork {
  readonly nodes = new Map<Name, Nexus<Model>>();
  readonly scopes: ResourceScope[] = [];
  private readonly accepts = new Map<
    Name,
    (port: IPort, meta: { edge: string }) => void
  >();

  constructor() {
    for (const name of ["A1", "A2", "B", "C", "E"] as const)
      this.nodes.set(name, new Nexus<Model>());
  }

  get(name: Name): NexusInstance<Model> {
    return this.nodes.get(name)!;
  }

  async start(): Promise<void> {
    const binding = createNexusStore(
      token,
      (set, get) => ({
        count: 0,
        add(by: number) {
          set({ count: get().count + by });
          return get().count;
        },
      }),
      { snapshot: ({ count }) => ({ count }), expose: ["add"] },
    );
    const service = binding.provider
      .service as typeof binding.provider.service & {
      [SERVICE_INVOKE_START]?: (context: { scope?: ResourceScope }) => unknown;
    };
    const start = service[SERVICE_INVOKE_START];
    Object.defineProperty(service, SERVICE_INVOKE_START, {
      value: (context: { scope?: ResourceScope }) => {
        if (context.scope) this.scopes.push(context.scope);
        return start?.(context) ?? context;
      },
    });

    for (const [name, nexus] of this.nodes) {
      const endpoint: IEndpoint<Model> = {
        listen: (accept) => {
          this.accepts.set(name, accept);
        },
        connect: async (target) => {
          const destination = target.context as Name;
          const accept = this.accepts.get(destination);
          if (!accept) throw new Error(`No endpoint for ${destination}.`);
          const [local, remote] = createMockPortPair();
          accept(remote, { edge: `${name}->${destination}` });
          return {
            port: local,
            connectionMeta: { edge: `${name}->${destination}` },
          };
        },
        matchesTarget: (target, meta) => target.context === meta.context,
      };
      nexus.configure({
        endpoint: { meta: { context: name }, implementation: endpoint },
        ...(name === "E" ? { providers: [{ token, service }] } : {}),
      });
    }
    Nexus.relay({
      from: this.get("B"),
      to: { nexus: this.get("B"), target: { context: "C" } },
      services: [token],
    });
    Nexus.relay({
      from: this.get("C"),
      to: { nexus: this.get("C"), target: { context: "E" } },
      services: [token],
    });
    await Promise.all([...this.nodes.values()].map((nexus) => nexus.ready()));
  }

  dispose(): void {
    for (const nexus of this.nodes.values()) {
      const manager = (nexus as any).lifecycle.manager;
      for (const connection of manager?.connections.values() ?? [])
        connection.close();
    }
  }
}

describe("State through scoped relay (R18-R20)", () => {
  const networks: StateRelayNetwork[] = [];
  afterEach(() => {
    for (const network of networks.splice(0)) network.dispose();
  });

  it("forwards independent State subscriptions through B/C and leaves a sibling live when E closes one scope", async () => {
    const network = new StateRelayNetwork();
    networks.push(network);
    await network.start();

    const first = await connectNexusStore(network.get("A1"), token, {
      target: { context: "B" },
    });
    const second = await connectNexusStore(network.get("A2"), token, {
      target: { context: "B" },
    });
    const firstSnapshots: number[] = [];
    const secondSnapshots: number[] = [];
    first.subscribe((state) => firstSnapshots.push(state.count));
    second.subscribe((state) => secondSnapshots.push(state.count));
    const firstInstance = first.getStatus();
    const secondInstance = second.getStatus();
    expect(firstInstance).toMatchObject({ type: "ready", version: 0 });
    expect(secondInstance).toMatchObject({ type: "ready", version: 0 });
    if (firstInstance.type === "ready" && secondInstance.type === "ready")
      expect(firstInstance.storeInstanceId).toBe(
        secondInstance.storeInstanceId,
      );
    expect(network.scopes).toHaveLength(2);
    expect(network.scopes[0]).not.toBe(network.scopes[1]);

    await expect(first.actions.add(1)).resolves.toBe(1);
    await expect(second.actions.add(2)).resolves.toBe(3);
    expect(firstSnapshots).toEqual([1, 3]);
    expect(secondSnapshots).toEqual([1, 3]);
    expect(first.getStatus()).toMatchObject({ type: "ready", version: 2 });
    expect(second.getStatus()).toMatchObject({ type: "ready", version: 2 });

    network.scopes[0].close();
    await vi.waitFor(() => expect(first.getStatus().type).toBe("disconnected"));
    await expect(first.actions.add(1)).rejects.toMatchObject({
      code: "E_RESOURCE_SCOPE_CLOSED",
    });
    await expect(second.actions.add(1)).resolves.toBe(4);
    expect(firstSnapshots).toEqual([1, 3]);
    expect(secondSnapshots).toEqual([1, 3, 4]);
    expect(second.getStatus()).toMatchObject({ type: "ready", version: 3 });

    const replacement = await connectNexusStore(network.get("A1"), token, {
      target: { context: "B" },
    });
    expect(replacement.getStatus()).toMatchObject({
      type: "ready",
      version: 3,
    });
    const replacementStatus = replacement.getStatus();
    const secondStatus = second.getStatus();
    if (replacementStatus.type === "ready" && secondStatus.type === "ready")
      expect(replacementStatus.storeInstanceId).toBe(
        secondStatus.storeInstanceId,
      );
    expect(first.getStatus().type).toBe("disconnected");
    replacement.destroy();
    second.destroy();
  });
});
