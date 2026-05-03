import { describe, expect, it, vi } from "vitest";

import { Nexus } from "../../src/api/nexus";
import { Token } from "../../src/api/token";
import { relayNexusStore, relayService } from "../../src/relay";
import {
  connectNexusStore,
  defineNexusStore,
  NexusStoreDisconnectedError,
  provideNexusStore,
  type NexusStoreServiceContract,
} from "../../src/state";
import type { IEndpoint } from "../../src/transport/types/endpoint";
import type { IPort } from "../../src/transport/types/port";
import { createMockPortPair } from "../../src/utils/test-utils";

type RelayContext = "host" | "relay-upstream" | "relay-downstream" | "leaf";

interface RelayMeta {
  context: RelayContext;
  id?: string;
}

interface RelayPlatform {
  from: string;
}

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

type CounterActions = Record<string, (...args: any[]) => any> & {
  increment(by: number, actor?: string): number;
};

interface PendingConnection {
  source: RelayMeta;
  resolve(value: [IPort, RelayPlatform]): void;
}

interface NetworkNode {
  meta: RelayMeta;
  listener?: (port: IPort, platform?: RelayPlatform) => void;
  pending: PendingConnection[];
}

const RelayProfileToken = new Token<RelayProfileService>(
  "core.integration.relay.profile",
);

const CounterStoreToken = new Token<
  NexusStoreServiceContract<CounterState, CounterActions>
>("core.integration.relay.counter-store");

const counterStore = defineNexusStore<CounterState, CounterActions>({
  token: CounterStoreToken,
  state: () => ({ count: 0 }),
  actions: ({ getState, setState }) => ({
    increment(by: number, _actor?: string) {
      setState({ count: getState().count + by });
      return getState().count;
    },
  }),
});

const hostTarget = { descriptor: { context: "host" } } as const;
const relayTarget = { descriptor: { context: "relay-downstream" } } as const;

class InMemoryRelayNetwork {
  private readonly nodes = new Map<string, NetworkNode>();
  private readonly ports = new Set<IPort>();

  createEndpoint(meta: RelayMeta): IEndpoint<RelayMeta, RelayPlatform> {
    const node: NetworkNode = { meta, pending: [] };
    this.nodes.set(this.key(meta), node);

    return {
      listen: (onConnect) => {
        node.listener = onConnect;
        this.flushPending(node);
      },
      connect: async (descriptor) => {
        const target = this.findNode(descriptor);
        if (!target) {
          throw new Error(
            `No in-memory endpoint matches ${JSON.stringify(descriptor)}`,
          );
        }

        if (target.listener) {
          return this.openConnection(meta, target);
        }

        return new Promise<[IPort, RelayPlatform]>((resolve) => {
          target.pending.push({ source: meta, resolve });
        });
      },
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
  ): [IPort, RelayPlatform] {
    if (!target.listener) {
      throw new Error(`Endpoint ${this.key(target.meta)} is not listening`);
    }

    const [sourcePort, targetPort] = createMockPortPair();
    this.ports.add(sourcePort);
    this.ports.add(targetPort);
    target.listener(targetPort, { from: this.key(source) });
    return [sourcePort, { from: this.key(target.meta) }];
  }

  private findNode(descriptor: Partial<RelayMeta>): NetworkNode | undefined {
    return Array.from(this.nodes.values()).find((node) =>
      Object.entries(descriptor).every(
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

  const hostNexus = new Nexus<RelayMeta, RelayPlatform>();
  const relayUpstreamNexus = new Nexus<RelayMeta, RelayPlatform>();
  const relayDownstreamNexus = new Nexus<RelayMeta, RelayPlatform>();
  const leafANexus = new Nexus<RelayMeta, RelayPlatform>();
  const leafBNexus = new Nexus<RelayMeta, RelayPlatform>();

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
    services: [{ token: RelayProfileToken, implementation: profileService }],
  });

  const hostCounterService = provideNexusStore(counterStore).implementation;
  const instrumentedCounterService: typeof hostCounterService = {
    subscribe: hostCounterService.subscribe.bind(hostCounterService),
    unsubscribe: hostCounterService.unsubscribe.bind(hostCounterService),
    async dispatch(action, args, invocationContext) {
      hostDispatchCalls.push({ action, args: [...args] });
      return hostCounterService.dispatch(action, args, invocationContext);
    },
  };

  for (const symbol of Object.getOwnPropertySymbols(hostCounterService)) {
    const value = (
      hostCounterService as unknown as Record<PropertyKey, unknown>
    )[symbol];
    Object.defineProperty(instrumentedCounterService, symbol, {
      value:
        typeof value === "function" ? value.bind(hostCounterService) : value,
    });
  }

  hostNexus.configure({
    services: [
      { token: counterStore.token, implementation: instrumentedCounterService },
    ],
  });

  relayUpstreamNexus.configure({
    endpoint: {
      meta: { context: "relay-upstream" },
      implementation: network.createEndpoint({ context: "relay-upstream" }),
      connectTo: [hostTarget],
    },
  });

  relayDownstreamNexus.configure({
    endpoint: {
      meta: { context: "relay-downstream" },
      implementation: network.createEndpoint({ context: "relay-downstream" }),
    },
    services: [
      relayService<
        RelayProfileService,
        RelayMeta,
        RelayPlatform,
        RelayMeta,
        RelayPlatform
      >(RelayProfileToken, {
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
      }),
      relayNexusStore<
        CounterState,
        CounterActions,
        RelayMeta,
        RelayPlatform,
        RelayMeta,
        RelayPlatform
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
      connectTo: [relayTarget],
    },
  });

  leafBNexus.configure({
    endpoint: {
      meta: { context: "leaf", id: "leaf-b" },
      implementation: network.createEndpoint({ context: "leaf", id: "leaf-b" }),
      connectTo: [relayTarget],
    },
  });

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
        harness.leafANexus,
        counterStore,
        {
          target: relayTarget,
        },
      );
      const remoteB = await connectNexusStore(
        harness.leafBNexus,
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
        harness.leafANexus,
        counterStore,
        {
          target: relayTarget,
        },
      );
      const remoteB = await connectNexusStore(
        harness.leafBNexus,
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
        harness.leafANexus,
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
      ).rejects.toBeInstanceOf(NexusStoreDisconnectedError);

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
      ).rejects.toBeInstanceOf(NexusStoreDisconnectedError);

      stopA();
      remoteA.destroy();
    } finally {
      harness.network.close();
    }
  });
});
