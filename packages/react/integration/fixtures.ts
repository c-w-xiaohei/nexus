import {
  Nexus,
  Token,
  type AdapterModel,
  type ConnectionTargetOf,
  type IEndpoint,
  type IPort,
} from "@nexus-js/core";
import {
  createNexusStore,
  type NexusStoreServiceContract,
} from "@nexus-js/core/state";

type Meta =
  | { context: "client"; id: "react-client" }
  | { context: "host"; hostId: string };
type ConnectionTarget = Meta;

type ConnectionMeta = { from: string };

export interface ReactAdapterModel extends AdapterModel {
  contextMeta: Meta;
  connectionMeta: ConnectionMeta;
  connectionTarget: ConnectionTarget;
}

type PortState = {
  onMessageHandlers: Array<(message: any) => void>;
  onDisconnectHandlers: Array<() => void>;
  peer: PortState | null;
  closed: boolean;
};

type EndpointRef = {
  id: string;
  meta: Meta;
  endpoint: MemoryEndpoint;
};

type ConnectionRef = {
  endpointA: EndpointRef;
  endpointB: EndpointRef;
  stateA: PortState;
  stateB: PortState;
};

type HostConfig = {
  id: string;
  initialCount?: number;
  connectDelayMs?: number;
};

type HarnessOptions = {
  hosts: HostConfig[];
};

export type CounterHarness = {
  client: { nexus: Nexus<ReactAdapterModel> };
  disconnectHost(hostId: string): void;
  getHostSubscriptions(hostId: string): number;
  teardown(): void;
};

class MemoryNetwork {
  private readonly endpoints = new Map<string, EndpointRef>();
  private readonly connections = new Set<ConnectionRef>();

  public register(id: string, meta: Meta, endpoint: MemoryEndpoint): void {
    this.endpoints.set(id, { id, meta, endpoint });
  }

  public connect(
    callerId: string,
    target: ConnectionTargetOf<ReactAdapterModel>,
  ): Promise<{ port: IPort; connectionMeta: ConnectionMeta }> {
    const caller = this.endpoints.get(callerId);
    if (!caller) {
      return Promise.reject(new Error(`Unknown caller endpoint: ${callerId}`));
    }

    const matchedEndpoint = Array.from(this.endpoints.values()).find(
      (candidate) => {
        if (candidate.id === caller.id) {
          return false;
        }

        return matchesTarget(candidate.meta, target);
      },
    );

    if (!matchedEndpoint) {
      return Promise.reject(
        new Error(`No endpoint found for target: ${JSON.stringify(target)}`),
      );
    }

    const [callerPort, targetPort, stateA, stateB] = createLinkedPorts();
    this.connections.add({
      endpointA: caller,
      endpointB: matchedEndpoint,
      stateA,
      stateB,
    });

    const connectNow = () => {
      matchedEndpoint.endpoint.acceptIncoming(targetPort, {
        from: toEndpointLabel(caller.meta),
      });

      return {
        port: callerPort,
        connectionMeta: { from: toEndpointLabel(matchedEndpoint.meta) },
      };
    };

    const targetDelayMs = matchedEndpoint.endpoint.getConnectDelayMs();
    if (targetDelayMs > 0) {
      return new Promise<{ port: IPort; connectionMeta: ConnectionMeta }>(
        (resolve) => {
          setTimeout(() => resolve(connectNow()), targetDelayMs);
        },
      );
    }

    return Promise.resolve(connectNow());
  }

  public disconnectConnectionsForHost(hostId: string): void {
    for (const connection of Array.from(this.connections)) {
      const includesHost =
        (connection.endpointA.meta.context === "host" &&
          connection.endpointA.meta.hostId === hostId) ||
        (connection.endpointB.meta.context === "host" &&
          connection.endpointB.meta.hostId === hostId);

      if (!includesHost) {
        continue;
      }

      closePortState(connection.stateA);
      closePortState(connection.stateB);
      this.connections.delete(connection);
    }
  }

  public teardown(): void {
    for (const connection of Array.from(this.connections)) {
      closePortState(connection.stateA);
      closePortState(connection.stateB);
      this.connections.delete(connection);
    }
    this.endpoints.clear();
  }
}

class MemoryEndpoint implements IEndpoint<ReactAdapterModel> {
  private onConnectHandler:
    | ((port: IPort, connectionMeta: ConnectionMeta) => void)
    | null = null;

  public constructor(
    private readonly network: MemoryNetwork,
    private readonly endpointId: string,
    private readonly connectDelayMs = 0,
  ) {}

  public listen(
    onConnect: (port: IPort, connectionMeta: ConnectionMeta) => void,
  ): void {
    this.onConnectHandler = onConnect;
  }

  public connect(
    target: ConnectionTargetOf<ReactAdapterModel>,
  ): Promise<{ port: IPort; connectionMeta: ConnectionMeta }> {
    return this.network.connect(this.endpointId, target);
  }

  public getConnectDelayMs(): number {
    return this.connectDelayMs;
  }

  public acceptIncoming(port: IPort, connectionMeta: ConnectionMeta): void {
    if (!this.onConnectHandler) {
      throw new Error(`Endpoint ${this.endpointId} is not listening.`);
    }

    this.onConnectHandler(port, connectionMeta);
  }
}

const toEndpointLabel = (meta: Meta): string => {
  return meta.context === "host" ? meta.hostId : meta.id;
};

const matchesTarget = (meta: Meta, target: ConnectionTarget): boolean => {
  for (const [key, value] of Object.entries(target)) {
    if ((meta as Record<string, unknown>)[key] !== value) {
      return false;
    }
  }

  return true;
};

const createLinkedPorts = (): [IPort, IPort, PortState, PortState] => {
  const aState: PortState = {
    onMessageHandlers: [],
    onDisconnectHandlers: [],
    peer: null,
    closed: false,
  };
  const bState: PortState = {
    onMessageHandlers: [],
    onDisconnectHandlers: [],
    peer: null,
    closed: false,
  };

  aState.peer = bState;
  bState.peer = aState;

  const makePort = (state: PortState): IPort => ({
    postMessage(message: unknown) {
      if (state.closed || !state.peer || state.peer.closed) {
        return;
      }

      setTimeout(() => {
        if (!state.peer || state.peer.closed) {
          return;
        }

        for (const handler of state.peer.onMessageHandlers) {
          handler(message);
        }
      }, 0);
    },
    onMessage(handler: (message: unknown) => void) {
      state.onMessageHandlers.push(handler);
    },
    onDisconnect(handler: () => void) {
      state.onDisconnectHandlers.push(handler);
    },
    close() {
      closePortState(state);
    },
  });

  return [makePort(aState), makePort(bState), aState, bState];
};

const closePortState = (state: PortState): void => {
  if (state.closed) {
    return;
  }

  state.closed = true;

  const peer = state.peer;
  state.peer = null;

  for (const handler of state.onDisconnectHandlers) {
    handler();
  }

  if (peer && !peer.closed) {
    peer.closed = true;
    peer.peer = null;

    for (const handler of peer.onDisconnectHandlers) {
      handler();
    }
  }
};

type CounterState = { count: number };
type CounterActions = { increment(by: number): number };

const createCounterStoreCreator =
  (initialCount: number) =>
  (set: (state: Partial<CounterState>) => void, get: () => CounterState) => ({
    count: initialCount,
    increment(by: number) {
      const next = get().count + by;
      set({ count: next });
      return next;
    },
  });

export const createCounterDefinition = () => ({
  token: new Token<NexusStoreServiceContract<CounterState, CounterActions>>(
    "state:react:integration:counter",
  ),
});

export const createReactNexusHarness = async (
  options: HarnessOptions,
): Promise<CounterHarness> => {
  const network = new MemoryNetwork();
  const subscriptionCounts = new Map<string, Set<string>>();
  const bindings: Array<() => void> = [];
  const hostNexusList: Array<{
    hostId: string;
    nexus: Nexus<ReactAdapterModel>;
  }> = [];

  const clientNexus = new Nexus<ReactAdapterModel>();
  const clientEndpoint = new MemoryEndpoint(network, "client", 0);
  network.register(
    "client",
    { context: "client", id: "react-client" },
    clientEndpoint,
  );

  clientNexus.configure({
    endpoint: {
      meta: { context: "client", id: "react-client" },
      implementation: clientEndpoint,
    },
  });

  for (const host of options.hosts) {
    const hostNexus = new Nexus<ReactAdapterModel>();
    const hostEndpoint = new MemoryEndpoint(
      network,
      `host:${host.id}`,
      host.connectDelayMs ?? 0,
    );
    network.register(
      `host:${host.id}`,
      { context: "host", hostId: host.id },
      hostEndpoint,
    );

    const definition = createCounterDefinition();
    const { provider, destroy } = createNexusStore(
      definition,
      createCounterStoreCreator(host.initialCount ?? 0),
      {
        snapshot: (state: CounterState) => ({ count: state.count }),
        expose: ["increment"],
      },
    );
    bindings.push(destroy);
    const activeSubscriptions = new Set<string>();
    subscriptionCounts.set(host.id, activeSubscriptions);

    const implementation = provider.service;
    const wrappedImplementation = {
      ...implementation,
      async subscribe(
        onSync: Parameters<typeof implementation.subscribe>[0],
        ...args: unknown[]
      ) {
        const key = crypto.randomUUID();
        const wrapped = async (event: Parameters<typeof onSync>[0]) => {
          if (event.type === "init") {
            activeSubscriptions.add(key);
            const unsubscribe = event.unsubscribe;
            event = {
              ...event,
              unsubscribe: async () => {
                activeSubscriptions.delete(key);
                return unsubscribe();
              },
            };
          }
          if (event.type === "terminal") activeSubscriptions.delete(key);
          return onSync(event);
        };
        return Reflect.apply(implementation.subscribe, implementation, [
          wrapped,
          ...args,
        ]);
      },
    };

    hostNexus.configure({
      endpoint: {
        meta: { context: "host", hostId: host.id },
        implementation: hostEndpoint,
      },
      providers: [
        {
          token: provider.token,
          service: wrappedImplementation,
        },
      ],
    });

    hostNexusList.push({ hostId: host.id, nexus: hostNexus });
  }

  await Promise.all([
    clientNexus.updateIdentity({ id: "react-client" }),
    ...hostNexusList.map(({ hostId, nexus }) =>
      nexus.updateIdentity({ hostId }),
    ),
  ]);

  return {
    client: { nexus: clientNexus },
    disconnectHost(hostId: string) {
      network.disconnectConnectionsForHost(hostId);
    },
    getHostSubscriptions(hostId: string) {
      return subscriptionCounts.get(hostId)?.size ?? 0;
    },
    teardown() {
      for (const destroy of bindings) destroy();
      network.teardown();
    },
  };
};
