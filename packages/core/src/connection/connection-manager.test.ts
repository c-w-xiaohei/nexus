import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConnectionManager } from "./connection-manager";
import { Transport } from "@/transport";
import type { IEndpoint } from "@/transport/types/endpoint";
import {
  createConnectionManagerStack,
  createMockPortPair,
} from "@/utils/test-utils";
import type { ConnectionManagerHandlers } from "./types";
import type { IPort } from "@/transport/types/port";
import { NexusMessageType, type ApplyMessage } from "@/types/message";
import type { AdapterModel } from "@/types/adapter-model";
import { JsonSerializer } from "@/transport/serializers/json-serializer";

interface TestUserMeta {
  context: string;
  id: number;
  groups?: string[];
}
interface TestConnectionMeta {
  from: string;
}

interface TestAdapterModel extends AdapterModel {
  contextMeta: TestUserMeta;
  connectionMeta: TestConnectionMeta;
  connectionTarget: TestUserMeta;
}

const matchesTarget = (target: TestUserMeta, contextMeta: TestUserMeta) =>
  Object.entries(target).every(
    ([key, value]) => contextMeta[key as keyof TestUserMeta] === value,
  );

const createTestStack = async (
  meta: TestUserMeta,
  onConnect: (port: IPort, connectionMeta?: TestConnectionMeta) => void,
  config?: any,
) => {
  const stack = await createConnectionManagerStack<TestAdapterModel>(
    meta,
    onConnect,
    config,
  );
  stack.mockEndpoint.matchesTarget = matchesTarget;
  return stack;
};

const initializeManager = <M extends AdapterModel>(
  manager: ConnectionManager<M>,
): Promise<void> =>
  manager.safeInitialize().then((result) => {
    if (result.isErr()) throw result.error;
  });

const resolveManager = async <M extends AdapterModel>(
  manager: ConnectionManager<M>,
  options: any,
) =>
  manager.safeResolveConnection(options).then((result) => {
    if (result.isErr()) throw result.error;
    return result.value;
  });

const resolveManagerCandidates = async <M extends AdapterModel>(
  manager: ConnectionManager<M>,
  options: any,
) =>
  manager.safeResolveConnections(options).then((result) => {
    if (result.isErr()) throw result.error;
    return result.value;
  });

const sendFromManager = <M extends AdapterModel>(
  manager: ConnectionManager<M>,
  target: any,
  message: any,
): string[] => {
  const result = manager.safeSendMessage(target, message);
  if (result.isErr()) throw result.error;
  return result.value;
};

const updateManagerIdentity = <M extends AdapterModel>(
  manager: ConnectionManager<M>,
  updates: Partial<M["contextMeta"]>,
): void => {
  const result = manager.safeUpdateLocalIdentity(updates);
  if (result.isErr()) {
    throw result.error;
  }
};

describe("ConnectionManager", () => {
  // L1 Mocks
  let mockHostEndpoint: IEndpoint<TestAdapterModel>;
  let hostL1OnConnect: (
    port: IPort,
    connectionMeta?: TestConnectionMeta,
  ) => void;

  // L2 state
  let hostManager: ConnectionManager<TestAdapterModel>;

  // L3 Handlers Mocks
  let mockHostHandlers: ConnectionManagerHandlers<TestAdapterModel>;

  // Test Data
  const hostMeta: TestUserMeta = { context: "host", id: 1 };
  const clientMeta: TestUserMeta = { context: "client", id: 2 };

  beforeEach(() => {
    // Mock for the host's L1 endpoint
    mockHostEndpoint = {
      listen: vi.fn((onConnect) => {
        hostL1OnConnect = onConnect;
      }),
      connect: vi.fn(async () => {
        // Default service for host endpoint (usually not used)
        const [port] = createMockPortPair();
        return { port, connectionMeta: { from: "mock" } };
      }),
      matchesTarget: (target, contextMeta) =>
        contextMeta.context === target.context,
    };

    // Real L1 Transport for the host
    const hostTransport = Transport.create(mockHostEndpoint);

    // Mock L3 handlers for the host
    mockHostHandlers = {
      onMessage: vi.fn(),
      onDisconnect: vi.fn(),
    };

    // Create the L2 ConnectionManager state for the host
    hostManager = new ConnectionManager(
      {},
      hostTransport,
      mockHostHandlers,
      hostMeta,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("Connection Establishment (B1)", () => {
    it("should reject incoming connections when policy.canConnect returns false", async () => {
      hostManager = new ConnectionManager(
        {
          policy: {
            canConnect: vi.fn(() => false),
          },
        } as any,
        Transport.create(mockHostEndpoint),
        mockHostHandlers,
        hostMeta,
      );
      await initializeManager(hostManager);
      const { manager: clientManager } = await createTestStack(
        clientMeta,
        hostL1OnConnect,
      );

      await expect(
        resolveManager(clientManager, { target: hostMeta }),
      ).rejects.toMatchObject({ code: "E_AUTH_CONNECT_DENIED" });

      await vi.waitFor(() => {
        expect(hostManager.connections.size).toBe(0);
      });
    });

    it("does not expose incoming connections while canConnect is pending or denied", async () => {
      let resolvePolicy!: (allowed: boolean) => void;
      const canConnect = vi.fn(
        () => new Promise<boolean>((resolve) => (resolvePolicy = resolve)),
      );
      hostManager = new ConnectionManager(
        {
          policy: {
            canConnect,
          },
        } as any,
        Transport.create(mockHostEndpoint),
        mockHostHandlers,
        hostMeta,
      );
      await initializeManager(hostManager);
      const { manager: clientManager } = await createTestStack(
        { ...clientMeta, groups: ["group-denied"] },
        hostL1OnConnect,
      );

      const resolution = resolveManager(clientManager, {
        target: hostMeta,
      });
      await vi.waitFor(() => expect(canConnect).toHaveBeenCalled());
      await vi.waitFor(() => {
        expect(hostManager.connections.size).toBe(0);
      });
      expect(hostManager.serviceGroups.get("group-denied")).toBeUndefined();

      resolvePolicy(false);

      await expect(resolution).rejects.toMatchObject({
        code: "E_AUTH_CONNECT_DENIED",
      });
      expect(hostManager.connections.size).toBe(0);
      expect(hostManager.serviceGroups.get("group-denied")).toBeUndefined();
    });

    it("does not expose outgoing connections while remote canConnect is pending or denied", async () => {
      let resolvePolicy!: (allowed: boolean) => void;
      const canConnect = vi.fn(
        () => new Promise<boolean>((resolve) => (resolvePolicy = resolve)),
      );
      hostManager = new ConnectionManager(
        {
          policy: {
            canConnect,
          },
        } as any,
        Transport.create(mockHostEndpoint),
        mockHostHandlers,
        hostMeta,
      );
      await initializeManager(hostManager);
      const { manager: clientManager } = await createTestStack(
        { ...clientMeta, groups: ["group-denied"] },
        hostL1OnConnect,
      );

      const resolution = resolveManager(clientManager, { target: hostMeta });
      await vi.waitFor(() => expect(canConnect).toHaveBeenCalled());
      await vi.waitFor(() => {
        expect(hostManager.connections.size).toBe(0);
      });
      expect(clientManager.connections.size).toBe(0);
      expect(clientManager.serviceGroups.get("group-denied")).toBeUndefined();

      resolvePolicy(false);

      await expect(resolution).rejects.toMatchObject({
        code: "E_AUTH_CONNECT_DENIED",
      });
      expect(clientManager.connections.size).toBe(0);
      expect(clientManager.serviceGroups.get("group-denied")).toBeUndefined();
    });

    it("should establish a connection when one manager resolves a connection to a listening manager", async () => {
      // Arrange
      await initializeManager(hostManager);
      const { manager: clientManager, mockEndpoint: mockClientEndpoint } =
        await createTestStack(clientMeta, hostL1OnConnect);
      expect(mockHostEndpoint.listen).toHaveBeenCalledOnce();

      // Act
      const clientConnectionPromise = resolveManager(clientManager, {
        target: hostMeta,
      });

      // Assert
      await expect(clientConnectionPromise).resolves.not.toBeNull();
      const clientConn = await clientConnectionPromise;
      expect(clientConn?.isReady()).toBe(true);
      expect(clientConn?.remoteIdentity).toEqual(hostMeta);

      await vi.waitFor(() => {
        const hostConnections = Array.from(hostManager.connections.values());
        expect(hostConnections).toHaveLength(1);
        expect(hostConnections[0].isReady()).toBe(true);
        expect(hostConnections[0].remoteIdentity).toEqual(clientMeta);
      });

      expect(mockClientEndpoint.connect).toHaveBeenCalledWith(hostMeta);
    });

    it("should fail outgoing connection resolution when the handshake response never arrives", async () => {
      const [clientPort] = createMockPortPair();
      const clientEndpoint: IEndpoint<TestAdapterModel> = {
        listen: vi.fn(),
        connect: vi.fn(async () => ({
          port: clientPort,
          connectionMeta: { from: "silent" },
        })),
      };
      const clientManager = new ConnectionManager(
        { handshakeTimeoutMs: 10 } as any,
        Transport.create(clientEndpoint),
        mockHostHandlers,
        clientMeta,
      );
      await initializeManager(clientManager);

      await expect(
        resolveManager(clientManager, { target: hostMeta }),
      ).rejects.toMatchObject({ code: "E_HANDSHAKE_FAILED" });
    });

    it("should clean up an incoming connection when the handshake request never arrives", async () => {
      const [, hostPort] = createMockPortPair();
      hostManager = new ConnectionManager(
        { handshakeTimeoutMs: 10 } as any,
        Transport.create(mockHostEndpoint),
        mockHostHandlers,
        hostMeta,
      );
      await initializeManager(hostManager);

      hostL1OnConnect(hostPort, { from: "silent" });

      await vi.waitFor(() => expect(hostPort.close).toHaveBeenCalled());
      expect(hostManager.connections.size).toBe(0);
      await vi.waitFor(() =>
        expect(mockHostHandlers.onDisconnect).toHaveBeenCalledWith(
          expect.any(String),
          undefined,
        ),
      );
    });
  });

  describe("Connection Reuse and Concurrency (B2)", () => {
    it("should share concurrent initialization while listener startup is pending", async () => {
      let resolveListen!: () => void;
      mockHostEndpoint.listen = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveListen = resolve;
          }),
      );

      const first = hostManager.safeInitialize();
      const second = hostManager.safeInitialize();

      expect(mockHostEndpoint.listen).toHaveBeenCalledTimes(1);
      resolveListen();
      await expect(first).resolves.toMatchObject({
        isOk: expect.any(Function),
      });
      await expect(second).resolves.toMatchObject({
        isOk: expect.any(Function),
      });
      expect((await first).isOk()).toBe(true);
      expect((await second).isOk()).toBe(true);
      expect(mockHostEndpoint.listen).toHaveBeenCalledTimes(1);
    });

    it("should convert async listener startup rejection to an error result and allow retry", async () => {
      const listenError = new Error("listen failed");
      mockHostEndpoint.listen = vi
        .fn()
        .mockRejectedValueOnce(listenError)
        .mockResolvedValueOnce(undefined);

      const failed = await hostManager.safeInitialize();

      expect(failed.error).toMatchObject({
        name: "ConnectionManagerOperationFailedError",
        code: "E_UNKNOWN",
      });
      expect(() =>
        sendFromManager(
          hostManager,
          { connectionId: "missing" },
          {
            type: NexusMessageType.APPLY,
            id: 1,
            resourceId: null,
            path: [],
            args: [],
          },
        ),
      ).toThrow(/not initialized/);

      const retried = await hostManager.safeInitialize();

      expect(retried.isOk()).toBe(true);
      expect(mockHostEndpoint.listen).toHaveBeenCalledTimes(2);
    });

    it("should reuse an existing connection if a matching one is found", async () => {
      // Arrange
      await initializeManager(hostManager);
      const { manager: clientManager, mockEndpoint: mockClientEndpoint } =
        await createTestStack(clientMeta, hostL1OnConnect);
      const targetKey = vi.fn(() => "host-target");
      mockClientEndpoint.targetKey = targetKey;
      const initialConnection = await resolveManager(clientManager, {
        target: hostMeta,
      });
      expect(initialConnection).not.toBeNull();
      expect(mockClientEndpoint.connect).toHaveBeenCalledTimes(1);
      expect(targetKey).toHaveBeenCalledTimes(1);

      // Act
      const reusedConnection = await resolveManager(clientManager, {
        target: hostMeta,
      });

      // Assert
      expect(reusedConnection).toBe(initialConnection);
      expect(mockClientEndpoint.connect).toHaveBeenCalledTimes(1);
      expect(targetKey).toHaveBeenCalledTimes(1);
    });

    it("should handle concurrent connection requests for the same target", async () => {
      // Arrange
      await initializeManager(hostManager);
      const { manager: clientManager, mockEndpoint: mockClientEndpoint } =
        await createTestStack(clientMeta, hostL1OnConnect);
      mockClientEndpoint.targetKey = vi.fn(() => "same-target");

      // Act
      const [conn1, conn2] = await Promise.all([
        resolveManager(clientManager, { target: hostMeta }),
        resolveManager(clientManager, {
          target: { id: 1, context: "host", groups: ["different-shape"] },
        }),
      ]);

      // Assert
      expect(conn1).not.toBeNull();
      expect(conn2).not.toBeNull();
      expect(conn1).toBe(conn2);
      expect(mockClientEndpoint.connect).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        const hostConnections = Array.from(hostManager.connections.values());
        expect(hostConnections).toHaveLength(1);
      });
    });
  });

  describe("Service Discovery and Group Routing (B3)", () => {
    it("passes separate context and shallow connection metadata to adapter matching", async () => {
      const connectionMeta = { from: "client" };
      const matchesTargetSpy = vi.fn(() => true);
      mockHostEndpoint.matchesTarget = matchesTargetSpy;

      await initializeManager(hostManager);
      const client = await createTestStack(clientMeta, hostL1OnConnect);
      (
        client.mockEndpoint.connect as ReturnType<typeof vi.fn>
      ).mockImplementationOnce(async () => {
        const [clientPort, hostPort] = createMockPortPair();
        hostL1OnConnect(hostPort, connectionMeta);
        return { port: clientPort, connectionMeta: { from: "host" } };
      });

      await resolveManager(client.manager, { target: hostMeta });
      connectionMeta.from = "mutated";
      expect(() => {
        const snapshot = Array.from(hostManager.connections.values())[0];
        (snapshot.context.connection as { from: string }).from = "replaced";
      }).toThrow(TypeError);

      await resolveManagerCandidates(hostManager, { target: clientMeta });

      expect(matchesTargetSpy).toHaveBeenCalledWith(clientMeta, clientMeta, {
        from: "client",
      });
    });

    it("should expose connection and service group snapshots that cannot mutate manager internals", async () => {
      await initializeManager(hostManager);
      const client = await createTestStack(
        { ...clientMeta, groups: ["group-1"] },
        hostL1OnConnect,
      );

      await resolveManager(client.manager, { target: hostMeta });

      await vi.waitFor(() => {
        expect(hostManager.connections.size).toBe(1);
        expect(hostManager.serviceGroups.get("group-1")?.size).toBe(1);
      });
      const connectionsSnapshot = hostManager.connections as Map<string, any>;
      const groupsSnapshot = hostManager.serviceGroups as Map<
        string,
        Set<string>
      >;
      connectionsSnapshot.clear();
      groupsSnapshot.get("group-1")?.clear();
      groupsSnapshot.clear();

      expect(hostManager.connections.size).toBe(1);
      expect(hostManager.serviceGroups.get("group-1")?.size).toBe(1);
    });

    it("should register connections into service groups and route messages correctly", async () => {
      // Arrange: Create two clients with different group memberships
      const clientAMeta: TestUserMeta = {
        context: "client",
        id: 10,
        groups: ["group-1"],
      };
      const clientBMeta: TestUserMeta = {
        context: "client",
        id: 20,
        groups: ["group-1", "group-2"],
      };

      await initializeManager(hostManager);

      const clientA = await createTestStack(clientAMeta, hostL1OnConnect);
      const clientB = await createTestStack(clientBMeta, hostL1OnConnect);

      // Act: Connect both clients to the host
      await Promise.all([
        resolveManager(clientA.manager, { target: hostMeta }),
        resolveManager(clientB.manager, { target: hostMeta }),
      ]);

      // Assert: Service groups are correctly populated on the host
      let clientAConnId: string, clientBConnId: string;
      await vi.waitFor(() => {
        const hostConnections = [...hostManager.connections.values()];
        expect(hostConnections).toHaveLength(2);
        clientAConnId = hostConnections.find(
          (c) => c.remoteIdentity?.id === 10,
        )!.connectionId;
        clientBConnId = hostConnections.find(
          (c) => c.remoteIdentity?.id === 20,
        )!.connectionId;
        const groups = hostManager.serviceGroups;
        expect(groups.get("group-1")).toEqual(
          new Set([clientAConnId, clientBConnId]),
        );
        expect(groups.get("group-2")).toEqual(new Set([clientBConnId]));
      });

      // Arrange: Create a valid test message to check routing
      const testMessage: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 1,
        resourceId: null, // This can be null for global/static methods
        path: ["testEvent"], // The "path" can represent the event name
        args: [{ value: 42 }], // The payload can be in the args
      };

      // Act & Assert: Send message to group-1, both clients should receive it
      sendFromManager(hostManager, { group: "group-1" }, testMessage);
      await vi.waitFor(() => {
        expect(clientA.handlers.onMessage).toHaveBeenCalledWith(
          testMessage,
          expect.any(String),
        );
        expect(clientB.handlers.onMessage).toHaveBeenCalledWith(
          testMessage,
          expect.any(String),
        );
      });

      vi.clearAllMocks();

      // Act & Assert: Send message to group-2, only client B should receive it
      sendFromManager(hostManager, { group: "group-2" }, testMessage);
      await vi.waitFor(() => {
        expect(clientB.handlers.onMessage).toHaveBeenCalledWith(
          testMessage,
          expect.any(String),
        );
      });
      expect(clientA.handlers.onMessage).not.toHaveBeenCalled();
    });
  });

  describe("Connection Disconnect and Cleanup (B4)", () => {
    it("settles an outgoing queued-publication failure without waiting for the handshake timeout", async () => {
      try {
        let readyPortHandler: ((packet: string) => void) | undefined;
        let failingPortHandler: ((packet: string) => void) | undefined;
        let failingHandshakeId: number | undefined;
        const createPeerPort = (kind: "ready" | "failing"): IPort => {
          let onMessage: ((packet: string) => void) | undefined;
          return {
            postMessage: vi.fn((packet: string) => {
              const decoded = JsonSerializer.safeDeserialize(packet);
              if (decoded.isErr()) throw decoded.error;
              const message = decoded.value as {
                type: NexusMessageType;
                id: number;
              };
              if (message.type === NexusMessageType.HANDSHAKE_REQ) {
                if (kind === "failing") {
                  failingHandshakeId = message.id;
                  return;
                }
                setTimeout(() => {
                  const encoded = JsonSerializer.safeSerialize({
                    type: NexusMessageType.HANDSHAKE_ACK,
                    id: message.id,
                    metadata: { context: kind, id: kind === "ready" ? 3 : 4 },
                    capabilities: ["provider-catalog-v1"],
                    providers: [],
                  });
                  if (encoded.isErr()) throw encoded.error;
                  onMessage?.(encoded.value);
                }, 0);
                return;
              }
              if (
                kind === "failing" &&
                message.type === NexusMessageType.PROVIDER_AVAILABLE
              ) {
                throw new Error("queued provider publication failed");
              }
            }),
            onMessage: vi.fn((handler) => {
              onMessage = handler;
              if (kind === "ready") readyPortHandler = handler;
              else failingPortHandler = handler;
            }),
            onDisconnect: vi.fn(),
            close: vi.fn(),
          };
        };
        const endpoint: IEndpoint<TestAdapterModel> = {
          listen: vi.fn(),
          connect: vi.fn(async (target) => ({
            port: createPeerPort(target.context as "ready" | "failing"),
            connectionMeta: { from: "peer" },
          })),
          matchesTarget: (target, contextMeta) =>
            target.context === contextMeta.context &&
            target.id === contextMeta.id,
        };
        const manager = new ConnectionManager(
          { handshakeTimeoutMs: 30_000 },
          Transport.create(endpoint),
          { onMessage: vi.fn(), onDisconnect: vi.fn() },
          clientMeta,
        );
        await initializeManager(manager);

        const readyPromise = manager.safeResolveConnection({
          target: { context: "ready", id: 3 },
        });
        const readyResult = await readyPromise;
        expect(readyResult.isOk()).toBe(true);
        expect(readyPortHandler).toBeDefined();

        vi.useFakeTimers();
        const failingPromise = manager.safeResolveConnection({
          target: { context: "failing", id: 4 },
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1);
        expect(manager.safePublishProviders(["service.queued"]).isOk()).toBe(
          true,
        );
        expect(failingHandshakeId).toBeDefined();
        const encodedAck = JsonSerializer.safeSerialize({
          type: NexusMessageType.HANDSHAKE_ACK,
          id: failingHandshakeId!,
          metadata: { context: "failing", id: 4 },
          capabilities: ["provider-catalog-v1"],
          providers: [],
        });
        if (encodedAck.isErr()) throw encodedAck.error;
        failingPortHandler?.(encodedAck.value as string);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
        const failingResult = await failingPromise;

        expect(failingResult).toMatchObject({
          error: { code: "E_HANDSHAKE_FAILED" },
        });
        expect(failingPortHandler).toBeDefined();
        expect(manager.connections).toHaveLength(1);
        expect([...manager.connections.values()][0].isReady()).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("publishes static and live provider catalogs and removes them on disconnect", async () => {
      const staticPublished = hostManager.safePublishProviders([
        "service.static",
      ]);
      expect(staticPublished.isOk()).toBe(true);

      await initializeManager(hostManager);
      const client = await createTestStack(clientMeta, hostL1OnConnect);
      const connection = await resolveManager(client.manager, {
        target: hostMeta,
      });

      await vi.waitFor(() => {
        expect(
          client.manager.getReadyProviderConnectionIds("service.static"),
        ).toEqual([connection!.connectionId]);
      });

      const livePublished = hostManager.safePublishProviders(["service.live"]);
      expect(livePublished.isOk()).toBe(true);
      await vi.waitFor(() => {
        expect(
          client.manager.getReadyProviderConnectionIds("service.live"),
        ).toEqual([connection!.connectionId]);
      });

      connection!.close();
      await vi.waitFor(() => {
        expect(
          client.manager.getReadyProviderConnectionIds("service.static"),
        ).toEqual([]);
        expect(
          client.manager.getReadyProviderConnectionIds("service.live"),
        ).toEqual([]);
      });
    });

    it("should clean up all resources when a connection is closed", async () => {
      // Arrange: Set up host and two clients, similar to B3
      const clientAMeta: TestUserMeta = {
        context: "client",
        id: 10,
        groups: ["group-1"],
      };
      const clientBMeta: TestUserMeta = {
        context: "client",
        id: 20,
        groups: ["group-1", "group-2"],
      };

      await initializeManager(hostManager);
      const clientA = await createTestStack(clientAMeta, hostL1OnConnect);
      const clientB = await createTestStack(clientBMeta, hostL1OnConnect);

      const [connA_from_client, connB_from_client] = await Promise.all([
        resolveManager(clientA.manager, { target: hostMeta }),
        resolveManager(clientB.manager, { target: hostMeta }),
      ]);

      let clientBConnOnHost: any;
      await vi.waitFor(() => {
        const hostConnections = [...hostManager.connections.values()];
        expect(hostConnections).toHaveLength(2);
        clientBConnOnHost = hostConnections.find(
          (c) => c.remoteIdentity?.id === 20,
        );
        expect(clientBConnOnHost).toBeDefined();
      });

      // Act: Close the connection from the client's side
      connB_from_client!.close();

      // Assert: The connection is removed from the host, and L3 is notified.
      await vi.waitFor(() => {
        expect(mockHostHandlers.onDisconnect).toHaveBeenCalledOnce();
        expect(mockHostHandlers.onDisconnect).toHaveBeenCalledWith(
          clientBConnOnHost.connectionId,
          clientBMeta,
        );

        const hostConnections = [...hostManager.connections.values()];
        expect(hostConnections).toHaveLength(1);
        expect(hostConnections[0].remoteIdentity).toEqual(clientAMeta);

        const groups = hostManager.serviceGroups;
        expect(groups.get("group-1")?.has(clientBConnOnHost.connectionId)).toBe(
          false,
        );
        expect(groups.get("group-2")?.has(clientBConnOnHost.connectionId)).toBe(
          false,
        );
      });

      expect(clientB.handlers.onDisconnect).toHaveBeenCalledOnce();

      // Make sure other connections are not affected
      expect(connA_from_client!.isReady()).toBe(true);
      expect(mockHostHandlers.onDisconnect).not.toHaveBeenCalledWith(
        expect.any(String),
        clientAMeta,
      );
    });
  });

  describe("No prewarm configuration", () => {
    it("does not establish connections upon initialization", async () => {
      // Arrange
      await initializeManager(hostManager);

      const clientConfig = { connectTo: [hostMeta] };
      const { manager: clientManager, mockEndpoint } = await createTestStack(
        clientMeta,
        hostL1OnConnect,
        clientConfig,
      );

      // Act
      await initializeManager(clientManager);

      expect(mockEndpoint.connect).not.toHaveBeenCalled();

      expect([...hostManager.connections.values()]).toHaveLength(0);
      expect([...clientManager.connections.values()]).toHaveLength(0);
    });

    it("reuses an exact target connection when where passes", async () => {
      // Arrange: Set up host and establish a client connection
      await initializeManager(hostManager);
      const clientAMeta: TestUserMeta = {
        context: "client",
        id: 10,
        groups: ["group-1"],
      };
      const clientA = await createTestStack(clientAMeta, hostL1OnConnect);

      // Create initial connection
      const initialConnection = await resolveManager(clientA.manager, {
        target: hostMeta,
      });
      expect(initialConnection).not.toBeNull();
      expect(clientA.mockEndpoint.connect).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();

      const where = (identity: TestUserMeta) => identity.context === "host";
      const foundConnection = await resolveManager(clientA.manager, {
        target: hostMeta,
        where,
      });

      // Assert: Found the existing connection without creating a new one
      expect(foundConnection).not.toBeNull();
      expect(foundConnection).toBe(initialConnection);
      expect(clientA.mockEndpoint.connect).not.toHaveBeenCalled();
    });

    it("rejects an exact target connection when where fails without redialing", async () => {
      // Arrange: Set up host and establish a client connection
      await initializeManager(hostManager);
      const clientA = await createTestStack(clientMeta, hostL1OnConnect);

      // Create initial connection
      const initialConnection = await resolveManager(clientA.manager, {
        target: hostMeta,
      });
      expect(initialConnection).not.toBeNull();
      vi.clearAllMocks();

      const where = (identity: TestUserMeta) => identity.id === 999;
      await expect(
        resolveManager(clientA.manager, { target: hostMeta, where }),
      ).rejects.toMatchObject({ code: "E_CONNECTION_CONSTRAINT_FAILED" });
      expect(clientA.mockEndpoint.connect).not.toHaveBeenCalled();
    });

    it("should create from a target and apply where after the handshake", async () => {
      // Arrange: Set up host
      await initializeManager(hostManager);
      const clientA = await createTestStack(clientMeta, hostL1OnConnect);

      // Act 1: A target can create a connection, but where still filters its peer identity
      const where = (identity: TestUserMeta) => identity.id === 999;
      await expect(
        resolveManagerCandidates(clientA.manager, {
          where,
          target: hostMeta,
        }),
      ).rejects.toMatchObject({ code: "E_CONNECTION_CONSTRAINT_FAILED" });

      // Assert 1: The target was acquired, then rejected by where
      expect(clientA.mockEndpoint.connect).toHaveBeenCalledTimes(1);
      expect(clientA.mockEndpoint.connect).toHaveBeenCalledWith(hostMeta);
      vi.clearAllMocks();

      // Act 2: A matching where predicate reuses the same target connection
      const matchingWhere = (identity: TestUserMeta) =>
        identity.context === "host";
      const matches = await resolveManagerCandidates(clientA.manager, {
        where: matchingWhere,
        target: hostMeta,
      });

      // Assert 2: Existing connection reused because where matched it
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBeDefined();
      expect(clientA.mockEndpoint.connect).not.toHaveBeenCalled();
    });

    it("reports a new target constraint failure, then reuses the ready session", async () => {
      await initializeManager(hostManager);
      const clientA = await createTestStack(clientMeta, hostL1OnConnect);

      await expect(
        resolveManager(clientA.manager, {
          target: hostMeta,
          where: (identity: TestUserMeta) => identity.id === 999,
        }),
      ).rejects.toMatchObject({ code: "E_CONNECTION_CONSTRAINT_FAILED" });
      expect(clientA.mockEndpoint.connect).toHaveBeenCalledTimes(1);
      expect(clientA.mockEndpoint.connect).toHaveBeenCalledWith(hostMeta);

      const match = await resolveManager(clientA.manager, {
        target: hostMeta,
        where: (identity: TestUserMeta) => identity.id === hostMeta.id,
      });

      expect(match?.isReady()).toBe(true);
      expect(match?.remoteIdentity).toEqual(hostMeta);
      expect(clientA.mockEndpoint.connect).toHaveBeenCalledTimes(1);
    });

    it("returns all matching ready connections in stable allocation order", async () => {
      await initializeManager(hostManager);
      const clientA = await createTestStack(
        { context: "client", id: 10 },
        hostL1OnConnect,
      );
      const clientB = await createTestStack(
        { context: "client", id: 20 },
        hostL1OnConnect,
      );

      await resolveManager(clientA.manager, { target: hostMeta });
      await resolveManager(clientB.manager, { target: hostMeta });

      await vi.waitFor(() => expect(hostManager.connections.size).toBe(2));

      const matches = await resolveManagerCandidates(hostManager, {
        where: (identity: TestUserMeta) => identity.context === "client",
      });

      expect(
        matches.map((connection) => connection.remoteIdentity?.id),
      ).toEqual([10, 20]);
    });

    it("does not actively connect when broadcasting a ready snapshot", async () => {
      await initializeManager(hostManager);
      const where = (identity: TestUserMeta) => identity.context === "client";

      const matches = await resolveManagerCandidates(hostManager, { where });

      expect(matches).toEqual([]);
      expect(mockHostEndpoint.connect).not.toHaveBeenCalled();
    });

    it("creates from a target and only returns it when where verifies remote identity", async () => {
      await initializeManager(hostManager);
      const clientA = await createTestStack(clientMeta, hostL1OnConnect);

      await expect(
        resolveManagerCandidates(clientA.manager, {
          target: hostMeta,
          where: (identity: TestUserMeta) => identity.id === 999,
        }),
      ).rejects.toMatchObject({ code: "E_CONNECTION_CONSTRAINT_FAILED" });

      const match = await resolveManagerCandidates(clientA.manager, {
        target: hostMeta,
        where: (identity: TestUserMeta) => identity.id === hostMeta.id,
      });

      expect(match).toHaveLength(1);
      expect(match[0].remoteIdentity).toEqual(hostMeta);
    });
  });

  describe("Dynamic Identity Update (B6)", () => {
    it("should update remote identity, allowing it to be found by new metadata", async () => {
      // Arrange: Host is connected to a client
      await initializeManager(hostManager);
      const client = await createTestStack(
        { context: "client", id: 10 },
        hostL1OnConnect,
      );
      const hostConnectionOnClient = await resolveManager(client.manager, {
        target: hostMeta,
      });
      await vi.waitFor(() => {
        expect(hostConnectionOnClient?.isReady()).toBe(true);
      });

      // Act: Host updates its own identity
      const hostUpdates: Partial<TestUserMeta> = { id: 999 };
      updateManagerIdentity(hostManager, hostUpdates);

      // Assert: The client can now find the same connection using the new identity
      const newHostMeta = { ...hostMeta, ...hostUpdates };
      await vi.waitFor(async () => {
        const foundConn = await resolveManager(client.manager, {
          target: newHostMeta,
        });
        expect(foundConn).toBe(hostConnectionOnClient);
      });
    });

    it("should update existing connection local identity for authorization snapshots", async () => {
      await initializeManager(hostManager);
      const client = await createTestStack(clientMeta, hostL1OnConnect);
      const connection = await resolveManager(client.manager, {
        target: hostMeta,
      });
      expect(connection).not.toBeNull();

      updateManagerIdentity(client.manager, { id: 777 });

      await vi.waitFor(() => {
        const snapshot = client.manager.getConnectionAuthSnapshot(
          connection!.connectionId,
        );
        expect(snapshot?.localIdentity).toEqual({ ...clientMeta, id: 777 });
      });
    });

    it("should update service groups and route messages correctly after identity update", async () => {
      // Arrange: Host is connected to a client that belongs to 'group-1'
      await initializeManager(hostManager);
      const clientInitialMeta: TestUserMeta = {
        context: "client",
        id: 10,
        groups: ["group-1"],
      };
      const client = await createTestStack(clientInitialMeta, hostL1OnConnect);
      await resolveManager(client.manager, {
        target: hostMeta,
      });

      // Wait for connection to be established.
      await vi.waitFor(() => {
        // Just ensuring the event loop ticks and connection is up
        expect(client.handlers.onMessage).not.toHaveBeenCalled();
      });

      const testMessage: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 1,
        resourceId: null,
        path: ["testEvent"],
        args: [],
      };

      // Assert: Client is initially in group-1
      sendFromManager(hostManager, { group: "group-1" }, testMessage);
      await vi.waitFor(() => {
        expect(client.handlers.onMessage).toHaveBeenCalledTimes(1);
      });
      vi.clearAllMocks();

      // Act: The client updates its identity to join 'group-2' and leave 'group-1'
      const clientUpdates: Partial<TestUserMeta> = {
        groups: ["group-2"],
      };
      updateManagerIdentity(client.manager, clientUpdates);

      // Wait for the identity update to propagate
      await new Promise((r) => setTimeout(r, 50));

      // Assert: Host routes messages to the new group after propagation
      // 1. Send to new group, SHOULD be received
      sendFromManager(hostManager, { group: "group-2" }, testMessage);
      await vi.waitFor(() => {
        expect(client.handlers.onMessage).toHaveBeenCalledTimes(1);
      });

      vi.clearAllMocks();

      // 2. Send to old group, should NOT be received
      sendFromManager(hostManager, { group: "group-1" }, testMessage);
      // A short delay to ensure no message arrives if logic is correct
      await new Promise((r) => setTimeout(r, 20));
      expect(client.handlers.onMessage).not.toHaveBeenCalled();
    });
  });
});
