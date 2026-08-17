import { vi } from "vitest";
import type { IPort } from "@/transport/types/port";
import type { IEndpoint } from "@/transport/types/endpoint";
import { Transport } from "@/transport/transport";
import type {
  ConnectionManagerConfig,
  ConnectionManagerHandlers,
} from "@/connection/types";
import { ConnectionManager } from "@/connection/connection-manager";
import { Engine } from "@/service/engine";
import type {
  AdapterModel,
  ConnectionMetaOf,
  ConnectionTargetOf,
  ContextMetaOf,
} from "@/types/adapter-model";
import { expect } from "vitest";
import type { NexusInstance } from "@/api/types";
import { Nexus } from "@/api/nexus";
import { Token } from "@/api/token";

export interface TestAdapterModel<
  U extends object,
  P extends object,
> extends AdapterModel {
  contextMeta: U;
  connectionMeta: P;
  connectionTarget: { context: string; issueId?: string };
}

const matchesObject = (target: object, candidate: object): boolean =>
  Object.entries(target).every(
    ([key, value]) => (candidate as Record<string, unknown>)[key] === value,
  );

/**
 * Creates a mock, interconnected pair of IPorts for testing.
 * Messages posted to one port will be received by the other.
 * @returns A tuple containing the two mock ports: [port1, port2].
 */
export function createMockPortPair(): [IPort, IPort] {
  let port1Handler: ((msg: any) => void) | undefined;
  let port2Handler: ((msg: any) => void) | undefined;
  let port1DisconnectHandler: (() => void) | undefined;
  let port2DisconnectHandler: (() => void) | undefined;

  const port1: IPort = {
    postMessage: vi.fn((msg) => {
      // Simulate the asynchronous nature of real-world message passing
      setTimeout(() => port2Handler?.(msg), 0);
    }),
    onMessage: vi.fn((handler) => (port1Handler = handler)),
    onDisconnect: vi.fn((handler) => (port1DisconnectHandler = handler)),
    close: vi.fn(() => {
      port1DisconnectHandler?.();
      port2DisconnectHandler?.();
    }),
  };

  const port2: IPort = {
    postMessage: vi.fn((msg) => {
      // Simulate the asynchronous nature of real-world message passing
      setTimeout(() => port1Handler?.(msg), 0);
    }),
    onMessage: vi.fn((handler) => (port2Handler = handler)),
    onDisconnect: vi.fn((handler) => (port2DisconnectHandler = handler)),
    close: vi.fn(() => {
      port1DisconnectHandler?.();
      port2DisconnectHandler?.();
    }),
  };

  return [port1, port2];
}

/**
 * Creates a full L1/L2 stack for a "client" in a test environment.
 * This includes a mock IEndpoint, a Transport, and a ConnectionManager.
 *
 * @param meta The user metadata for this client stack.
 * @param hostOnConnect A callback simulating the host's L1, which gets invoked
 *                      when this client attempts to connect.
 * @param config Optional configuration for the ConnectionManager, allowing tests
 *               for features like `connectTo`.
 * @returns An object containing the created `manager`, its `mockEndpoint`, and `handlers`.
 */
export async function createConnectionManagerStack<M extends AdapterModel>(
  meta: ContextMetaOf<M>,
  hostOnConnect: (port: IPort, connectionMeta?: ConnectionMetaOf<M>) => void,
  config: ConnectionManagerConfig<M> = {},
) {
  const mockEndpoint: IEndpoint<M> = {
    listen: vi.fn(),
    connect: vi.fn(async (_target: ConnectionTargetOf<M>) => {
      const [clientPort, hostPort] = createMockPortPair();
      // Simulate the host receiving the connection from this client
      hostOnConnect(hostPort, {} as ConnectionMetaOf<M>);
      // Return the client's side of the connection, with host's connection meta
      return { port: clientPort, connectionMeta: {} as ConnectionMetaOf<M> };
    }),
  };
  const transport = Transport.create(mockEndpoint);
  const handlers: ConnectionManagerHandlers<M> = {
    onMessage: vi.fn(),
    onDisconnect: vi.fn(),
  };
  const manager = new ConnectionManager(config, transport, handlers, meta);
  const initResult = await manager.safeInitialize();
  if (initResult.isErr()) {
    throw initResult.error;
  }
  return { manager, mockEndpoint, handlers, transport };
}

/**
 * Creates a full L1-L2 stack for a single endpoint in a test environment.
 * This includes a mock IEndpoint, Transport, and ConnectionManager.
 *
 * @param setup Configuration for the stack.
 * @returns An object containing the L1-L2 components of the created stack.
 */
export function createNexusTestStack<M extends AdapterModel>(setup: {
  meta: ContextMetaOf<M>;
  cmConfig?: ConnectionManagerConfig<M>;
}) {
  const handlers: ConnectionManagerHandlers<M> = {
    onMessage: vi.fn(),
    onDisconnect: vi.fn(),
  };

  const mockEndpoint: IEndpoint<M> = {
    listen: vi.fn(),
    connect: vi.fn(async (_target: ConnectionTargetOf<M>) => {
      // Default service that creates a mock port pair
      const [clientPort] = createMockPortPair();
      return { port: clientPort, connectionMeta: {} as ConnectionMetaOf<M> };
    }),
  };

  const transport = Transport.create(mockEndpoint);

  const connectionManager = new ConnectionManager(
    setup.cmConfig ?? {},
    transport,
    handlers,
    setup.meta,
  );

  return {
    connectionManager,
    mockEndpoint,
    handlers,
    transport,
  };
}

/**
 * Creates a fully connected, end-to-end L1/L2/L3 test environment with a
 * host and a client. It handles the creation of all layers, the handshake,
 * and waits for the connection to be ready.
 *
 * @param hostSetup Configuration for the host endpoint.
 * @param clientSetup Configuration for the client endpoint.
 * @returns A promise that resolves with the full test setup.
 */
export async function createL3Endpoints<M extends AdapterModel>(
  hostSetup: { meta: ContextMetaOf<M>; providers: Record<string, object> },
  clientSetup: {
    meta: ContextMetaOf<M>;
    connectTo?: readonly ConnectionTargetOf<M>[];
  },
) {
  const [clientPort, hostPort] = createMockPortPair();

  // --- Host Setup ---
  const hostStack = createNexusTestStack<M>({
    meta: hostSetup.meta,
  });
  const hostEngine = new Engine(hostStack.connectionManager, {
    providers: Object.fromEntries(
      Object.entries(hostSetup.providers).map(([name, service]) => [
        name,
        { service },
      ]),
    ),
  });
  hostStack.handlers.onMessage = (msg, connId) =>
    void hostEngine
      .safeOnMessage(msg, connId)
      .then((result) =>
        result.match({ ok: () => undefined, err: () => undefined }),
      );
  hostStack.handlers.onDisconnect = (connId) => hostEngine.onDisconnect(connId);

  // The host's mock endpoint will listen for incoming connections.
  hostStack.mockEndpoint.listen = vi.fn((onConnect) => {
    onConnect(hostPort, {} as ConnectionMetaOf<M>);
  });

  // --- Client Setup ---
  const clientStack = createNexusTestStack<M>({
    meta: clientSetup.meta,
    cmConfig: {
      connectTo: clientSetup.connectTo,
    },
  });
  const clientEngine = new Engine(clientStack.connectionManager);
  clientStack.handlers.onMessage = (msg, connId) =>
    void clientEngine
      .safeOnMessage(msg, connId)
      .then((result) =>
        result.match({ ok: () => undefined, err: () => undefined }),
      );
  clientStack.handlers.onDisconnect = (connId) =>
    clientEngine.onDisconnect(connId);

  // The client's mock endpoint will initiate the connection.
  clientStack.mockEndpoint.connect = vi.fn(
    async (_target: ConnectionTargetOf<M>) => {
      // The client's connect method returns its end of the port pair.
      return {
        port: clientPort,
        connectionMeta: {} as ConnectionMetaOf<M>,
      };
    },
  );

  // --- Establish Connection ---
  const hostInitResult = await hostStack.connectionManager.safeInitialize();
  if (hostInitResult.isErr()) {
    throw hostInitResult.error;
  }
  const clientInitResult = await clientStack.connectionManager.safeInitialize();
  if (clientInitResult.isErr()) {
    throw clientInitResult.error;
  }
  const target = clientSetup.connectTo?.[0];
  if (target) {
    const connected = await clientStack.connectionManager.safeResolveConnection(
      {
        target,
      },
    );
    if (connected.isErr()) throw connected.error;
  }

  await vi.waitFor(() => {
    const clientConn = Array.from(
      clientStack.connectionManager["connections"].values(),
    )[0];
    const hostConn = Array.from(
      hostStack.connectionManager["connections"].values(),
    )[0];
    expect(clientConn?.isReady()).toBe(true);
    expect(hostConn?.isReady()).toBe(true);
  });

  const clientConnection = Array.from(
    clientStack.connectionManager["connections"].values(),
  )[0];
  const hostConnection = Array.from(
    hostStack.connectionManager["connections"].values(),
  )[0];

  expect(clientConnection).toBeDefined();
  expect(hostConnection).toBeDefined();

  return {
    clientEngine: clientEngine,
    hostEngine: hostEngine,
    clientCm: clientStack.connectionManager,
    hostCm: hostStack.connectionManager,
    clientConnection,
    hostConnection,
  };
}

/**
 * A comprehensive test utility for creating a fully interconnected star-topology
 * network of Nexus instances for integration testing.
 *
 * @param config The network configuration, specifying a center and multiple leaves.
 * @returns A promise that resolves to a map of endpoint names to their nexus instances.
 */
export async function createStarNetwork<
  U extends { context: string; issueId?: string },
  P extends object,
>(config: {
  center: {
    meta: U;
    providers?: Record<string, object>;
    cmConfig?: ConnectionManagerConfig<TestAdapterModel<U, P>>;
  };
  leaves: {
    meta: U;
    providers?: Record<string, object>;
    cmConfig?: ConnectionManagerConfig<TestAdapterModel<U, P>>;
  }[];
}) {
  const instances = new Map<
    string,
    { nexus: NexusInstance<TestAdapterModel<U, P>> }
  >();
  const allNodes = [config.center, ...config.leaves];

  // 1. Create all Nexus instances first
  for (const node of allNodes) {
    const key =
      node.meta.context === "content-script"
        ? `${node.meta.context}:${node.meta.issueId}`
        : node.meta.context;
    const nexus = new Nexus<TestAdapterModel<U, P>>();
    instances.set(key, { nexus });
  }

  const centerInstance = instances.get(config.center.meta.context)!;
  const leafInstances = new Map(
    Array.from(instances.entries()).filter(
      ([key]) => key !== config.center.meta.context,
    ),
  );

  let centerListenCallback: (port: IPort, connectionMeta?: P) => void;

  // 2. Configure the center node
  centerInstance.nexus.configure({
    endpoint: {
      meta: config.center.meta,
      implementation: {
        listen: vi.fn((onConnect) => (centerListenCallback = onConnect)),
        // This is the crucial fix: The center node must also be able to initiate connections
        // to the leaves, which is needed for "find or create" multicast semantics.
        connect: vi.fn(
          async (target: { context: string; issueId?: string }) => {
            // Find the target leaf instance from its endpoint identity.
            const targetKey =
              target.context === "content-script"
                ? `${target.context}:${target.issueId}`
                : target.context;
            const targetInstance = leafInstances.get(targetKey);
            if (!targetInstance) {
              throw new Error(
                `[test-utils] Center could not find leaf to connect to: ${targetKey}`,
              );
            }

            // Simulate the connection handshake
            const [centerPort, leafPort] = createMockPortPair();
            const targetEndpoint = (targetInstance.nexus as any).config.endpoint
              .implementation as IEndpoint<TestAdapterModel<U, P>>;

            // The leaf's "listen" method needs to be triggered.
            // We need to get the callback that the leaf's transport registered.
            const leafListenCallback = (targetEndpoint.listen as any).mock
              .calls[0][0];
            leafListenCallback(leafPort, {} as P);

            return { port: centerPort, connectionMeta: {} as P };
          },
        ) as IEndpoint<TestAdapterModel<U, P>>["connect"],
        matchesTarget: (target, contextMeta) =>
          matchesObject(target, contextMeta),
      },
    },
    providers: Object.entries(config.center.providers ?? {}).map(
      ([tokenId, service]) => ({
        token: new Token(tokenId),
        service,
      }),
    ),
  });
  await centerInstance.nexus.ready();

  // 3. Configure all leaf nodes
  for (const leaf of config.leaves) {
    const key =
      leaf.meta.context === "content-script"
        ? `${leaf.meta.context}:${leaf.meta.issueId}`
        : leaf.meta.context;
    const leafInstance = instances.get(key)!;

    leafInstance.nexus.configure({
      endpoint: {
        meta: leaf.meta,
        implementation: {
          listen: vi.fn(),
          connect: vi.fn(async () => {
            const [leafPort, centerPort] = createMockPortPair();
            centerListenCallback(centerPort, {} as P);
            return { port: leafPort, connectionMeta: {} as P };
          }) as IEndpoint<TestAdapterModel<U, P>>["connect"],
          matchesTarget: (target, contextMeta) =>
            matchesObject(target, contextMeta),
        },
        defaultTarget: leaf.cmConfig?.connectTo?.[0],
      },
      providers: Object.entries(leaf.providers ?? {}).map(
        ([tokenId, service]) => ({
          token: new Token(tokenId),
          service,
        }),
      ),
    });
  }

  await Promise.all(
    Array.from(leafInstances.values(), ({ nexus }) => nexus.ready()),
  );

  // Test topology setup is explicit: production ready() never acquires peers.
  await Promise.all(
    config.leaves.flatMap((leaf) => {
      const key =
        leaf.meta.context === "content-script"
          ? `${leaf.meta.context}:${leaf.meta.issueId}`
          : leaf.meta.context;
      const manager = (instances.get(key)!.nexus as any).connectionManager;
      return (leaf.cmConfig?.connectTo ?? []).map((target) =>
        manager.safeResolveConnection({ target }),
      );
    }),
  );

  // 4. Wait for all connections to be established
  await vi.waitFor(
    () => {
      for (const instance of instances.values()) {
        const cm = (instance.nexus as any).connectionManager;
        if (!cm) throw new Error("CM not initialized");
        const connections = Array.from((cm as any).connections.values());
        if (connections.length === 0 && instances.size > 1) {
          // If not a solo network, expect connections
          throw new Error("No connections formed");
        }
        for (const conn of connections) {
          if (!(conn as any).isReady()) {
            throw new Error("Connection not ready");
          }
        }
      }
    },
    { timeout: 2000 },
  );

  return instances;
}
