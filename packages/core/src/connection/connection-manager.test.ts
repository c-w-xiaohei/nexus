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

interface TestUserMeta {
  context: string;
  id: number;
  groups?: string[];
}
interface TestPlatformMeta {
  from: string;
}

const initializeManager = <U extends object, P extends object>(
  manager: ConnectionManager<U, P>,
): void => {
  const result = manager.safeInitialize();
  if (result.isErr()) {
    throw result.error;
  }
};

const resolveManager = async <U extends object, P extends object>(
  manager: ConnectionManager<U, P>,
  options: any,
) =>
  manager.safeResolveConnection(options).match(
    (value) => value,
    (error) => {
      throw error;
    },
  );

const sendFromManager = <U extends object, P extends object>(
  manager: ConnectionManager<U, P>,
  target: any,
  message: any,
): string[] =>
  manager.safeSendMessage(target, message).match(
    (value) => value,
    (error) => {
      throw error;
    },
  );

const updateManagerIdentity = <U extends object, P extends object>(
  manager: ConnectionManager<U, P>,
  updates: Partial<U>,
): void => {
  const result = manager.safeUpdateLocalIdentity(updates);
  if (result.isErr()) {
    throw result.error;
  }
};

describe("ConnectionManager", () => {
  // L1 Mocks
  let mockHostEndpoint: IEndpoint<TestUserMeta, TestPlatformMeta>;
  let hostL1OnConnect: (port: IPort, platformMeta?: TestPlatformMeta) => void;

  // L2 state
  let hostManager: ConnectionManager<TestUserMeta, TestPlatformMeta>;

  // L3 Handlers Mocks
  let mockHostHandlers: ConnectionManagerHandlers<
    TestUserMeta,
    TestPlatformMeta
  >;

  // Test Data
  const hostMeta: TestUserMeta = { context: "host", id: 1 };
  const clientMeta: TestUserMeta = { context: "client", id: 2 };

  beforeEach(() => {
    // Mock for the host's L1 endpoint
    mockHostEndpoint = {
      listen: vi.fn((onConnect) => {
        hostL1OnConnect = onConnect;
      }),
      connect: vi.fn(async (): Promise<[any, any]> => {
        // Default implementation for host endpoint (usually not used)
        const [port] = createMockPortPair();
        return [port, { from: "mock" }];
      }),
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
    vi.clearAllMocks();
  });

  describe("Connection Establishment (B1)", () => {
    it("should establish a connection when one manager resolves a connection to a listening manager", async () => {
      // Arrange
      initializeManager(hostManager);
      const { manager: clientManager, mockEndpoint: mockClientEndpoint } =
        createConnectionManagerStack(clientMeta, hostL1OnConnect);
      expect(mockHostEndpoint.listen).toHaveBeenCalledOnce();

      // Act
      const clientConnectionPromise = resolveManager(clientManager, {
        descriptor: hostMeta,
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
  });

  describe("Connection Reuse and Concurrency (B2)", () => {
    it("should reuse an existing connection if a matching one is found", async () => {
      // Arrange
      initializeManager(hostManager);
      const { manager: clientManager, mockEndpoint: mockClientEndpoint } =
        createConnectionManagerStack(clientMeta, hostL1OnConnect);
      const initialConnection = await resolveManager(clientManager, {
        descriptor: hostMeta,
      });
      expect(initialConnection).not.toBeNull();
      expect(mockClientEndpoint.connect).toHaveBeenCalledTimes(1);

      // Act
      const reusedConnection = await resolveManager(clientManager, {
        descriptor: hostMeta,
      });

      // Assert
      expect(reusedConnection).toBe(initialConnection);
      expect(mockClientEndpoint.connect).toHaveBeenCalledTimes(1);
    });

    it("should handle concurrent connection requests for the same target", async () => {
      // Arrange
      initializeManager(hostManager);
      const { manager: clientManager, mockEndpoint: mockClientEndpoint } =
        createConnectionManagerStack(clientMeta, hostL1OnConnect);

      // Act
      const [conn1, conn2] = await Promise.all([
        resolveManager(clientManager, { descriptor: hostMeta }),
        resolveManager(clientManager, { descriptor: hostMeta }),
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

      initializeManager(hostManager);

      const clientA = createConnectionManagerStack(
        clientAMeta,
        hostL1OnConnect,
      );
      const clientB = createConnectionManagerStack(
        clientBMeta,
        hostL1OnConnect,
      );

      // Act: Connect both clients to the host
      await Promise.all([
        resolveManager(clientA.manager, { descriptor: hostMeta }),
        resolveManager(clientB.manager, { descriptor: hostMeta }),
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
      sendFromManager(hostManager, { groupName: "group-1" }, testMessage);
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
      sendFromManager(hostManager, { groupName: "group-2" }, testMessage);
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

      initializeManager(hostManager);
      const clientA = createConnectionManagerStack(
        clientAMeta,
        hostL1OnConnect,
      );
      const clientB = createConnectionManagerStack(
        clientBMeta,
        hostL1OnConnect,
      );

      const [connA_from_client, connB_from_client] = await Promise.all([
        resolveManager(clientA.manager, { descriptor: hostMeta }),
        resolveManager(clientB.manager, { descriptor: hostMeta }),
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

  describe("Static 'connectTo' Configuration (B5)", () => {
    it("should automatically establish connections upon initialization", async () => {
      // Arrange
      initializeManager(hostManager);

      const clientConfig = { connectTo: [{ descriptor: hostMeta }] };
      const { manager: clientManager, mockEndpoint } =
        createConnectionManagerStack(clientMeta, hostL1OnConnect, clientConfig);

      // Act
      initializeManager(clientManager);

      // Assert: Connection is established automatically
      await vi.waitFor(() => {
        expect(mockEndpoint.connect).toHaveBeenCalledOnce();
        expect(mockEndpoint.connect).toHaveBeenCalledWith(hostMeta);
      });

      await vi.waitFor(() => {
        const hostConnections = [...hostManager.connections.values()];
        expect(hostConnections).toHaveLength(1);
        expect(hostConnections[0].remoteIdentity).toEqual(clientMeta);
      });

      await vi.waitFor(() => {
        const clientConnections = [...clientManager.connections.values()];
        expect(clientConnections).toHaveLength(1);
        expect(clientConnections[0].isReady()).toBe(true);
        expect(clientConnections[0].remoteIdentity).toEqual(hostMeta);
      });
    });

    it("should find an existing connection using a matcher without creating a new one", async () => {
      // Arrange: Set up host and establish a client connection
      initializeManager(hostManager);
      const clientAMeta: TestUserMeta = {
        context: "client",
        id: 10,
        groups: ["group-1"],
      };
      const clientA = createConnectionManagerStack(
        clientAMeta,
        hostL1OnConnect,
      );

      // Create initial connection
      const initialConnection = await resolveManager(clientA.manager, {
        descriptor: hostMeta,
      });
      expect(initialConnection).not.toBeNull();
      expect(clientA.mockEndpoint.connect).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();

      // Act: Use a matcher to find the existing connection
      const matcherFn = (identity: TestUserMeta) => identity.context === "host";
      const foundConnection = await resolveManager(clientA.manager, {
        matcher: matcherFn,
      });

      // Assert: Found the existing connection without creating a new one
      expect(foundConnection).not.toBeNull();
      expect(foundConnection).toBe(initialConnection);
      expect(clientA.mockEndpoint.connect).not.toHaveBeenCalled();
    });

    it("should return null when using a matcher that doesn't match any connection", async () => {
      // Arrange: Set up host and establish a client connection
      initializeManager(hostManager);
      const clientA = createConnectionManagerStack(clientMeta, hostL1OnConnect);

      // Create initial connection
      const initialConnection = await resolveManager(clientA.manager, {
        descriptor: hostMeta,
      });
      expect(initialConnection).not.toBeNull();
      vi.clearAllMocks();

      // Act: Use a matcher that won't match any connection
      const nonMatchingFn = (identity: TestUserMeta) => identity.id === 999;
      const result = await resolveManager(clientA.manager, {
        matcher: nonMatchingFn,
      });

      // Assert: No connection found and no new connection created
      expect(result).toBeNull();
      expect(clientA.mockEndpoint.connect).not.toHaveBeenCalled();
    });

    it("should find-or-create with both matcher and descriptor", async () => {
      // Arrange: Set up host
      initializeManager(hostManager);
      const clientA = createConnectionManagerStack(clientMeta, hostL1OnConnect);

      // Act 1: First call with a non-matching matcher but valid descriptor
      const nonMatchingFn = (identity: TestUserMeta) => identity.id === 999;
      const conn1 = await resolveManager(clientA.manager, {
        matcher: nonMatchingFn,
        descriptor: hostMeta,
      });

      // Assert 1: New connection created because matcher didn't find anything
      expect(conn1).not.toBeNull();
      expect(clientA.mockEndpoint.connect).toHaveBeenCalledTimes(1);
      expect(clientA.mockEndpoint.connect).toHaveBeenCalledWith(hostMeta);
      vi.clearAllMocks();

      // Act 2: Second call with a matching matcher and same descriptor
      const matchingFn = (identity: TestUserMeta) =>
        identity.context === "host";
      const conn2 = await resolveManager(clientA.manager, {
        matcher: matchingFn,
        descriptor: hostMeta,
      });

      // Assert 2: Existing connection reused because matcher found it
      expect(conn2).not.toBeNull();
      expect(conn2).toBe(conn1);
      expect(clientA.mockEndpoint.connect).not.toHaveBeenCalled();
    });
  });

  describe("Dynamic Identity Update (B6)", () => {
    it("should update remote identity, allowing it to be found by new metadata", async () => {
      // Arrange: Host is connected to a client
      initializeManager(hostManager);
      const client = createConnectionManagerStack(
        { context: "client", id: 10 },
        hostL1OnConnect,
      );
      const hostConnectionOnClient = await resolveManager(client.manager, {
        descriptor: hostMeta,
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
          descriptor: newHostMeta,
        });
        expect(foundConn).toBe(hostConnectionOnClient);
      });
    });

    it("should update service groups and route messages correctly after identity update", async () => {
      // Arrange: Host is connected to a client that belongs to 'group-1'
      initializeManager(hostManager);
      const clientInitialMeta: TestUserMeta = {
        context: "client",
        id: 10,
        groups: ["group-1"],
      };
      const client = createConnectionManagerStack(
        clientInitialMeta,
        hostL1OnConnect,
      );
      await resolveManager(client.manager, {
        descriptor: hostMeta,
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
      sendFromManager(hostManager, { groupName: "group-1" }, testMessage);
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
      sendFromManager(hostManager, { groupName: "group-2" }, testMessage);
      await vi.waitFor(() => {
        expect(client.handlers.onMessage).toHaveBeenCalledTimes(1);
      });

      vi.clearAllMocks();

      // 2. Send to old group, should NOT be received
      sendFromManager(hostManager, { groupName: "group-1" }, testMessage);
      // A short delay to ensure no message arrives if logic is correct
      await new Promise((r) => setTimeout(r, 20));
      expect(client.handlers.onMessage).not.toHaveBeenCalled();
    });
  });
});
