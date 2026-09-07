import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConnectionManager } from "./connection-manager";
import { Transport } from "@/transport";
import type { IEndpoint } from "@/transport/types/endpoint";
import {
  createConnectionManagerStack,
  createMockPortPair,
} from "@/utils/test-utils";
import type {
  ConnectionManagerConfig,
  ConnectionManagerHandlers,
  MessageTarget,
  ResolveOptions,
} from "./types";
import type { IPort } from "@/transport/types/port";
import {
  NexusMessageType,
  type ApplyMessage,
  type NexusMessage,
} from "@/types/message";
import type { AdapterModel } from "@/types/adapter-model";
import { JsonSerializer } from "@/transport/serializers/json-serializer";
import { Result } from "better-result";
import { NexusEndpointConnectError } from "../errors/transport-errors";

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
  config?: ConnectionManagerConfig<TestAdapterModel>,
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
): Promise<void> => manager.safeInitialize().then((result) => result.unwrap());

const resolveManager = <M extends AdapterModel>(
  manager: ConnectionManager<M>,
  options: ResolveOptions<M>,
) => manager.safeResolveConnection(options).then((result) => result.unwrap());

const resolveManagerCandidates = <M extends AdapterModel>(
  manager: ConnectionManager<M>,
  options: ResolveOptions<M>,
) => manager.safeResolveConnections(options).then((result) => result.unwrap());

const sendFromManager = <M extends AdapterModel>(
  manager: ConnectionManager<M>,
  target: MessageTarget<M>,
  message: NexusMessage,
): string[] => manager.safeSendMessage(target, message).unwrap();

const updateManagerIdentity = <M extends AdapterModel>(
  manager: ConnectionManager<M>,
  updates: Partial<M["contextMeta"]>,
): void => manager.safeUpdateLocalIdentity(updates).unwrap();

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
    for (const connection of hostManager.connections.values())
      connection.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe("Connection Establishment (B1)", () => {
    it("reclaims a processor if copying adapter metadata fails during attachment", async () => {
      const close = vi.fn();
      mockHostEndpoint.connect = async () => ({
        port: {
          postMessage: vi.fn(),
          onMessage: vi.fn(),
          onDisconnect: vi.fn(),
          close,
        },
        connectionMeta: {
          get from(): string {
            throw new Error("metadata failed");
          },
        },
      });
      await initializeManager(hostManager);
      const result = await hostManager.safeResolveConnection({
        target: clientMeta,
      });
      expect(result).toMatchObject({ error: { code: "E_UNKNOWN" } });
      expect(close).toHaveBeenCalledOnce();
      expect(hostManager.connections.size).toBe(0);
    });

    it("settles a startup close immediately even when protocol readiness already has identity", async () => {
      vi.useFakeTimers();
      const manager = new ConnectionManager(
        { handshakeTimeoutMs: 1000 },
        Transport.create(mockHostEndpoint),
        mockHostHandlers,
        hostMeta,
      );
      await initializeManager(manager);
      let receive!: (packet: string) => void;
      let disconnected!: () => void;
      let readySent = false;
      const port: IPort = {
        onMessage: (handler) => {
          receive = handler;
        },
        onDisconnect: (handler) => {
          disconnected = handler;
        },
        close: () => disconnected(),
        postMessage: (packet) => {
          const message = JsonSerializer.safeDeserialize(packet);
          if (message.isErr()) throw message.error;
          if (message.value.type === NexusMessageType.HANDSHAKE_REQ) {
            const ack = JsonSerializer.safeSerialize({
              type: NexusMessageType.HANDSHAKE_ACK,
              id: message.value.id,
              metadata: clientMeta,
              capabilities: ["provider-catalog-v1"],
              providers: [],
            });
            if (ack.isErr()) throw ack.error;
            receive(ack.value);
          } else if (message.value.type === NexusMessageType.HANDSHAKE_READY) {
            readySent = true;
            queueMicrotask(disconnected);
          }
        },
      };
      mockHostEndpoint.connect = async () => ({
        port,
        connectionMeta: { from: "client" },
      });
      const connecting = manager.safeResolveConnection({ target: clientMeta });
      await vi.advanceTimersByTimeAsync(0);
      expect(readySent).toBe(true);
      expect(await connecting).toMatchObject({
        error: { code: "E_HANDSHAKE_FAILED" },
      });
      expect(manager.connections.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("releases a failed coalesced dial so the next acquisition can retry", async () => {
      let fail!: (error: Error) => void;
      const connect = vi.fn(
        () =>
          new Promise<{ port: IPort; connectionMeta: TestConnectionMeta }>(
            (_resolve, reject) => {
              fail = reject;
            },
          ),
      );
      const manager = new ConnectionManager(
        {},
        Transport.create({
          listen: () => undefined,
          connect,
        } as IEndpoint<TestAdapterModel>),
        mockHostHandlers,
        hostMeta,
      );
      await initializeManager(manager);
      const first = manager.safeResolveConnections({ target: clientMeta });
      const second = manager.safeResolveConnections({ target: clientMeta });
      expect(connect).toHaveBeenCalledOnce();
      fail(new Error("native dial failed"));
      for (const result of await Promise.all([first, second])) {
        expect(result).toMatchObject({
          error: { code: "E_ENDPOINT_CONNECT_FAILED" },
        });
      }
      const retry = manager.safeResolveConnections({ target: clientMeta });
      expect(connect).toHaveBeenCalledTimes(2);
      fail(new Error("retry failed"));
      expect(await retry).toMatchObject({
        error: { code: "E_ENDPOINT_CONNECT_FAILED" },
      });
    });

    it("settles a pending dial timeout and closes a late port without handshaking", async () => {
      vi.useFakeTimers();
      let finishDial!: (value: {
        port: IPort;
        connectionMeta: TestConnectionMeta;
      }) => void;
      const endpoint: IEndpoint<TestAdapterModel> = {
        listen: vi.fn(),
        connect: () =>
          new Promise((resolve) => {
            finishDial = resolve;
          }),
      };
      const manager = new ConnectionManager(
        { handshakeTimeoutMs: 10 },
        Transport.create(endpoint),
        mockHostHandlers,
        hostMeta,
      );
      await initializeManager(manager);
      const resolved = vi.fn();
      const connecting = manager
        .safeResolveConnection({ target: clientMeta })
        .then((result) => {
          resolved(result);
          return result;
        });
      await vi.advanceTimersByTimeAsync(10);
      expect(resolved).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: "E_HANDSHAKE_FAILED" }),
        }),
      );
      const port = {
        postMessage: vi.fn(),
        onMessage: vi.fn(),
        onDisconnect: vi.fn(),
        close: vi.fn(),
      };
      finishDial({ port, connectionMeta: { from: "late" } });
      await vi.advanceTimersByTimeAsync(0);
      await connecting;
      expect(port.close).toHaveBeenCalledOnce();
      expect(port.postMessage).not.toHaveBeenCalled();
      expect(manager.connections.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["incoming", "outgoing"] as const)(
      "submits %s startup messages before messages arriving during authorization",
      async (direction) => {
        let receive!: (packet: string) => void;
        const deliver = (
          message: Parameters<typeof JsonSerializer.safeSerialize>[0],
        ) => {
          const packet = JsonSerializer.safeSerialize(message);
          if (packet.isErr()) throw packet.error;
          receive(packet.value as string);
        };
        const verified: number[] = [];
        const canConnect = vi.fn(
          ({ remoteIdentity }: { remoteIdentity: TestUserMeta }) => {
            verified.push(remoteIdentity.id);
            if (remoteIdentity.id === 2)
              deliver({
                type: NexusMessageType.IDENTITY_UPDATE,
                id: null,
                updates: { id: 4 },
              });
            return true;
          },
        );
        const manager = new ConnectionManager(
          { policy: { canConnect } },
          Transport.create(mockHostEndpoint),
          mockHostHandlers,
          hostMeta,
        );
        await initializeManager(manager);
        const port: IPort = {
          postMessage: vi.fn(),
          close: vi.fn(),
          onDisconnect: vi.fn(),
          onMessage: (handler) => {
            receive = handler;
            deliver({
              type: NexusMessageType.HANDSHAKE_REQ,
              id: 7,
              metadata: clientMeta,
              capabilities: ["provider-catalog-v1"],
            });
            deliver({
              type: NexusMessageType.HANDSHAKE_READY,
              id: 7,
              capabilities: ["provider-catalog-v1"],
              providers: [],
            });
            deliver({
              type: NexusMessageType.IDENTITY_UPDATE,
              id: null,
              updates: { id: 3 },
            });
          },
        };
        const connectionMeta = { from: "client" };
        if (direction === "incoming") hostL1OnConnect(port, connectionMeta);
        else {
          mockHostEndpoint.connect = async () => ({ port, connectionMeta });
          const connected = await manager.safeResolveConnection({
            target: clientMeta,
          });
          expect(connected.isOk()).toBe(true);
        }
        await vi.waitFor(() => expect(verified).toEqual([2, 3, 4]));
        expect([...manager.connections.values()][0].remoteIdentity?.id).toBe(4);
        for (const connection of manager.connections.values())
          connection.close();
      },
    );

    it("does not publish either peer while authorization is pending or denied", async () => {
      let resolvePolicy!: (allowed: boolean) => void;
      const canConnect = vi.fn(
        () => new Promise<boolean>((resolve) => (resolvePolicy = resolve)),
      );
      hostManager = new ConnectionManager(
        {
          policy: {
            canConnect,
          },
        },
        Transport.create(mockHostEndpoint),
        mockHostHandlers,
        hostMeta,
      );
      await initializeManager(hostManager);
      const { manager: clientManager } = await createTestStack(
        { ...clientMeta, groups: ["group-denied"] },
        hostL1OnConnect,
      );

      const resolution = clientManager.safeResolveConnection({
        target: hostMeta,
      });
      await vi.waitFor(() => expect(canConnect).toHaveBeenCalled());
      await vi.waitFor(() => {
        expect(hostManager.connections.size).toBe(0);
      });
      expect(clientManager.connections.size).toBe(0);

      resolvePolicy(false);

      await expect(resolution).resolves.toMatchObject({
        error: { code: "E_HANDSHAKE_REJECTED" },
      });
      expect(hostManager.connections.size).toBe(0);
      expect(clientManager.connections.size).toBe(0);
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
        { handshakeTimeoutMs: 10 },
        Transport.create(clientEndpoint),
        mockHostHandlers,
        clientMeta,
      );
      await initializeManager(clientManager);

      await expect(
        clientManager.safeResolveConnection({ target: hostMeta }),
      ).resolves.toMatchObject({ error: { code: "E_HANDSHAKE_FAILED" } });
    });

    it("should clean up an incoming connection when the handshake request never arrives", async () => {
      const [, hostPort] = createMockPortPair();
      hostManager = new ConnectionManager(
        { handshakeTimeoutMs: 10 },
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
    it("settles all initialization callers when listener lookup rejects and permits retry", async () => {
      const failure = new Error("listener getter failed");
      const listen = vi.fn();
      let failLookup = true;
      Object.defineProperty(mockHostEndpoint, "listen", {
        configurable: true,
        get: () => {
          if (failLookup) throw failure;
          return listen;
        },
      });
      const results = await Promise.all([
        hostManager.safeInitialize(),
        hostManager.safeInitialize(),
      ]);
      for (const result of results) {
        expect(result).toMatchObject({
          error: { code: "E_UNKNOWN", cause: { message: failure.message } },
        });
      }
      expect(listen).not.toHaveBeenCalled();
      failLookup = false;
      expect((await hostManager.safeInitialize()).isOk()).toBe(true);
      expect(listen).toHaveBeenCalledOnce();
    });

    it("releases the reserved target when setup throws before acquisition", async () => {
      let failSetup = true;
      const manager = new ConnectionManager(
        {
          get handshakeTimeoutMs() {
            if (failSetup) throw new Error("configuration getter failed");
            return 100;
          },
        },
        Transport.create(mockHostEndpoint),
        mockHostHandlers,
        hostMeta,
      );
      mockHostEndpoint.connect = vi.fn(async () => {
        throw new Error("native failed");
      });
      await initializeManager(manager);
      expect(
        await manager.safeResolveConnections({ target: clientMeta }),
      ).toMatchObject({ error: { code: "E_UNKNOWN" } });
      expect(mockHostEndpoint.connect).not.toHaveBeenCalled();
      failSetup = false;
      expect(
        await manager.safeResolveConnections({ target: clientMeta }),
      ).toMatchObject({ error: { code: "E_ENDPOINT_CONNECT_FAILED" } });
      expect(mockHostEndpoint.connect).toHaveBeenCalledOnce();
    });

    it("shares initialization even when listen synchronously reenters", async () => {
      let reentrant: ReturnType<typeof hostManager.safeInitialize> | undefined;
      let reentered = false;
      mockHostEndpoint.listen = vi.fn(() => {
        if (!reentered) {
          reentered = true;
          reentrant = hostManager.safeInitialize();
        }
      });
      const first = hostManager.safeInitialize();
      expect(mockHostEndpoint.listen).toHaveBeenCalledOnce();
      expect((await first).isOk()).toBe(true);
      expect(await reentrant).toBe(await first);
    });

    it("reserves a target before connect synchronously reenters acquisition", async () => {
      const failure = new NexusEndpointConnectError("native dial failed", {
        target: clientMeta,
      });
      let reentrant:
        | ReturnType<typeof hostManager.safeResolveConnections>
        | undefined;
      let reentered = false;
      mockHostEndpoint.connect = vi.fn(() => {
        if (!reentered) {
          reentered = true;
          reentrant = hostManager.safeResolveConnections({
            target: clientMeta,
          });
        }
        return Promise.reject(failure);
      });
      await initializeManager(hostManager);
      const first = hostManager.safeResolveConnections({ target: clientMeta });
      expect(mockHostEndpoint.connect).toHaveBeenCalledOnce();
      for (const result of await Promise.all([first, reentrant!])) {
        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error).toBe(failure);
      }
      await hostManager.safeResolveConnections({ target: clientMeta });
      expect(mockHostEndpoint.connect).toHaveBeenCalledTimes(2);
    });

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
      const result = await first;
      expect(result).toEqual(Result.ok(undefined));
      expect(await second).toBe(result);
      expect(await hostManager.safeInitialize()).toBe(result);
      expect(mockHostEndpoint.listen).toHaveBeenCalledTimes(1);
    });

    it("should convert async listener startup rejection to an error result and allow retry", async () => {
      const listenError = new Error("listen failed");
      mockHostEndpoint.listen = vi
        .fn()
        .mockRejectedValueOnce(listenError)
        .mockResolvedValueOnce(undefined);

      const failed = await hostManager.safeInitialize();

      expect(failed).toMatchObject({
        error: {
          name: "NexusEndpointListenError",
          code: "E_ENDPOINT_LISTEN_FAILED",
          context: { originalError: listenError },
        },
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

    it("shares acquisition but evaluates each caller's constraint independently", async () => {
      await initializeManager(hostManager);
      const client = await createTestStack(clientMeta, hostL1OnConnect);
      const [denied, accepted] = await Promise.all([
        client.manager.safeResolveConnections({
          target: hostMeta,
          where: () => false,
        }),
        client.manager.safeResolveConnections({
          target: hostMeta,
          where: () => true,
        }),
      ]);
      expect(denied).toMatchObject({
        error: { code: "E_CONNECTION_CONSTRAINT_FAILED" },
      });
      expect(accepted.isOk()).toBe(true);
      if (accepted.isOk())
        expect(accepted.value[0].remoteIdentity).toEqual(hostMeta);
      expect(client.mockEndpoint.connect).toHaveBeenCalledOnce();
      expect(client.manager.connections.size).toBe(1);
    });
  });

  describe("Provider Selection and Metadata Routing (B3)", () => {
    it("selects and sends by where without dialing, and contains predicate failures", async () => {
      const message: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 1,
        resourceId: null,
        path: [],
        args: [],
      };
      const where = vi.fn(
        (identity: TestUserMeta) => identity.id === clientMeta.id,
      );
      expect(hostManager.safeGetReadyConnectionIds({ where })).toMatchObject({
        error: { code: "E_USAGE_INVALID" },
      });
      expect(await hostManager.safeResolveConnection({})).toMatchObject({
        error: { code: "E_USAGE_INVALID" },
      });
      expect(hostManager.safeUpdateLocalIdentity({ id: 5 })).toMatchObject({
        error: { code: "E_USAGE_INVALID" },
      });
      expect(where).not.toHaveBeenCalled();
      await initializeManager(hostManager);
      const client = await createTestStack(clientMeta, hostL1OnConnect);
      await resolveManager(client.manager, { target: hostMeta });
      const [connection] = hostManager.connections.values();
      expect(await hostManager.safeResolveConnection({})).toEqual(
        Result.ok(null),
      );
      expect(hostManager.safeGetReadyConnectionIds({ where })).toEqual(
        Result.ok([connection.connectionId]),
      );
      expect(hostManager.safeSendMessage({ where }, message)).toEqual(
        Result.ok([connection.connectionId]),
      );
      await vi.waitFor(() =>
        expect(client.handlers.onMessage).toHaveBeenCalledWith(
          message,
          expect.any(String),
        ),
      );
      where.mockImplementation(() => {
        throw new Error("predicate failed");
      });
      expect(hostManager.safeGetReadyConnectionIds({ where })).toMatchObject({
        error: { code: "E_UNKNOWN" },
      });
      expect(hostManager.safeSendMessage({ where }, message)).toMatchObject({
        error: { code: "E_UNKNOWN" },
      });
      expect(mockHostEndpoint.connect).not.toHaveBeenCalled();
    });

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

    it("exposes a connection snapshot that cannot mutate manager internals", async () => {
      await initializeManager(hostManager);
      const client = await createTestStack(
        { ...clientMeta, groups: ["group-1"] },
        hostL1OnConnect,
      );

      await resolveManager(client.manager, { target: hostMeta });

      await vi.waitFor(() => {
        expect(hostManager.connections.size).toBe(1);
      });
      const connectionsSnapshot = hostManager.connections as Map<string, any>;
      connectionsSnapshot.clear();

      expect(hostManager.connections.size).toBe(1);
    });

    it("routes messages through observable group metadata predicates", async () => {
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

      // Find the published sessions for explicit-recipient order coverage below.
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
      });

      // Arrange: Create a valid test message to check routing
      const testMessage: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 1,
        resourceId: null, // This can be null for global/static methods
        path: ["testEvent"], // The "path" can represent the event name
        args: [{ value: 42 }], // The payload can be in the args
      };

      // Act & Assert: Send to group-1 metadata, both clients should receive it.
      sendFromManager(
        hostManager,
        { where: (identity) => identity.groups?.includes("group-1") ?? false },
        testMessage,
      );
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

      // Act & Assert: Send to group-2 metadata, only client B should receive it.
      sendFromManager(
        hostManager,
        { where: (identity) => identity.groups?.includes("group-2") ?? false },
        testMessage,
      );
      await vi.waitFor(() => {
        expect(clientB.handlers.onMessage).toHaveBeenCalledWith(
          testMessage,
          expect.any(String),
        );
      });
      expect(clientA.handlers.onMessage).not.toHaveBeenCalled();

      // Explicit recipients preserve duplicates and recheck later recipients
      // after each send, rather than taking a prefiltered snapshot.
      const connectionA = hostManager.connections.get(clientAConnId!)!;
      const connectionB = hostManager.connections.get(clientBConnId!)!;
      const sentTo: string[] = [];
      const sendA = vi
        .spyOn(connectionA, "sendMessage")
        .mockImplementation(() => {
          sentTo.push(connectionA.connectionId);
          return Result.ok(undefined);
        });
      const sendB = vi
        .spyOn(connectionB, "sendMessage")
        .mockImplementation(() => {
          sentTo.push(connectionB.connectionId);
          return Result.ok(undefined);
        });
      const connectionIds = [clientBConnId!, clientAConnId!, clientBConnId!];
      expect(
        hostManager.safeSendMessage({ connectionIds }, testMessage),
      ).toEqual(Result.ok(connectionIds));
      expect(sentTo).toEqual(connectionIds);
      sentTo.length = 0;
      sendB.mockImplementationOnce(() => {
        sentTo.push(connectionB.connectionId);
        connectionA.close();
        return Result.ok(undefined);
      });
      expect(
        hostManager.safeSendMessage({ connectionIds }, testMessage),
      ).toMatchObject({
        value: [connectionB.connectionId, connectionB.connectionId],
      });
      expect(sentTo).toEqual([
        connectionB.connectionId,
        connectionB.connectionId,
      ]);
      sendA.mockRestore();
      sendB.mockRestore();
    });
  });

  describe("Connection Disconnect and Cleanup (B4)", () => {
    it.each(["queries", "identity broadcast"])(
      "excludes a closing session from reentrant %s before native cleanup returns",
      async (operation) => {
        await initializeManager(hostManager);
        let hostPort!: IPort;
        const client = await createTestStack(clientMeta, (port, meta) => {
          hostPort = port;
          hostL1OnConnect(port, meta);
        });
        client.manager.safePublishProviders(["service"]);
        await resolveManager(client.manager, { target: hostMeta });
        const connection = [...hostManager.connections.values()][0];
        const closePort = vi.mocked(hostPort.close).getMockImplementation()!;
        const observed: unknown[] = [];
        vi.spyOn(hostPort, "close").mockImplementation(() => {
          // Conn is already terminal, but Manager's onClosed has not run yet.
          if (operation === "queries")
            observed.push(hostManager.getReadyProviderConnectionIds("service"));
          else observed.push(hostManager.safeUpdateLocalIdentity({ id: 100 }));
          closePort();
        });
        connection.close();
        expect(observed).toEqual([
          operation === "queries" ? [] : Result.ok(undefined),
        ]);
        expect(hostManager.connections.size).toBe(0);
      },
    );

    it("closes a failed sender, preserves its cause and stops before later recipients", async () => {
      await initializeManager(hostManager);
      const ports: IPort[] = [];
      const accept = (port: IPort, meta?: TestConnectionMeta) => {
        ports.push(port);
        hostL1OnConnect(port, meta);
      };
      const first = await createTestStack(clientMeta, accept);
      const second = await createTestStack({ ...clientMeta, id: 3 }, accept);
      await resolveManager(first.manager, { target: hostMeta });
      await resolveManager(second.manager, { target: hostMeta });
      const [a, b] = [...hostManager.connections.values()];
      const sendError = new Error("native port failure");
      const postA = vi.spyOn(ports[0], "postMessage").mockImplementation(() => {
        throw sendError;
      });
      const postB = vi.spyOn(ports[1], "postMessage");
      postA.mockClear();
      postB.mockClear();

      const result = hostManager.safeSendMessage(
        { connectionIds: [b.connectionId, a.connectionId, b.connectionId] },
        {
          type: NexusMessageType.APPLY,
          id: 1,
          resourceId: null,
          path: [],
          args: [],
        },
      );

      expect(result).toMatchObject({
        error: {
          code: "E_CONN_CLOSED",
          cause: {
            code: "E_PROTOCOL_ERROR",
            message: expect.stringContaining(sendError.message),
          },
          context: { connectionId: a.connectionId },
        },
      });
      expect(postA).toHaveBeenCalledOnce();
      expect(postB).toHaveBeenCalledOnce();
      expect(a.isReady()).toBe(false);
      expect(b.isReady()).toBe(true);
      expect(hostManager.connections.has(a.connectionId)).toBe(false);
      expect(mockHostHandlers.onDisconnect).toHaveBeenCalledExactlyOnceWith(
        a.connectionId,
        clientMeta,
      );
      b.close();
    });

    it("settles an outgoing queued-publication failure without waiting for the handshake timeout", async () => {
      await initializeManager(hostManager);
      const client = await createTestStack(clientMeta, hostL1OnConnect);
      await resolveManager(client.manager, { target: hostMeta });
      const [survivor] = hostManager.connections.values();
      const target = { context: "failing", id: 4 };
      let receive!: (packet: string) => void;
      let requested!: (acknowledge: () => void) => void;
      const request = new Promise<() => void>((resolve) => {
        requested = resolve;
      });
      const close = vi.fn();
      mockHostEndpoint.connect = async () => ({
        connectionMeta: { from: "peer" },
        port: {
          onMessage: (handler) => {
            receive = handler;
          },
          onDisconnect: vi.fn(),
          close,
          postMessage: (packet) => {
            const message = JsonSerializer.safeDeserialize(packet).unwrap();
            if (message.type === NexusMessageType.HANDSHAKE_REQ)
              requested(() =>
                receive(
                  JsonSerializer.safeSerialize({
                    type: NexusMessageType.HANDSHAKE_ACK,
                    id: message.id,
                    metadata: target,
                    capabilities: ["provider-catalog-v1"],
                    providers: [],
                  }).unwrap(),
                ),
              );
            if (message.type === NexusMessageType.PROVIDER_AVAILABLE)
              throw new Error("queued provider publication failed");
          },
        },
      });
      vi.useFakeTimers();
      const opening = hostManager.safeResolveConnection({ target });
      const acknowledge = await request;
      expect(hostManager.safePublishProviders(["service.queued"])).toEqual(
        Result.ok(undefined),
      );
      acknowledge();
      await vi.advanceTimersByTimeAsync(0);
      expect(await opening).toMatchObject({
        error: { code: "E_HANDSHAKE_FAILED" },
      });
      expect(close).toHaveBeenCalledOnce();
      expect([...hostManager.connections.values()]).toEqual([survivor]);
      expect(survivor.isReady()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
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

  describe("Startup and exact acquisition", () => {
    it("returns Err rather than rejecting when an adapter key throws an unprintable value", async () => {
      mockHostEndpoint.targetKey = () => {
        throw Object.create(null);
      };
      await initializeManager(hostManager);
      expect(
        await hostManager.safeResolveConnections({ target: clientMeta }),
      ).toMatchObject({
        error: {
          code: "E_UNKNOWN",
          context: { options: { target: clientMeta } },
        },
      });
      expect(mockHostEndpoint.connect).not.toHaveBeenCalled();
    });

    it("establishes configured startup connections only once", async () => {
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

      const connection = await resolveManager(clientManager, {
        target: hostMeta,
      });
      expect(connection?.isReady()).toBe(true);
      expect(mockEndpoint.connect).toHaveBeenCalledOnce();
      expect([...hostManager.connections.values()]).toHaveLength(1);
      expect([...clientManager.connections.values()]).toHaveLength(1);
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
        clientA.manager.safeResolveConnection({ target: hostMeta, where }),
      ).resolves.toMatchObject({
        error: { code: "E_CONNECTION_CONSTRAINT_FAILED" },
      });
      expect(clientA.mockEndpoint.connect).not.toHaveBeenCalled();
    });

    it("should create from a target and apply where after the handshake", async () => {
      // Arrange: Set up host
      await initializeManager(hostManager);
      const clientA = await createTestStack(clientMeta, hostL1OnConnect);

      // Act 1: A target can create a connection, but where still filters its peer identity
      const where = (identity: TestUserMeta) => identity.id === 999;
      await expect(
        clientA.manager.safeResolveConnections({
          where,
          target: hostMeta,
        }),
      ).resolves.toMatchObject({
        error: { code: "E_CONNECTION_CONSTRAINT_FAILED" },
      });

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

    it("orders published connections independently of attachment and isolates observers", async () => {
      let finishFirst!: (allowed: boolean) => void;
      let entered!: () => void;
      const enteredPolicy = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const manager = new ConnectionManager<TestAdapterModel>(
        {
          policy: {
            canConnect: ({ remoteIdentity }) => {
              if (remoteIdentity.id !== 10) return true;
              entered();
              return new Promise<boolean>((resolve) => {
                finishFirst = resolve;
              });
            },
          },
        },
        Transport.create(mockHostEndpoint),
        mockHostHandlers,
        hostMeta,
      );
      const observed: number[][] = [];
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const stopThrowing = manager.subscribeAvailabilityChanged(() => {
        throw new Error("observer failed");
      });
      const stopObserving = manager.subscribeAvailabilityChanged(() => {
        observed.push(
          [...manager.connections.values()].map(
            (connection) => connection.remoteIdentity!.id,
          ),
        );
      });
      try {
        await initializeManager(manager);
        const first = await createTestStack(
          { context: "client", id: 10 },
          hostL1OnConnect,
        );
        const second = await createTestStack(
          { context: "client", id: 20 },
          hostL1OnConnect,
        );
        const pendingFirst = resolveManager(first.manager, {
          target: hostMeta,
        });
        await enteredPolicy;
        await resolveManager(second.manager, { target: hostMeta });
        expect(
          [...manager.connections.values()].map((c) => c.remoteIdentity!.id),
        ).toEqual([20]);
        finishFirst(true);
        await pendingFirst;
        expect(
          (await resolveManagerCandidates(manager, {})).map(
            (c) => c.remoteIdentity!.id,
          ),
        ).toEqual([20, 10]);
        expect(observed).toContainEqual([20, 10]);
        for (const connection of manager.connections.values())
          connection.close();
        expect(manager.connections.size).toBe(0);
      } finally {
        stopThrowing();
        stopObserving();
        log.mockRestore();
      }
    });

    it("does not actively connect when broadcasting a ready snapshot", async () => {
      await initializeManager(hostManager);
      const where = (identity: TestUserMeta) => identity.context === "client";

      const matches = await resolveManagerCandidates(hostManager, { where });

      expect(matches).toEqual([]);
      expect(mockHostEndpoint.connect).not.toHaveBeenCalled();
    });
  });

  describe("Dynamic Identity Update (B6)", () => {
    it("publishes updated metadata before identity callbacks and removes it before reentrant disconnect observers", async () => {
      await initializeManager(hostManager);
      const client = await createTestStack(
        { ...clientMeta, groups: ["old"] },
        hostL1OnConnect,
      );
      await resolveManager(client.manager, { target: hostMeta });
      const connection = [...hostManager.connections.values()][0];
      const changes: number[] = [];
      const unsubscribe = hostManager.subscribeAvailabilityChanged(() => {
        changes.push(hostManager.connections.size);
      });
      let disconnected!: () => void;
      const closed = new Promise<void>((resolve) => {
        disconnected = resolve;
      });
      mockHostHandlers.onDisconnect = vi.fn((id, identity) => {
        expect(id).toBe(connection.connectionId);
        expect(identity).toEqual({ ...clientMeta, groups: ["new"] });
        expect(hostManager.connections.size).toBe(0);
        expect(hostManager.getConnectionAuthSnapshot(id)).toBeUndefined();
        connection.close();
        disconnected();
        throw new Error("disconnect observer failed");
      });
      mockHostHandlers.onIdentityUpdated = vi.fn((id, next, previous, meta) => {
        expect(
          hostManager.getConnectionAuthSnapshot(id)?.remoteIdentity,
        ).toEqual(next);
        expect(previous.groups).toEqual(["old"]);
        expect(meta).toBe(connection.context.connection);
        connection.close();
      });
      try {
        expect(
          client.manager.safeUpdateLocalIdentity({ groups: ["new"] }).isOk(),
        ).toBe(true);
        await closed;
        expect(mockHostHandlers.onIdentityUpdated).toHaveBeenCalledOnce();
        expect(mockHostHandlers.onDisconnect).toHaveBeenCalledOnce();
        expect(changes.at(-1)).toBe(0);
      } finally {
        unsubscribe();
        connection.close();
      }
    });

    it("updates every local authorization snapshot before a reentrant failing broadcast", async () => {
      await initializeManager(hostManager);
      const first = await createTestStack(
        { context: "client", id: 10 },
        hostL1OnConnect,
      );
      const second = await createTestStack(
        { context: "client", id: 20 },
        hostL1OnConnect,
      );
      await resolveManager(first.manager, { target: hostMeta });
      await resolveManager(second.manager, { target: hostMeta });
      const [a, b] = [...hostManager.connections.values()];
      const sendA = vi.spyOn(a, "sendMessage").mockImplementation(() => {
        expect(
          hostManager.getConnectionAuthSnapshot(a.connectionId)?.localIdentity
            .id,
        ).toBe(777);
        expect(
          hostManager.getConnectionAuthSnapshot(b.connectionId)?.localIdentity
            .id,
        ).toBe(777);
        return Result.err(new Error("broadcast failed"));
      });
      const sendB = vi.spyOn(b, "sendMessage");
      expect(hostManager.safeUpdateLocalIdentity({ id: 777 })).toMatchObject({
        error: { code: "E_UNKNOWN" },
      });
      expect(sendA).toHaveBeenCalledOnce();
      expect(sendB).not.toHaveBeenCalled();
      expect(b.localIdentity.id).toBe(777);
      sendA.mockRestore();
      sendB.mockRestore();
    });

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

    it("routes by updated group metadata after identity update", async () => {
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

      const testMessage: ApplyMessage = {
        type: NexusMessageType.APPLY,
        id: 1,
        resourceId: null,
        path: ["testEvent"],
        args: [],
      };

      // Assert: Client is initially matched by group-1 metadata.
      const inGroup = (group: string) => (identity: TestUserMeta) =>
        identity.groups?.includes(group) ?? false;
      sendFromManager(hostManager, { where: inGroup("group-1") }, testMessage);
      await vi.waitFor(() => {
        expect(client.handlers.onMessage).toHaveBeenCalledTimes(1);
      });
      vi.clearAllMocks();

      // Act: The client updates its identity to join 'group-2' and leave 'group-1'
      const clientUpdates: Partial<TestUserMeta> = {
        groups: ["group-2"],
      };
      updateManagerIdentity(client.manager, clientUpdates);

      await vi.waitFor(async () => {
        expect(
          await resolveManagerCandidates(hostManager, {
            where: inGroup("group-2"),
          }),
        ).toHaveLength(1);
        expect(
          [...hostManager.connections.values()][0].remoteIdentity?.groups,
        ).toEqual(["group-2"]);
      });

      // Assert: Host routes messages to the new group after propagation.
      sendFromManager(hostManager, { where: inGroup("group-2") }, testMessage);
      await vi.waitFor(() => {
        expect(client.handlers.onMessage).toHaveBeenCalledTimes(1);
      });

      vi.clearAllMocks();

      // The old metadata predicate no longer matches.
      expect(
        sendFromManager(
          hostManager,
          { where: inGroup("group-1") },
          testMessage,
        ),
      ).toEqual([]);
      expect(client.handlers.onMessage).not.toHaveBeenCalled();
    });
  });
});
