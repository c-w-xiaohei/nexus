import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import { LogicalConnection } from "./logical-connection";
import { PortProcessor } from "@/transport/port-processor";
import { createMockPortPair } from "@/utils/test-utils";
import type { LogicalConnectionHandlers } from "./types";
import { JsonSerializer } from "@/transport/serializers/json-serializer";
import type { ConnectionContext } from "@/types/identity";
import {
  NexusMessageType,
  type ApplyMessage,
  type IdentityUpdateMessage,
} from "@/types/message";

// 为测试定义简单的元数据类型
interface TestUserMeta {
  context: string;
  id: number;
}
interface TestPlatformMeta {
  from: string;
}

describe("LogicalConnection", () => {
  // Test Data
  const clientMeta: TestUserMeta = { context: "client", id: 2 };
  const hostMeta: TestUserMeta = { context: "host", id: 1 };
  const clientPlatformMeta: TestPlatformMeta = { from: "client" };
  const hostPlatformMeta: TestPlatformMeta = { from: "host" };

  // Mocks and Instances
  let clientConnection: LogicalConnection<TestUserMeta, TestPlatformMeta>;
  let hostConnection: LogicalConnection<TestUserMeta, TestPlatformMeta>;
  let mockClientHandlers: LogicalConnectionHandlers<
    TestUserMeta,
    TestPlatformMeta
  >;
  let mockHostHandlers: LogicalConnectionHandlers<
    TestUserMeta,
    TestPlatformMeta
  >;

  beforeEach(() => {
    const [clientPort, hostPort] = createMockPortPair();
    const serializer = new JsonSerializer();

    // Mock handlers for both sides
    mockClientHandlers = {
      onVerified: vi.fn(),
      onClosed: vi.fn(),
      onMessage: vi.fn(),
      onIdentityUpdated: vi.fn(),
      verify: vi.fn(), // Not used on client-side
    };
    mockHostHandlers = {
      onVerified: vi.fn(),
      onClosed: vi.fn(),
      onMessage: vi.fn(),
      onIdentityUpdated: vi.fn(),
      verify: vi.fn(),
    };

    // To simulate a real scenario, PortProcessors listen to each other
    const clientPortProcessor = new PortProcessor(
      clientPort,
      serializer,
      {
        onLogicalMessage: (msg) => clientConnection.handleMessage(msg),
        onDisconnect: () => clientConnection.handleDisconnect(),
      },
      Infinity
    );

    const hostPortProcessor = new PortProcessor(
      hostPort,
      serializer,
      {
        onLogicalMessage: (msg) => hostConnection.handleMessage(msg),
        onDisconnect: () => hostConnection.handleDisconnect(),
      },
      Infinity
    );

    // Create the LogicalConnection instances
    clientConnection = new LogicalConnection(
      clientPortProcessor,
      mockClientHandlers,
      {
        connectionId: "conn-client",
        localUserMetadata: clientMeta,
        platformMetadata: hostPlatformMeta, // Client gets host's platform meta
      }
    );

    hostConnection = new LogicalConnection(
      hostPortProcessor,
      mockHostHandlers,
      {
        connectionId: "conn-host",
        localUserMetadata: hostMeta,
        platformMetadata: clientPlatformMeta, // Host gets client's platform meta
      }
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Successful Handshake (A1)", () => {
    it("should establish a connection when handshake succeeds", async () => {
      // Arrange: Host policy allows the connection
      (mockHostHandlers.verify as Mock).mockResolvedValue(true);

      // Act: Client initiates the handshake
      clientConnection.initiateHandshake(clientMeta);

      // Assert: The full handshake completes successfully
      await vi.waitFor(() => {
        // 1. Host verifies the client
        expect(mockHostHandlers.verify).toHaveBeenCalledOnce();
        expect(mockHostHandlers.verify).toHaveBeenCalledWith(
          clientMeta,
          expect.objectContaining<Partial<ConnectionContext<TestPlatformMeta>>>(
            {
              platform: clientPlatformMeta,
              connectionId: "conn-host",
            }
          )
        );
      });

      await vi.waitFor(() => {
        // 2. Both sides are notified of verification
        expect(mockHostHandlers.onVerified).toHaveBeenCalledOnce();
        expect(mockHostHandlers.onVerified).toHaveBeenCalledWith({
          connectionId: "conn-host",
          identity: clientMeta,
        });

        expect(mockClientHandlers.onVerified).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onVerified).toHaveBeenCalledWith({
          connectionId: "conn-client",
          identity: hostMeta,
        });

        // 3. Both connections are now ready
        expect(clientConnection.isReady()).toBe(true);
        expect(hostConnection.isReady()).toBe(true);

        // 4. Remote identities are correctly stored
        expect(clientConnection.remoteIdentity).toEqual(hostMeta);
        expect(hostConnection.remoteIdentity).toEqual(clientMeta);
      });
    });
  });

  describe("Rejected Handshake (A2)", () => {
    it("should close the connection when host rejects the handshake", async () => {
      // Arrange: Host policy rejects the connection
      (mockHostHandlers.verify as Mock).mockResolvedValue(false);

      // Act: Client initiates the handshake
      clientConnection.initiateHandshake(clientMeta);

      // Assert: The connection is refused and closed
      await vi.waitFor(() => {
        // 1. Host attempts to verify
        expect(mockHostHandlers.verify).toHaveBeenCalledOnce();
        expect(mockHostHandlers.verify).toHaveBeenCalledWith(
          clientMeta,
          expect.any(Object)
        );
      });

      await vi.waitFor(() => {
        // 2. onVerified is NEVER called for either party
        expect(mockHostHandlers.onVerified).not.toHaveBeenCalled();
        expect(mockClientHandlers.onVerified).not.toHaveBeenCalled();

        // 3. onClosed IS called for both parties
        expect(mockHostHandlers.onClosed).toHaveBeenCalledOnce();
        // Identity is undefined because the connection was never verified
        expect(mockHostHandlers.onClosed).toHaveBeenCalledWith({
          connectionId: "conn-host",
          identity: undefined,
        });

        expect(mockClientHandlers.onClosed).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onClosed).toHaveBeenCalledWith({
          connectionId: "conn-client",
          identity: undefined,
        });
      });

      // 4. Connections are not ready
      expect(clientConnection.isReady()).toBe(false);
      expect(hostConnection.isReady()).toBe(false);
    });
  });

  describe("Christening Handshake (Naming)", () => {
    it("should adopt assigned metadata during a christening handshake", async () => {
      // Arrange
      const assignmentMeta: TestUserMeta = { context: "worker", id: 99 };
      // Host policy must still allow the original client identity to connect
      (mockHostHandlers.verify as Mock).mockResolvedValue(true);

      // Act: Client initiates handshake, assigning new metadata to the host
      clientConnection.initiateHandshake(clientMeta, assignmentMeta);

      // Assert
      await vi.waitFor(() => {
        // 1. Host still verifies the original client identity
        expect(mockHostHandlers.verify).toHaveBeenCalledWith(
          clientMeta,
          expect.any(Object)
        );

        // 2. Host adopts the new metadata and sends it back in the ACK.
        // We can verify this by checking the identity received by the client.
        expect(mockClientHandlers.onVerified).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onVerified).toHaveBeenCalledWith(
          expect.objectContaining({
            identity: assignmentMeta, // Client sees the host's NEW identity
          })
        );

        // 3. The host's local metadata has been updated internally.
        // @ts-expect-error - accessing private property for testing
        expect(hostConnection.localUserMetadata).toEqual(assignmentMeta);

        // 4. The client's remote identity is the new assigned metadata.
        expect(clientConnection.remoteIdentity).toEqual(assignmentMeta);
      });
    });
  });

  describe("Post-Handshake Communication", () => {
    beforeEach(async () => {
      // Establish a connection before each test in this block
      (mockHostHandlers.verify as Mock).mockResolvedValue(true);
      clientConnection.initiateHandshake(clientMeta);
      await vi.waitFor(() => {
        expect(clientConnection.isReady()).toBe(true);
        expect(hostConnection.isReady()).toBe(true);
      });
      // Clear mocks that might have been called during handshake
      vi.clearAllMocks();
    });

    it("should send and receive messages after connection is established", async () => {
      // Arrange: Create a test message
      const testMessage: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 123,
        resourceId: null,
        path: ["doSomething"],
        args: [{ value: "test" }],
      };

      // Act: Client sends a message to the host
      clientConnection.sendMessage(testMessage);

      // Assert: Host receives the message correctly
      await vi.waitFor(() => {
        expect(mockHostHandlers.onMessage).toHaveBeenCalledOnce();
        expect(mockHostHandlers.onMessage).toHaveBeenCalledWith(
          testMessage,
          "conn-host"
        );
      });
      expect(mockClientHandlers.onMessage).not.toHaveBeenCalled();

      // Act: Host sends a message back to the client
      hostConnection.sendMessage(testMessage);

      // Assert: Client receives the message correctly
      await vi.waitFor(() => {
        expect(mockClientHandlers.onMessage).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onMessage).toHaveBeenCalledWith(
          testMessage,
          "conn-client"
        );
      });
    });

    it("should notify both sides with valid identities on active disconnect", async () => {
      // Act: Client closes the connection
      clientConnection.close();

      // Assert: Both sides are notified with the correct, verified identity
      await vi.waitFor(() => {
        expect(mockHostHandlers.onClosed).toHaveBeenCalledOnce();
        expect(mockHostHandlers.onClosed).toHaveBeenCalledWith({
          connectionId: "conn-host",
          identity: clientMeta, // Identity should be present
        });

        expect(mockClientHandlers.onClosed).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onClosed).toHaveBeenCalledWith({
          connectionId: "conn-client",
          identity: hostMeta, // Identity should be present
        });
      });

      // Connections are no longer ready
      expect(clientConnection.isReady()).toBe(false);
      expect(hostConnection.isReady()).toBe(false);
    });
  });

  describe("Dynamic Identity Update", () => {
    beforeEach(async () => {
      // Establish a connection before each test in this block
      (mockHostHandlers.verify as Mock).mockResolvedValue(true);
      clientConnection.initiateHandshake(clientMeta);
      await vi.waitFor(() => {
        expect(clientConnection.isReady()).toBe(true);
        expect(hostConnection.isReady()).toBe(true);
      });
      // Clear mocks that might have been called during handshake
      vi.clearAllMocks();
    });

    it("should update remote identity and call onIdentityUpdated handler", async () => {
      // Arrange
      const updates: Partial<TestUserMeta> = { id: 999 };
      const updateMessage: IdentityUpdateMessage = {
        type: NexusMessageType.IDENTITY_UPDATE,
        id: null,
        updates,
      };
      const expectedNewIdentity: TestUserMeta = { ...hostMeta, ...updates };

      // Act: Host sends an identity update *about itself* to the client
      hostConnection.sendMessage(updateMessage);

      // Assert: Client's view of the host is updated
      await vi.waitFor(() => {
        // 1. The specific handler is called with new and old identities
        expect(mockClientHandlers.onIdentityUpdated).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onIdentityUpdated).toHaveBeenCalledWith(
          "conn-client",
          expectedNewIdentity,
          hostMeta // The original identity
        );

        // 2. The regular message handler is NOT called for this message type
        expect(mockClientHandlers.onMessage).not.toHaveBeenCalled();

        // 3. The remote identity property is updated
        expect(clientConnection.remoteIdentity).toEqual(expectedNewIdentity);
      });
    });

    it("should ignore identity updates if connection is not ready", () => {
      // Arrange: Create a new connection that has not completed handshake
      const freshConnection = new LogicalConnection(
        new PortProcessor(
          createMockPortPair()[0],
          new JsonSerializer(),
          {} as any,
          Infinity
        ),
        mockClientHandlers,
        {
          connectionId: "conn-fresh",
          localUserMetadata: clientMeta,
          platformMetadata: hostPlatformMeta,
        }
      );
      const updates: Partial<TestUserMeta> = { id: 999 };
      const updateMessage: IdentityUpdateMessage = {
        type: NexusMessageType.IDENTITY_UPDATE,
        id: null,
        updates,
      };

      // Act
      freshConnection.handleMessage(updateMessage);

      // Assert
      expect(mockClientHandlers.onIdentityUpdated).not.toHaveBeenCalled();
      expect(freshConnection.remoteIdentity).toBeUndefined();
    });
  });
});
