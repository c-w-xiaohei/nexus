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
  type NexusMessage,
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
    const serializer = JsonSerializer.serializer;
    let messageId = 1;
    const nextMessageId = () => messageId++;

    // Mock handlers for both sides
    mockClientHandlers = {
      onVerified: vi.fn(),
      onClosed: vi.fn(),
      onMessage: vi.fn(),
      onIdentityUpdated: vi.fn(),
      verify: vi.fn().mockResolvedValue(true),
    };
    mockHostHandlers = {
      onVerified: vi.fn(),
      onClosed: vi.fn(),
      onMessage: vi.fn(),
      onIdentityUpdated: vi.fn(),
      verify: vi.fn(),
    };

    // To simulate a real scenario, PortProcessors listen to each other
    const clientPortProcessor = PortProcessor.create(
      clientPort,
      serializer,
      {
        onLogicalMessage: (msg: NexusMessage) =>
          clientConnection.safeHandleMessage(msg).match(
            () => undefined,
            (error) => Promise.reject(error),
          ),
        onDisconnect: () => clientConnection.handleDisconnect(),
      },
      { chunkSize: Infinity },
    );

    const hostPortProcessor = PortProcessor.create(
      hostPort,
      serializer,
      {
        onLogicalMessage: (msg: NexusMessage) =>
          hostConnection.safeHandleMessage(msg).match(
            () => undefined,
            (error) => Promise.reject(error),
          ),
        onDisconnect: () => hostConnection.handleDisconnect(),
      },
      { chunkSize: Infinity },
    );

    // Create the LogicalConnection instances
    clientConnection = new LogicalConnection(
      clientPortProcessor,
      mockClientHandlers,
      {
        connectionId: "conn-client",
        localUserMetadata: clientMeta,
        platformMetadata: hostPlatformMeta, // Client gets host's platform meta
        nextMessageId,
      },
    );

    hostConnection = new LogicalConnection(
      hostPortProcessor,
      mockHostHandlers,
      {
        connectionId: "conn-host",
        localUserMetadata: hostMeta,
        platformMetadata: clientPlatformMeta, // Host gets client's platform meta
        nextMessageId,
      },
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
            },
          ),
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
    it("should ignore passive HANDSHAKE_READY while verification is still pending", async () => {
      let resolveVerify!: (allowed: boolean) => void;
      (mockHostHandlers.verify as Mock).mockReturnValue(
        new Promise<boolean>((resolve) => {
          resolveVerify = resolve;
        }),
      );

      void hostConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_REQ,
        id: 77,
        metadata: clientMeta,
      });

      await vi.waitFor(() => {
        expect(mockHostHandlers.verify).toHaveBeenCalledOnce();
      });

      const readyBeforeVerify = hostConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_READY,
        id: 77,
      });

      expect(hostConnection.isReady()).toBe(false);
      expect(mockHostHandlers.onVerified).not.toHaveBeenCalled();

      resolveVerify(false);
      expect((await readyBeforeVerify).isOk()).toBe(true);
      await vi.waitFor(() => {
        expect(mockHostHandlers.verify).toHaveBeenCalledOnce();
        expect(hostConnection.isReady()).toBe(false);
        expect(mockHostHandlers.onVerified).not.toHaveBeenCalled();
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    it("should ignore passive HANDSHAKE_READY with the wrong handshake id", async () => {
      (mockHostHandlers.verify as Mock).mockResolvedValue(true);

      await hostConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_REQ,
        id: 88,
        metadata: clientMeta,
      });

      await vi.waitFor(() => {
        expect(mockHostHandlers.verify).toHaveBeenCalledOnce();
      });

      const wrongReady = await hostConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_READY,
        id: 89,
      });

      expect(wrongReady.isOk()).toBe(true);
      expect(hostConnection.isReady()).toBe(false);
      expect(mockHostHandlers.onVerified).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    it("should not expose ready state when handshake verification rejects", async () => {
      (mockHostHandlers.verify as Mock).mockResolvedValue(false);

      await hostConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_REQ,
        id: 99,
        metadata: clientMeta,
      });

      await vi.waitFor(() => {
        expect(mockHostHandlers.verify).toHaveBeenCalledOnce();
        expect(mockHostHandlers.onVerified).not.toHaveBeenCalled();
        expect(hostConnection.isReady()).toBe(false);
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    it("should reject the active side when ACK verification fails", async () => {
      (mockHostHandlers.verify as Mock).mockResolvedValue(true);
      (mockClientHandlers.verify as Mock).mockResolvedValue(false);

      clientConnection.initiateHandshake(clientMeta);

      await vi.waitFor(() => {
        expect(mockClientHandlers.verify).toHaveBeenCalledWith(
          hostMeta,
          expect.objectContaining<Partial<ConnectionContext<TestPlatformMeta>>>(
            {
              platform: hostPlatformMeta,
              connectionId: "conn-client",
            },
          ),
        );
        expect(mockClientHandlers.onVerified).not.toHaveBeenCalled();
        expect(clientConnection.isReady()).toBe(false);
      });

      expect(clientConnection.handshakeRejectionError).toEqual(
        expect.objectContaining({ code: "E_AUTH_CONNECT_DENIED" }),
      );
    });

    it("should ignore active HANDSHAKE_ACK with the wrong handshake id", async () => {
      (mockClientHandlers.verify as Mock).mockResolvedValue(true);

      const startResult = clientConnection.initiateHandshake(clientMeta);
      expect(startResult.isOk()).toBe(true);

      const wrongAck = await clientConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_ACK,
        id: 999,
        metadata: hostMeta,
      });

      expect(wrongAck.isOk()).toBe(true);
      expect(mockClientHandlers.verify).not.toHaveBeenCalled();
      expect(mockClientHandlers.onVerified).not.toHaveBeenCalled();
      expect(clientConnection.isReady()).toBe(false);
    });

    it("should not mark the passive side verified when active ACK verification fails", async () => {
      (mockHostHandlers.verify as Mock).mockResolvedValue(true);
      (mockClientHandlers.verify as Mock).mockResolvedValue(false);

      clientConnection.initiateHandshake(clientMeta);

      await vi.waitFor(() => {
        expect(mockClientHandlers.verify).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onVerified).not.toHaveBeenCalled();
        expect(mockHostHandlers.onVerified).not.toHaveBeenCalled();
        expect(clientConnection.isReady()).toBe(false);
        expect(hostConnection.isReady()).toBe(false);
      });

      expect(clientConnection.handshakeRejectionError).toEqual(
        expect.objectContaining({ code: "E_AUTH_CONNECT_DENIED" }),
      );
    });

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
          expect.any(Object),
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
          expect.any(Object),
        );

        // 2. Host adopts the new metadata and sends it back in the ACK.
        // We can verify this by checking the identity received by the client.
        expect(mockClientHandlers.onVerified).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onVerified).toHaveBeenCalledWith(
          expect.objectContaining({
            identity: assignmentMeta, // Client sees the host's NEW identity
          }),
        );

        // 3. The host's local metadata has been updated internally.
        // @ts-expect-error - accessing private property for testing
        expect(hostConnection.localUserMetadata).toEqual(assignmentMeta);

        // 4. The client's remote identity is the new assigned metadata.
        expect(clientConnection.remoteIdentity).toEqual(assignmentMeta);
      });
    });

    it("should verify a christening handshake against the pre-assignment local identity", async () => {
      const assignmentMeta: TestUserMeta = { context: "worker", id: 99 };
      (mockHostHandlers.verify as Mock).mockImplementationOnce(
        (_identity: TestUserMeta) => hostConnection.localIdentity === hostMeta,
      );

      clientConnection.initiateHandshake(clientMeta, assignmentMeta);

      await vi.waitFor(() => {
        expect(mockHostHandlers.verify).toHaveBeenCalledWith(
          clientMeta,
          expect.any(Object),
        );
        expect(hostConnection.localIdentity).toEqual(assignmentMeta);
        expect(mockHostHandlers.onVerified).toHaveBeenCalledOnce();
      });
    });

    it("should not commit assigned metadata when christening authorization fails", async () => {
      const assignmentMeta: TestUserMeta = { context: "attacker", id: 666 };
      (mockHostHandlers.verify as Mock).mockResolvedValueOnce(false);

      await hostConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_REQ,
        id: 444,
        metadata: clientMeta,
        assigns: assignmentMeta,
      });

      expect(hostConnection.localIdentity).toEqual(hostMeta);
      expect(mockHostHandlers.onVerified).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 10));
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
          "conn-host",
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
          "conn-client",
        );
      });
    });

    it("should forward a response while an earlier service message is still running", async () => {
      let resolveService!: () => void;
      const applyMessage: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 124,
        resourceId: null,
        path: ["service", "call"],
        args: [],
      };
      const responseMessage = {
        type: NexusMessageType.RES,
        id: 125,
        result: "callback-result",
      } as const;
      (mockHostHandlers.onMessage as Mock).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveService = resolve;
          }),
      );

      clientConnection.sendMessage(applyMessage);
      await vi.waitFor(() => {
        expect(mockHostHandlers.onMessage).toHaveBeenCalledWith(
          applyMessage,
          "conn-host",
        );
      });

      clientConnection.sendMessage(responseMessage);

      await vi.waitFor(() => {
        expect(mockHostHandlers.onMessage).toHaveBeenCalledWith(
          responseMessage,
          "conn-host",
        );
      });
      expect(mockHostHandlers.onMessage).toHaveBeenCalledTimes(2);
      resolveService();
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
          hostMeta, // The original identity
        );

        // 2. The regular message handler is NOT called for this message type
        expect(mockClientHandlers.onMessage).not.toHaveBeenCalled();

        // 3. The remote identity property is updated
        expect(clientConnection.remoteIdentity).toEqual(expectedNewIdentity);
      });
    });

    it("should close and reject identity updates denied by connection authorization", async () => {
      (mockClientHandlers.verify as Mock).mockResolvedValueOnce(false);
      const updateMessage: IdentityUpdateMessage = {
        type: NexusMessageType.IDENTITY_UPDATE,
        id: null,
        updates: { context: "admin" },
      };

      hostConnection.sendMessage(updateMessage);

      await vi.waitFor(() => {
        expect(mockClientHandlers.verify).toHaveBeenCalledWith(
          { ...hostMeta, context: "admin" },
          expect.objectContaining<Partial<ConnectionContext<TestPlatformMeta>>>(
            {
              platform: hostPlatformMeta,
              connectionId: "conn-client",
            },
          ),
        );
        expect(clientConnection.remoteIdentity).toEqual(hostMeta);
        expect(mockClientHandlers.onIdentityUpdated).not.toHaveBeenCalled();
        expect(clientConnection.isReady()).toBe(false);
      });
    });

    it("should ignore identity updates if connection is not ready", async () => {
      // Arrange: Create a new connection that has not completed handshake
      const freshConnection = new LogicalConnection(
        PortProcessor.create(
          createMockPortPair()[0],
          JsonSerializer.serializer,
          {} as any,
          { chunkSize: Infinity },
        ),
        mockClientHandlers,
        {
          connectionId: "conn-fresh",
          localUserMetadata: clientMeta,
          platformMetadata: hostPlatformMeta,
          nextMessageId: () => 1,
        },
      );
      const updates: Partial<TestUserMeta> = { id: 999 };
      const updateMessage: IdentityUpdateMessage = {
        type: NexusMessageType.IDENTITY_UPDATE,
        id: null,
        updates,
      };

      // Act
      await freshConnection.safeHandleMessage(updateMessage);

      // Assert
      expect(mockClientHandlers.onIdentityUpdated).not.toHaveBeenCalled();
      expect(freshConnection.remoteIdentity).toBeUndefined();
    });

    it("should apply concurrent identity updates in transport order when verification resolves out of order", async () => {
      let resolveFirstVerify: ((value: boolean) => void) | undefined;
      (mockClientHandlers.verify as Mock).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstVerify = resolve;
          }),
      );
      (mockClientHandlers.verify as Mock).mockResolvedValueOnce(true);

      hostConnection.sendMessage({
        type: NexusMessageType.IDENTITY_UPDATE,
        id: null,
        updates: { id: 10 },
      });
      hostConnection.sendMessage({
        type: NexusMessageType.IDENTITY_UPDATE,
        id: null,
        updates: { context: "latest" },
      });

      await vi.waitFor(() => {
        expect(mockClientHandlers.verify).toHaveBeenCalledTimes(1);
      });
      expect(clientConnection.remoteIdentity).toEqual(hostMeta);

      resolveFirstVerify?.(true);

      await vi.waitFor(() => {
        expect(mockClientHandlers.verify).toHaveBeenCalledTimes(2);
        expect(clientConnection.remoteIdentity).toEqual({
          ...hostMeta,
          id: 10,
          context: "latest",
        });
      });
      expect(mockClientHandlers.onIdentityUpdated).toHaveBeenNthCalledWith(
        1,
        "conn-client",
        { ...hostMeta, id: 10 },
        hostMeta,
      );
      expect(mockClientHandlers.onIdentityUpdated).toHaveBeenNthCalledWith(
        2,
        "conn-client",
        { ...hostMeta, id: 10, context: "latest" },
        { ...hostMeta, id: 10 },
      );
    });

    it("should forward service messages only after earlier identity update authorization completes", async () => {
      let resolveVerify: ((value: boolean) => void) | undefined;
      (mockClientHandlers.verify as Mock).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveVerify = resolve;
          }),
      );
      const updateMessage: IdentityUpdateMessage = {
        type: NexusMessageType.IDENTITY_UPDATE,
        id: null,
        updates: { id: 42 },
      };
      const applyMessage: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 456,
        resourceId: null,
        path: ["secure", "read"],
        args: [],
      };

      hostConnection.sendMessage(updateMessage);
      hostConnection.sendMessage(applyMessage);

      await vi.waitFor(() => {
        expect(mockClientHandlers.verify).toHaveBeenCalledOnce();
      });
      expect(mockClientHandlers.onMessage).not.toHaveBeenCalled();

      resolveVerify?.(true);

      await vi.waitFor(() => {
        expect(clientConnection.remoteIdentity).toEqual({
          ...hostMeta,
          id: 42,
        });
        expect(mockClientHandlers.onMessage).toHaveBeenCalledWith(
          applyMessage,
          "conn-client",
        );
      });
    });

    it("should forward responses while an earlier identity update authorization is pending", async () => {
      let resolveVerify: ((value: boolean) => void) | undefined;
      (mockClientHandlers.verify as Mock).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveVerify = resolve;
          }),
      );
      const updateMessage: IdentityUpdateMessage = {
        type: NexusMessageType.IDENTITY_UPDATE,
        id: null,
        updates: { id: 43 },
      };
      const responseMessage = {
        type: NexusMessageType.RES,
        id: 457,
        result: "callback-result",
      } as const;

      hostConnection.sendMessage(updateMessage);
      hostConnection.sendMessage(responseMessage);

      await vi.waitFor(() => {
        expect(mockClientHandlers.verify).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onMessage).toHaveBeenCalledWith(
          responseMessage,
          "conn-client",
        );
      });
      expect(clientConnection.remoteIdentity).toEqual(hostMeta);

      resolveVerify?.(true);
      await vi.waitFor(() => {
        expect(clientConnection.remoteIdentity).toEqual({
          ...hostMeta,
          id: 43,
        });
      });
    });

    it("should return an error result when forwarded message handling rejects", async () => {
      const error = new Error("handler rejected");
      (mockClientHandlers.onMessage as Mock).mockRejectedValueOnce(error);

      const result = await clientConnection.safeHandleMessage({
        type: NexusMessageType.RES,
        id: 458,
        result: "callback-result",
      });

      expect(result.isErr()).toBe(true);
      result.match(
        () => undefined,
        (actual) => expect(actual).toBe(error),
      );
    });
  });
});
