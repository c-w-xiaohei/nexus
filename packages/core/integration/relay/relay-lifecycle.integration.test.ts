import { describe, expect, it, vi } from "vitest";

import { Nexus } from "../../src/api/nexus";
import { Token } from "../../src/api/token";
import { relayNexusStore, relayService } from "../../src/relay";
import {
  connectNexusStore,
  NexusStoreDisconnectedError,
  createNexusStore,
  type NexusStoreServiceContract,
} from "../../src/state";
import type { IEndpoint } from "../../src/transport/types/endpoint";
import type { IPort } from "../../src/transport/types/port";
import { createMockPortPair } from "../../src/utils/test-utils";
import type { TestAdapterModel } from "../../src/utils/test-utils";
import type { StateCreator } from "zustand/vanilla";

type RelayContext = "host" | "relay-upstream" | "relay-downstream" | "leaf";

interface RelayMeta {
  context: RelayContext;
  id?: string;
}

interface RelayPlatform {
  from: string;
}

type RelayAdapterModel = TestAdapterModel<RelayMeta, RelayPlatform>;

interface RelayProfileService {
  profile: {
    read(childId: string): Promise<{ childId: string; servedBy: string }>;
  };
}

interface RelayPolicyCall {
  origin: RelayMeta;
  path: (string | number)[];
}

interface CounterState {
  count: number;
}

type CounterActions = {
  increment(by: number, actor?: string): number;
};

interface PendingConnection {
  source: RelayMeta;
  resolve(value: { port: IPort; connectionMeta: RelayPlatform }): void;
}

interface NetworkNode {
  meta: RelayMeta;
  listener?: (port: IPort, platform: RelayPlatform) => void;
  pending: PendingConnection[];
}

const RelayProfileToken = new Token<RelayProfileService>(
  "core.integration.relay.profile",
);

const CounterStoreToken = new Token<
  NexusStoreServiceContract<CounterState, CounterActions>,
  RelayAdapterModel
>("core.integration.relay.counter-store");

const counterStore = { token: CounterStoreToken };

const counterCreator: StateCreator<CounterState & CounterActions> = (
  set,
  get,
) => ({
  count: 0,
  increment(by: number, _actor?: string) {
    set({ count: get().count + by });
    return get().count;
  },
});

const hostTarget = { context: "host" } as const;
const relayTarget = { context: "relay-downstream" } as const;

class InMemoryRelayNetwork {
  private readonly nodes = new Map<string, NetworkNode>();
  private readonly ports = new Set<IPort>();

  createEndpoint(meta: RelayMeta): IEndpoint<RelayAdapterModel> {
    const node: NetworkNode = { meta, pending: [] };
    this.nodes.set(this.key(meta), node);

    return {
      listen: (onConnect) => {
        node.listener = (port, platform) => onConnect(port, platform);
        this.flushPending(node);
      },
      connect: async (targetMeta) => {
        const target = this.findNode(targetMeta);
        if (!target) {
          throw new Error(
            `No in-memory endpoint matches ${JSON.stringify(targetMeta)}`,
          );
        }

        if (target.listener) {
          return this.openConnection(meta, target);
        }

        return new Promise<{ port: IPort; connectionMeta: RelayPlatform }>(
          (resolve) => {
            target.pending.push({ source: meta, resolve });
          },
        );
      },
      matchesTarget: (target, contextMeta) =>
        Object.entries(target).every(
          ([key, value]) => contextMeta[key as keyof RelayMeta] === value,
        ),
    };
  }

  close(): void {
    for (const port of this.ports) {
      port.close();
    }
    this.ports.clear();
  }

  private flushPending(target: NetworkNode): void {
    const pending = target.pending.splice(0);
    for (const connection of pending) {
      connection.resolve(this.openConnection(connection.source, target));
    }
  }

  private openConnection(
    source: RelayMeta,
    target: NetworkNode,
  ): { port: IPort; connectionMeta: RelayPlatform } {
    if (!target.listener) {
      throw new Error(`Endpoint ${this.key(target.meta)} is not listening`);
    }

    const [sourcePort, targetPort] = createMockPortPair();
    this.ports.add(sourcePort);
    this.ports.add(targetPort);
    target.listener(targetPort, { from: this.key(source) });
    return {
      port: sourcePort,
      connectionMeta: { from: this.key(target.meta) },
    };
  }

  private findNode(
    target: RelayAdapterModel["connectionTarget"],
  ): NetworkNode | undefined {
    return Array.from(this.nodes.values()).find((node) =>
      Object.entries(target).every(
        ([key, value]) => node.meta[key as keyof RelayMeta] === value,
      ),
    );
  }

  private key(meta: RelayMeta): string {
    return meta.id ? `${meta.context}:${meta.id}` : meta.context;
  }
}

const getReadyConnectionCount = (nexus: object): number => {
  const connections = (
    nexus as {
      connectionManager?: {
        connections?: Map<string, { isReady(): boolean }>;
      };
    }
  ).connectionManager?.connections;

  return Array.from(connections?.values() ?? []).filter((connection) =>
    connection.isReady(),
  ).length;
};

const getReadyConnection = (
  nexus: object,
  predicate: (remoteIdentity: RelayMeta | undefined) => boolean,
): { close(): void } | undefined => {
  const connections = (
    nexus as {
      connectionManager?: {
        connections?: Map<
          string,
          { close(): void; isReady(): boolean; remoteIdentity?: RelayMeta }
        >;
      };
    }
  ).connectionManager?.connections;

  return Array.from(connections?.values() ?? []).find(
    (connection) =>
      connection.isReady() && predicate(connection.remoteIdentity),
  );
};

const closeReadyConnection = (
  nexus: object,
  predicate: (remoteIdentity: RelayMeta | undefined) => boolean,
  description: string,
): void => {
  const connection = getReadyConnection(nexus, predicate);
  if (!connection) {
    throw new Error(`Expected ready connection for ${description}`);
  }

  connection.close();
};

const expectLastUpdate = (updates: number[], expected: number): void => {
  expect(updates.length).toBeGreaterThan(0);
  expect(updates.at(-1)).toBe(expected);
};

async function waitForConnectionsReady(entries: Array<[object, number]>) {
  await vi.waitFor(() => {
    for (const [nexus, expectedCount] of entries) {
      expect(getReadyConnectionCount(nexus)).toBe(expectedCount);
    }
  });
}

async function createRelayHarness() {
  const network = new InMemoryRelayNetwork();
  const hostCalls: string[] = [];
  const hostDispatchCalls: Array<{ action: string; args: unknown[] }> = [];
  const relayPolicyCalls: RelayPolicyCall[] = [];

  const hostNexus = new Nexus<RelayAdapterModel>();
  const relayUpstreamNexus = new Nexus<RelayAdapterModel>();
  const relayDownstreamNexus = new Nexus<RelayAdapterModel>();
  const leafANexus = new Nexus<RelayAdapterModel>();
  const leafBNexus = new Nexus<RelayAdapterModel>();

  const profileService: RelayProfileService = {
    profile: {
      async read(childId) {
        hostCalls.push(childId);
        return { childId, servedBy: "host" };
      },
    },
  };

  hostNexus.configure({
    endpoint: {
      meta: { context: "host" },
      implementation: network.createEndpoint({ context: "host" }),
    },
    providers: [{ token: RelayProfileToken, service: profileService }],
  });

  const hostCounterService = createNexusStore(counterStore, counterCreator, {
    snapshot: (state) => ({ count: state.count }),
    expose: ["increment"],
  }).provider.service;
  const instrumentedCounterService: typeof hostCounterService = {
    ...hostCounterService,
    subscribe: async (onSync, ...args) => {
      const callback: Parameters<
        typeof hostCounterService.subscribe
      >[0] = async (event) => {
        if (event.type === "init") {
          const original = event.actions.increment;
          event = {
            ...event,
            actions: {
              ...event.actions,
              increment: async (
                ...args: Parameters<CounterActions["increment"]>
              ) => {
                hostDispatchCalls.push({
                  action: "increment",
                  args: [...args],
                });
                return original(...args);
              },
            },
          };
        }
        return onSync(event);
      };
      return Reflect.apply(hostCounterService.subscribe, hostCounterService, [
        callback,
        ...args,
      ]);
    },
  };

  hostNexus.configure({
    providers: [
      {
        token: counterStore.token as Token<
          NexusStoreServiceContract<CounterState, CounterActions>,
          RelayAdapterModel
        >,
        service: instrumentedCounterService,
      },
    ],
  });

  relayUpstreamNexus.configure({
    endpoint: {
      meta: { context: "relay-upstream" },
      implementation: network.createEndpoint({ context: "relay-upstream" }),
      defaultTarget: hostTarget,
    },
  });

  relayDownstreamNexus.configure({
    endpoint: {
      meta: { context: "relay-downstream" },
      implementation: network.createEndpoint({ context: "relay-downstream" }),
    },
    providers: [
      relayService<RelayProfileService, RelayAdapterModel, RelayAdapterModel>(
        RelayProfileToken,
        {
          forwardThrough: relayUpstreamNexus,
          forwardTarget: hostTarget,
          policy: {
            canCall(context) {
              relayPolicyCalls.push({
                origin: context.origin,
                path: [...context.path],
              });
              return true;
            },
          },
        },
      ),
      relayNexusStore<
        CounterState,
        CounterActions,
        RelayAdapterModel,
        RelayAdapterModel
      >(counterStore, {
        forwardThrough: relayUpstreamNexus,
        forwardTarget: hostTarget,
      }),
    ],
  });

  leafANexus.configure({
    endpoint: {
      meta: { context: "leaf", id: "leaf-a" },
      implementation: network.createEndpoint({ context: "leaf", id: "leaf-a" }),
      defaultTarget: relayTarget,
    },
  });

  leafBNexus.configure({
    endpoint: {
      meta: { context: "leaf", id: "leaf-b" },
      implementation: network.createEndpoint({ context: "leaf", id: "leaf-b" }),
      defaultTarget: relayTarget,
    },
  });

  await Promise.all([
    relayUpstreamNexus.create(
      counterStore.token as Token<
        NexusStoreServiceContract<CounterState, CounterActions>,
        RelayAdapterModel
      >,
      { target: hostTarget },
    ),
    leafANexus.create(RelayProfileToken, { target: relayTarget }),
    leafBNexus.create(RelayProfileToken, { target: relayTarget }),
  ]);
  await waitForConnectionsReady([
    [hostNexus, 1],
    [relayUpstreamNexus, 1],
    [relayDownstreamNexus, 2],
    [leafANexus, 1],
    [leafBNexus, 1],
  ]);

  return {
    network,
    relayUpstreamNexus,
    relayDownstreamNexus,
    hostCalls,
    hostDispatchCalls,
    relayPolicyCalls,
    leafANexus,
    leafBNexus,
  };
}

describe("Nexus Relay lifecycle integration", () => {
  it("forwards service calls through a real relay Nexus and preserves downstream identity", async () => {
    const harness = await createRelayHarness();
    try {
      const profile = await harness.leafANexus.create(RelayProfileToken, {
        target: relayTarget,
      });

      const profileApi = await profile.profile;
      const result = await profileApi.read("leaf-a");

      expect(result).toEqual({ childId: "leaf-a", servedBy: "host" });
      expect(harness.hostCalls).toEqual(["leaf-a"]);
      expect(harness.relayPolicyCalls).toEqual([
        {
          origin: { context: "leaf", id: "leaf-a" },
          path: ["profile", "read"],
        },
      ]);
    } finally {
      harness.network.close();
    }
  });

  it("projects a host store through a real relay Nexus to multiple leaves", async () => {
    const harness = await createRelayHarness();
    try {
      const remoteA = await connectNexusStore(
        harness.leafANexus as any,
        counterStore,
        {
          target: relayTarget,
        },
      );
      const remoteB = await connectNexusStore(
        harness.leafBNexus as any,
        counterStore,
        {
          target: relayTarget,
        },
      );

      const updatesA: number[] = [];
      const updatesB: number[] = [];
      const stopA = remoteA.subscribe((state) => updatesA.push(state.count));
      const stopB = remoteB.subscribe((state) => updatesB.push(state.count));

      await remoteA.actions.increment(1, "leaf-a");

      await vi.waitFor(() => {
        expect(remoteA.getState()).toEqual({ count: 1 });
        expect(remoteB.getState()).toEqual({ count: 1 });
        expectLastUpdate(updatesA, 1);
        expectLastUpdate(updatesB, 1);
      });
      expect(harness.hostDispatchCalls).toEqual([
        { action: "increment", args: [1, "leaf-a"] },
      ]);

      stopA();
      stopB();
      remoteA.destroy();
      remoteB.destroy();
    } finally {
      harness.network.close();
    }
  });

  it("removes only the disconnected downstream owner while sibling subscriptions continue", async () => {
    const harness = await createRelayHarness();
    try {
      const remoteA = await connectNexusStore(
        harness.leafANexus as any,
        counterStore,
        {
          target: relayTarget,
        },
      );
      const remoteB = await connectNexusStore(
        harness.leafBNexus as any,
        counterStore,
        {
          target: relayTarget,
        },
      );

      const updatesA: number[] = [];
      const updatesB: number[] = [];
      const stopA = remoteA.subscribe((state) => updatesA.push(state.count));
      const stopB = remoteB.subscribe((state) => updatesB.push(state.count));

      await remoteA.actions.increment(1, "leaf-a");
      await vi.waitFor(() => {
        expectLastUpdate(updatesA, 1);
        expectLastUpdate(updatesB, 1);
      });
      const updatesABeforeDisconnect = [...updatesA];

      closeReadyConnection(
        harness.leafANexus as any,
        (identity) => identity?.context === "relay-downstream",
        "leaf A to relay downstream",
      );

      await vi.waitFor(() => {
        expect(remoteA.getStatus().type).toBe("disconnected");
      });

      await remoteB.actions.increment(2, "leaf-b");

      await vi.waitFor(() => {
        expect(remoteB.getState()).toEqual({ count: 3 });
        expectLastUpdate(updatesB, 3);
        expect(updatesA).toEqual(updatesABeforeDisconnect);
      });
      await expect(
        remoteA.actions.increment(1, "leaf-a"),
      ).rejects.toBeDefined();

      stopA();
      stopB();
      remoteA.destroy();
      remoteB.destroy();
    } finally {
      harness.network.close();
    }
  });

  it("terminalizes downstream relay store subscribers when the upstream host connection closes", async () => {
    const harness = await createRelayHarness();
    try {
      const remoteA = await connectNexusStore(
        harness.leafANexus,
        counterStore,
        {
          target: relayTarget,
        },
      );
      const updatesA: number[] = [];
      const stopA = remoteA.subscribe((state) => updatesA.push(state.count));

      await remoteA.actions.increment(1, "leaf-a");
      await vi.waitFor(() => {
        expect(remoteA.getState()).toEqual({ count: 1 });
        expectLastUpdate(updatesA, 1);
      });

      closeReadyConnection(
        harness.relayUpstreamNexus,
        (identity) => identity?.context === "host",
        "relay upstream to host",
      );

      await vi.waitFor(() => {
        expect(remoteA.getStatus()).toMatchObject({
          type: "disconnected",
          cause: expect.any(NexusStoreDisconnectedError),
        });
      });
      await expect(
        remoteA.actions.increment(1, "leaf-a"),
      ).rejects.toBeDefined();

      stopA();
      remoteA.destroy();
    } finally {
      harness.network.close();
    }
  });
});
