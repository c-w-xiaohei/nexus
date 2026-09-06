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
import { NexusProtocolError } from "@/errors/transport-errors";
import { Result } from "better-result";
import type { ConnectionAuthContext } from "@/api/types/config";
import type { AdapterModel } from "@/types/adapter-model";
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
interface TestConnectionMeta {
  from: string;
}

interface TestAdapterModel extends AdapterModel {
  contextMeta: TestUserMeta;
  connectionMeta: TestConnectionMeta;
  connectionTarget: TestUserMeta;
}

describe("LogicalConnection", () => {
  // Test Data
  const clientMeta: TestUserMeta = { context: "client", id: 2 };
  const hostMeta: TestUserMeta = { context: "host", id: 1 };
  const clientConnectionMeta: TestConnectionMeta = { from: "client" };
  const hostConnectionMeta: TestConnectionMeta = { from: "host" };

  // Mocks and Instances
  let clientConnection: LogicalConnection<TestAdapterModel>;
  let hostConnection: LogicalConnection<TestAdapterModel>;
  let mockClientHandlers: LogicalConnectionHandlers<TestAdapterModel>;
  let mockHostHandlers: LogicalConnectionHandlers<TestAdapterModel>;

  beforeEach(() => {
    hostConnectionMeta.from = "host";
    const [clientPort, hostPort] = createMockPortPair();
    const serializer = JsonSerializer.serializer;
    let messageId = 1;
    const nextMessageId = () => messageId++;

    // Mock handlers for both sides
    mockClientHandlers = {
      onAttached: vi.fn(() => Result.ok(undefined)),
      onReady: vi.fn(() => Result.ok(undefined)),
      onClosed: vi.fn(),
      onMessage: vi.fn(),
      onIdentityUpdated: vi.fn(),
      authorize: vi.fn().mockResolvedValue(true),
    };
    mockHostHandlers = {
      onAttached: vi.fn(() => Result.ok(undefined)),
      onReady: vi.fn(() => Result.ok(undefined)),
      onClosed: vi.fn(),
      onMessage: vi.fn(),
      onIdentityUpdated: vi.fn(),
      authorize: vi.fn(),
    };

    // To simulate a real scenario, PortProcessors listen to each other
    const clientPortProcessor = PortProcessor.create(
      clientPort,
      serializer,
      {
        onLogicalMessage: (msg: NexusMessage) =>
          clientConnection.safeHandleMessage(msg).then((result) => {
            if (result.isErr()) return Promise.reject(result.error);
          }),
        onDisconnect: () => clientConnection.handleDisconnect(),
      },
      { chunkSize: Infinity },
    );

    const hostPortProcessor = PortProcessor.create(
      hostPort,
      serializer,
      {
        onLogicalMessage: (msg: NexusMessage) =>
          hostConnection.safeHandleMessage(msg).then((result) => {
            if (result.isErr()) return Promise.reject(result.error);
          }),
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
        localEndpointMeta: clientMeta,
        connectionMeta: hostConnectionMeta, // Client gets host's connection meta
        direction: "outgoing",
        nextMessageId,
      },
    );

    hostConnection = new LogicalConnection(
      hostPortProcessor,
      mockHostHandlers,
      {
        connectionId: "conn-host",
        localEndpointMeta: hostMeta,
        connectionMeta: clientConnectionMeta, // Host gets client's connection meta
        direction: "incoming",
        nextMessageId,
      },
    );
  });

  afterEach(() => {
    clientConnection.close();
    hostConnection.close();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("preserves the configured connection direction", () => {
    expect(clientConnection.direction).toBe("outgoing");
    expect(hostConnection.direction).toBe("incoming");
  });

  it.each(["REQ", "ACK", "READY"] as const)(
    "closes on a failed %s send without publishing or sending later packets",
    async (packet) => {
      const failure = new NexusProtocolError("control send failed");
      const sendMessage = vi.fn((message: NexusMessage) =>
        message.type === NexusMessageType[`HANDSHAKE_${packet}`]
          ? Result.err(failure)
          : Result.ok(undefined),
      );
      const close = vi.fn(() => Result.ok(undefined));
      const connection = new LogicalConnection<TestAdapterModel>(
        { sendMessage, close },
        mockClientHandlers,
        {
          connectionId: "control-failure",
          direction: packet === "ACK" ? "incoming" : "outgoing",
          localEndpointMeta: clientMeta,
          connectionMeta: hostConnectionMeta,
          nextMessageId: () => 1,
        },
      );
      if (packet === "REQ") {
        const started = connection.initiateHandshake();
        expect(started.isErr()).toBe(true);
        if (started.isErr()) expect(started.error).toBe(failure);
      } else {
        if (packet === "READY") connection.initiateHandshake();
        expect(
          await connection.safeHandleMessage({
            type:
              packet === "ACK"
                ? NexusMessageType.HANDSHAKE_REQ
                : NexusMessageType.HANDSHAKE_ACK,
            id: 1,
            metadata: hostMeta,
            capabilities: ["provider-catalog-v1"],
          }),
        ).toEqual(Result.ok(undefined));
      }
      expect(connection.isReady()).toBe(false);
      expect(close).toHaveBeenCalledOnce();
      expect(mockClientHandlers.onClosed).toHaveBeenCalledOnce();
      expect(mockClientHandlers.onReady).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(packet === "READY" ? 2 : 1);
    },
  );

  it("settles opening if an attachment observer immediately closes the session", async () => {
    const closed = vi.fn(() => Result.ok(undefined));
    const sent = vi.fn(() => Result.ok(undefined));
    mockClientHandlers.onAttached = (connection) => {
      connection.close();
      return Result.ok(undefined);
    };
    const result = await LogicalConnection.open<TestAdapterModel>(
      {
        connectionId: "closed-on-attach",
        direction: "outgoing",
        localIdentity: () => clientMeta,
        nextMessageId: () => 1,
        timeoutMs: 1000,
        acquire: () =>
          Result.ok({
            portProcessor: { close: closed, sendMessage: sent },
            connectionMeta: hostConnectionMeta,
          }),
      },
      mockClientHandlers,
    );
    expect(result).toMatchObject({ error: { code: "E_HANDSHAKE_FAILED" } });
    expect(closed).toHaveBeenCalledOnce();
    expect(sent).not.toHaveBeenCalled();
    expect(mockClientHandlers.onClosed).toHaveBeenCalledOnce();
  });

  it("keeps subscription replay ahead of messages emitted by onAttached", async () => {
    let receive!: (message: NexusMessage) => void;
    const identities: number[] = [];
    mockClientHandlers.authorize = vi.fn(async ({ remoteIdentity }) => {
      identities.push(remoteIdentity.id);
      return true;
    });
    mockClientHandlers.onAttached = () => {
      receive({
        type: NexusMessageType.IDENTITY_UPDATE,
        id: null,
        updates: { id: 3 },
      });
      return Result.ok(undefined);
    };
    const opened = await LogicalConnection.open<TestAdapterModel>(
      {
        connectionId: "attachment-replay",
        direction: "outgoing",
        localIdentity: () => clientMeta,
        nextMessageId: () => 1,
        timeoutMs: 1000,
        acquire: (handlers) => {
          receive = handlers.onLogicalMessage;
          receive({
            type: NexusMessageType.HANDSHAKE_REQ,
            id: 7,
            metadata: hostMeta,
            capabilities: ["provider-catalog-v1"],
          });
          receive({
            type: NexusMessageType.HANDSHAKE_READY,
            id: 7,
            capabilities: ["provider-catalog-v1"],
          });
          return Result.ok({
            portProcessor: {
              close: () => Result.ok(undefined),
              sendMessage: () => Result.ok(undefined),
            },
            connectionMeta: hostConnectionMeta,
          });
        },
      },
      mockClientHandlers,
    );
    expect(opened.isOk()).toBe(true);
    // This packet joins the authorization tail behind the attachment-time update.
    const connection = opened.unwrap();
    await connection.safeHandleMessage({
      type: NexusMessageType.IDENTITY_UPDATE,
      id: null,
      updates: { id: 4 },
    });
    expect(identities).toEqual([hostMeta.id, 3, 4]);
    connection.close();
  });

  it.each([
    "identity",
    "attachment",
    "attachment result",
    "metadata disconnect",
    "disconnect",
    "protocol error",
  ])("cleans up synchronous %s failure during attachment", async (failure) => {
    vi.useFakeTimers();
    try {
      const error = new NexusProtocolError("attachment failed");
      const close = vi.fn(() => {
        disconnect();
        return Result.ok(undefined);
      });
      const sendMessage = vi.fn(() => Result.ok(undefined));
      let disconnect!: () => void;
      let protocolError!: () => void;
      const onAttached = vi.fn(() => {
        if (failure === "attachment") throw error;
        if (failure === "attachment result") return Result.err(error);
        if (failure === "disconnect") disconnect();
        if (failure === "protocol error") protocolError();
        return Result.ok(undefined);
      });
      mockClientHandlers.onAttached = onAttached;
      const opened = LogicalConnection.open<TestAdapterModel>(
        {
          connectionId: "attachment-failure",
          direction: "outgoing",
          localIdentity: () => {
            if (failure === "identity") throw error;
            return clientMeta;
          },
          nextMessageId: () => 1,
          timeoutMs: 1000,
          acquire: (handlers) => {
            disconnect = handlers.onDisconnect;
            protocolError = () => handlers.onProtocolError?.(error);
            return Result.ok({
              portProcessor: { close, sendMessage },
              connectionMeta: {
                get from() {
                  if (failure === "metadata disconnect") disconnect();
                  return hostConnectionMeta.from;
                },
              },
            });
          },
        },
        mockClientHandlers,
      );
      // Accepted processors attach synchronously; none of these failures needs
      // the deadline to settle, and ownership determines who emits onClosed.
      const beforeOwnership =
        failure === "identity" || failure === "metadata disconnect";
      expect(onAttached).toHaveBeenCalledTimes(beforeOwnership ? 0 : 1);
      const result = await opened;
      expect(result).toMatchObject({
        error: {
          code: failure.endsWith("disconnect")
            ? "E_HANDSHAKE_FAILED"
            : error.code,
        },
      });
      if (!failure.endsWith("disconnect") && result.isErr())
        expect(result.error).toBe(error);
      expect(close).toHaveBeenCalledOnce();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(mockClientHandlers.onClosed).toHaveBeenCalledTimes(
        beforeOwnership ? 0 : 1,
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["native", "silent", "reentrant", "error"])(
    "cleans up a protocol-ready session once on %s close before publication",
    async (mode) => {
      vi.useFakeTimers();
      try {
        const sendMessage = vi.fn(() => Result.ok(undefined));
        const close = vi.fn(() => {
          if (mode === "reentrant") connection.handleDisconnect();
          return mode === "error"
            ? Result.err(new NexusProtocolError("native close failed"))
            : Result.ok(undefined);
        });
        const connection = new LogicalConnection<TestAdapterModel>(
          { sendMessage, close },
          mockClientHandlers,
          {
            connectionId: "closing-before-publication",
            direction: "outgoing",
            localEndpointMeta: clientMeta,
            connectionMeta: hostConnectionMeta,
            nextMessageId: () => 1,
          },
        );
        connection.initiateHandshake();
        await connection.safeHandleMessage({
          type: NexusMessageType.HANDSHAKE_ACK,
          id: 1,
          metadata: hostMeta,
          capabilities: ["provider-catalog-v1"],
        });
        expect(connection.isReady()).toBe(true);
        connection.sendMessage({
          type: NexusMessageType.RES,
          id: 2,
          result: 1,
        });
        const sent = sendMessage.mock.calls.length;
        if (mode === "native") connection.handleDisconnect();
        else connection.close();
        connection.close();
        connection.handleDisconnect();
        await vi.advanceTimersByTimeAsync(0);
        expect(close).toHaveBeenCalledTimes(mode === "native" ? 0 : 1);
        expect(connection.isReady()).toBe(false);
        expect(mockClientHandlers.onClosed).toHaveBeenCalledExactlyOnceWith(
          connection,
          hostMeta,
        );
        expect(mockClientHandlers.onReady).not.toHaveBeenCalled();
        expect(sendMessage).toHaveBeenCalledTimes(sent);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["disconnect", "protocol error"])(
    "reclaims a processor when %s arrives before attachment",
    async (failure) => {
      const close = vi.fn(() => Result.ok(undefined));
      const sendMessage = vi.fn(() => Result.ok(undefined));
      const onAttached = vi.fn(() => Result.ok(undefined));
      mockClientHandlers.onAttached = onAttached;
      const result = await LogicalConnection.open<TestAdapterModel>(
        {
          connectionId: "failed-before-attachment",
          direction: "outgoing",
          localIdentity: () => clientMeta,
          nextMessageId: () => 1,
          timeoutMs: 1000,
          acquire: (handlers) => {
            if (failure === "disconnect") handlers.onDisconnect();
            else
              handlers.onProtocolError?.(
                new NexusProtocolError("invalid startup packet"),
              );
            return Result.ok({
              portProcessor: { close, sendMessage },
              connectionMeta: hostConnectionMeta,
            });
          },
        },
        mockClientHandlers,
      );
      expect(result).toMatchObject({
        error: {
          code:
            failure === "disconnect"
              ? "E_HANDSHAKE_FAILED"
              : "E_PROTOCOL_ERROR",
        },
      });
      expect(close).toHaveBeenCalledOnce();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(onAttached).not.toHaveBeenCalled();
      expect(mockClientHandlers.onClosed).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["incoming", "success"],
    ["outgoing", "success"],
    ["incoming", "failure"],
    ["outgoing", "failure"],
    ["incoming", "close"],
    ["outgoing", "close"],
    ["incoming", "throw"],
    ["outgoing", "throw"],
    ["incoming", "drain close"],
    ["outgoing", "drain close"],
    ["incoming", "drain failure"],
    ["outgoing", "drain failure"],
  ] as const)(
    "keeps %s owner registration atomic on %s",
    async (direction, outcome) => {
      vi.useFakeTimers();
      try {
        const sent: number[] = [];
        const close = vi.fn(() => Result.ok(undefined));
        const inbound: Array<Promise<Result<void, Error>>> = [];
        let attached!: LogicalConnection<TestAdapterModel>;
        mockClientHandlers.onAttached = (connection) => {
          attached = connection;
          return Result.ok(undefined);
        };
        const ownerError = new NexusProtocolError("owner registration failed");
        mockClientHandlers.onReady = vi.fn((connection, identity) => {
          expect(connection.remoteIdentity).toBe(identity);
          expect(connection.isReady()).toBe(true);
          expect(identity).toEqual(hostMeta);
          inbound.push(
            connection.safeHandleMessage({
              type: NexusMessageType.RES,
              id: 50,
              result: null,
            }),
          );
          // Response bypass must not cross a partially executed owner callback.
          expect(mockClientHandlers.onMessage).not.toHaveBeenCalled();
          connection.sendMessage({
            type: NexusMessageType.RES,
            id: 10,
            result: null,
          });
          connection.sendMessage({
            type: NexusMessageType.RES,
            id: 11,
            result: null,
          });
          if (outcome === "close") connection.close();
          if (outcome === "throw") throw ownerError;
          return outcome === "failure"
            ? Result.err(ownerError)
            : Result.ok(undefined);
        });
        const opened = LogicalConnection.open<TestAdapterModel>(
          {
            connectionId: "owner-reentry",
            direction,
            localIdentity: () => clientMeta,
            nextMessageId: () => 1,
            timeoutMs: 100,
            acquire: (handlers) => {
              if (direction === "incoming") {
                handlers.onLogicalMessage({
                  type: NexusMessageType.HANDSHAKE_REQ,
                  id: 1,
                  metadata: hostMeta,
                  capabilities: ["provider-catalog-v1"],
                });
                handlers.onLogicalMessage({
                  type: NexusMessageType.HANDSHAKE_READY,
                  id: 1,
                  capabilities: ["provider-catalog-v1"],
                });
              }
              return Result.ok({
                connectionMeta: hostConnectionMeta,
                portProcessor: {
                  close,
                  sendMessage: (message) => {
                    if (message.type === NexusMessageType.HANDSHAKE_REQ)
                      handlers.onLogicalMessage({
                        type: NexusMessageType.HANDSHAKE_ACK,
                        id: message.id,
                        metadata: hostMeta,
                        capabilities: ["provider-catalog-v1"],
                      });
                    if (message.type === NexusMessageType.RES) {
                      sent.push(Number(message.id));
                      if (message.id === 10) {
                        attached.sendMessage({
                          type: NexusMessageType.RES,
                          id: 12,
                          result: null,
                        });
                        if (outcome === "drain close") attached.close();
                        if (outcome === "drain failure")
                          return Result.err(
                            new NexusProtocolError("send failed"),
                          );
                      }
                    }
                    return Result.ok(undefined);
                  },
                },
              });
            },
          },
          mockClientHandlers,
        );
        await vi.advanceTimersByTimeAsync(0);
        const result = await opened;
        await Promise.all(inbound);
        expect(mockClientHandlers.onReady).toHaveBeenCalledOnce();
        if (outcome === "success") {
          const connection = result.unwrap();
          expect(sent).toEqual([10, 11, 12]);
          expect(mockClientHandlers.onMessage).toHaveBeenCalledExactlyOnceWith(
            connection,
            { type: NexusMessageType.RES, id: 50, result: null },
          );
          connection.close();
        } else {
          expect(result).toMatchObject({
            error: {
              code:
                outcome === "failure" || outcome === "throw"
                  ? "E_PROTOCOL_ERROR"
                  : "E_HANDSHAKE_FAILED",
            },
          });
          expect(sent).toEqual(outcome.startsWith("drain") ? [10] : []);
          if ((outcome === "failure" || outcome === "throw") && result.isErr())
            expect(result.error).toBe(ownerError);
          expect(mockClientHandlers.onMessage).not.toHaveBeenCalled();
        }
        expect(close).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onClosed).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("contains a throwing close callback after clearing startup resources", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn(() => Result.ok(undefined));
      mockClientHandlers.onClosed = vi.fn((connection) => {
        expect(connection.isReady()).toBe(false);
        connection.close();
        throw new Error("owner close failed");
      });
      mockClientHandlers.onAttached = (connection) => {
        connection.close();
        return Result.ok(undefined);
      };
      const opened = await LogicalConnection.open<TestAdapterModel>(
        {
          connectionId: "close-observer",
          direction: "incoming",
          localIdentity: () => clientMeta,
          nextMessageId: () => 1,
          timeoutMs: 100,
          acquire: () =>
            Result.ok({
              connectionMeta: hostConnectionMeta,
              portProcessor: {
                close,
                sendMessage: () => Result.ok(undefined),
              },
            }),
        },
        mockClientHandlers,
      );
      expect(opened).toMatchObject({ error: { code: "E_HANDSHAKE_FAILED" } });
      expect(close).toHaveBeenCalledOnce();
      expect(mockClientHandlers.onClosed).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains publication messages in FIFO order when sending synchronously reenters", async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<NexusMessage["id"]> = [];
      const connection = new LogicalConnection<TestAdapterModel>(
        {
          close: () => Result.ok(undefined),
          sendMessage: (message) => {
            if (message.type === NexusMessageType.RES) {
              sent.push(message.id);
              if (message.id === 10)
                connection.sendMessage({
                  type: NexusMessageType.RES,
                  id: 12,
                  result: null,
                });
            }
            return Result.ok(undefined);
          },
        },
        mockClientHandlers,
        {
          connectionId: "reentrant-publication",
          direction: "outgoing",
          localEndpointMeta: clientMeta,
          connectionMeta: hostConnectionMeta,
          nextMessageId: () => 1,
        },
      );
      connection.initiateHandshake();
      await connection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_ACK,
        id: 1,
        metadata: hostMeta,
        capabilities: ["provider-catalog-v1"],
      });
      for (const id of [10, 11])
        connection.sendMessage({
          type: NexusMessageType.RES,
          id,
          result: null,
        });
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toEqual([10, 11, 12]);
      expect(mockClientHandlers.onReady).toHaveBeenCalledOnce();
      connection.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns timeout and late processor disposal without a manager", async () => {
    vi.useFakeTimers();
    try {
      let deliver!: (
        value: Result<
          {
            portProcessor: PortProcessor.Context;
            connectionMeta: TestConnectionMeta;
          },
          unknown
        >,
      ) => void;
      const close = vi.fn(() => Result.ok(undefined));
      const attached = vi.fn(() => Result.ok(undefined));
      mockClientHandlers.onAttached = attached;
      const opened = LogicalConnection.open<TestAdapterModel>(
        {
          connectionId: "standalone",
          direction: "outgoing",
          localIdentity: () => clientMeta,
          nextMessageId: () => 1,
          timeoutMs: 10,
          acquire: () =>
            new Promise((resolve) => {
              deliver = resolve;
            }),
        },
        mockClientHandlers,
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(await opened).toMatchObject({
        error: { code: "E_HANDSHAKE_FAILED" },
      });
      deliver(
        Result.ok({
          portProcessor: {
            close,
            sendMessage: vi.fn(() => Result.ok(undefined)),
          },
          connectionMeta: hostConnectionMeta,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledOnce();
      expect(attached).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["publishing", "success"],
    ["publishing", "close"],
    ["publishing", "publication error"],
    ["activating", "success"],
    ["activating", "close"],
    ["activating", "publication error"],
    ["activating", "send failure"],
    ["passive activation", "success"],
    ["passive activation", "close"],
    ["passive activation", "publication error"],
  ])(
    "holds inbound RPC from %s through %s, without serializing independent calls",
    async (phase, outcome) => {
      vi.useFakeTimers();
      try {
        const events: string[] = [];
        let finishCall!: () => void;
        mockClientHandlers.onReady = () => {
          if (outcome === "publication error")
            throw new Error("publication failed");
          events.push("published");
          return Result.ok(undefined);
        };
        mockClientHandlers.onMessage = (_connection, message) => {
          events.push(`rpc:${message.id}`);
          if (message.id === 10)
            return new Promise<void>((resolve) => {
              finishCall = resolve;
            });
        };
        const calls: Array<Promise<Result<void, Error>>> = [];
        const receive = () => {
          for (const id of [10, 11])
            calls.push(
              connection.safeHandleMessage({
                type: NexusMessageType.APPLY,
                id,
                resourceId: null,
                path: [],
                args: [],
              }),
            );
          calls.push(
            connection.safeHandleMessage({
              type: NexusMessageType.RES,
              id: 12,
              result: null,
            }),
          );
          if (outcome === "close") connection.close();
        };
        const connection = new LogicalConnection<TestAdapterModel>(
          {
            sendMessage: (message) => {
              if (message.type === NexusMessageType.PROVIDER_AVAILABLE) {
                receive();
                if (outcome === "send failure")
                  return Result.err(
                    new NexusProtocolError("provider send failed"),
                  );
              }
              return Result.ok(undefined);
            },
            close: () => Result.ok(undefined),
          },
          mockClientHandlers,
          {
            connectionId: "publication-barrier",
            direction: phase === "passive activation" ? "incoming" : "outgoing",
            localEndpointMeta: clientMeta,
            connectionMeta: hostConnectionMeta,
            nextMessageId: () => 1,
          },
        );
        if (phase === "passive activation") {
          await connection.safeHandleMessage({
            type: NexusMessageType.HANDSHAKE_REQ,
            id: 1,
            metadata: hostMeta,
            capabilities: ["provider-catalog-v1"],
          });
          connection.publishProviders(["service"]);
          await connection.safeHandleMessage({
            type: NexusMessageType.HANDSHAKE_READY,
            id: 1,
            capabilities: ["provider-catalog-v1"],
          });
        } else {
          connection.initiateHandshake();
          if (phase === "activating") connection.publishProviders(["service"]);
          await connection.safeHandleMessage({
            type: NexusMessageType.HANDSHAKE_ACK,
            id: 1,
            metadata: hostMeta,
            capabilities: ["provider-catalog-v1"],
          });
        }
        if (phase === "publishing") receive();
        if (phase !== "passive activation") expect(events).toEqual([]);
        await vi.advanceTimersByTimeAsync(0);
        if (outcome === "success") {
          expect(events[0]).toBe("published");
          expect(events.slice(1)).toEqual(
            expect.arrayContaining(["rpc:10", "rpc:11", "rpc:12"]),
          );
          finishCall();
        } else {
          expect(events).toEqual([]);
          expect(connection.isReady()).toBe(false);
        }
        await Promise.all(calls);
        expect(vi.getTimerCount()).toBe(0);
        connection.close();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("drains providers registered reentrantly during activation", async () => {
    const sent: string[][] = [];
    const connection = new LogicalConnection<TestAdapterModel>(
      {
        close: () => Result.ok(undefined),
        sendMessage: (message) => {
          if (message.type === NexusMessageType.PROVIDER_AVAILABLE) {
            sent.push([...message.providers]);
            if (sent.length === 1) connection.publishProviders(["second"]);
          }
          return Result.ok(undefined);
        },
      },
      mockClientHandlers,
      {
        connectionId: "provider-reentry",
        direction: "incoming",
        localEndpointMeta: clientMeta,
        connectionMeta: hostConnectionMeta,
        nextMessageId: () => 1,
      },
    );
    await connection.safeHandleMessage({
      type: NexusMessageType.HANDSHAKE_REQ,
      id: 1,
      metadata: hostMeta,
      capabilities: ["provider-catalog-v1"],
    });
    connection.publishProviders(["first"]);
    await connection.safeHandleMessage({
      type: NexusMessageType.HANDSHAKE_READY,
      id: 1,
      capabilities: ["provider-catalog-v1"],
    });
    expect(sent).toEqual([["first"], ["second"]]);
    expect(connection.isReady()).toBe(true);
    connection.close();
  });

  it("delivers a passive capability rejection before closing a queued transport", async () => {
    vi.useFakeTimers();
    try {
      let closed = false;
      const received: NexusMessage[] = [];
      const connection = new LogicalConnection<TestAdapterModel>(
        {
          close: () => {
            closed = true;
            return Result.ok(undefined);
          },
          sendMessage: (message) => {
            setTimeout(() => {
              if (!closed) received.push(message);
            }, 0);
            return Result.ok(undefined);
          },
        },
        mockClientHandlers,
        {
          connectionId: "queued-rejection",
          direction: "incoming",
          localEndpointMeta: clientMeta,
          connectionMeta: hostConnectionMeta,
          nextMessageId: () => 1,
        },
      );
      await connection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_REQ,
        id: 1,
        metadata: hostMeta,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(received).toEqual([
        expect.objectContaining({
          type: NexusMessageType.HANDSHAKE_REJECT,
          error: expect.objectContaining({ code: "E_PROTOCOL_INCOMPATIBLE" }),
        }),
      ]);
      expect(closed).toBe(true);
      expect(mockClientHandlers.authorize).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reauthorize a replayed request while waiting for READY", async () => {
    (mockHostHandlers.authorize as Mock).mockResolvedValue(true);
    const request = {
      type: NexusMessageType.HANDSHAKE_REQ,
      id: 31,
      metadata: clientMeta,
      capabilities: ["provider-catalog-v1"],
    } as const;
    await hostConnection.safeHandleMessage(request);
    await hostConnection.safeHandleMessage(request);
    expect(mockHostHandlers.authorize).toHaveBeenCalledOnce();
    hostConnection.close();
  });

  it("ignores a rejection for a different handshake", async () => {
    clientConnection.initiateHandshake();
    await clientConnection.safeHandleMessage({
      type: NexusMessageType.HANDSHAKE_REJECT,
      id: 999,
      error: {
        name: "Error",
        message: "unrelated",
        code: "E_AUTH_CONNECT_DENIED",
      },
    });
    expect(clientConnection.handshakeRejectionError).toBeUndefined();
    expect(mockClientHandlers.onClosed).not.toHaveBeenCalled();
    clientConnection.close();
  });

  it("does not forward late handshake control messages to the service layer", async () => {
    (mockHostHandlers.authorize as Mock).mockResolvedValue(true);
    clientConnection.initiateHandshake();
    await vi.waitFor(() => expect(clientConnection.isReady()).toBe(true));
    await clientConnection.safeHandleMessage({
      type: NexusMessageType.HANDSHAKE_ACK,
      id: 1,
      metadata: hostMeta,
      capabilities: ["provider-catalog-v1"],
      providers: [],
    });
    expect(mockClientHandlers.onMessage).not.toHaveBeenCalled();
    expect(mockClientHandlers.authorize).toHaveBeenCalledOnce();
    clientConnection.close();
  });

  it("does not become ready if provider publication synchronously disconnects", async () => {
    const connection = new LogicalConnection<TestAdapterModel>(
      {
        sendMessage: (message) => {
          if (message.type === NexusMessageType.PROVIDER_AVAILABLE)
            connection.handleDisconnect();
          return Result.ok(undefined);
        },
        close: () => Result.ok(undefined),
      },
      mockClientHandlers,
      {
        connectionId: "sync-close",
        localEndpointMeta: clientMeta,
        connectionMeta: hostConnectionMeta,
        direction: "outgoing",
        nextMessageId: () => 1,
      },
    );
    connection.initiateHandshake();
    connection.publishProviders(["service.queued"]);
    await connection.safeHandleMessage({
      type: NexusMessageType.HANDSHAKE_ACK,
      id: 1,
      metadata: hostMeta,
      capabilities: ["provider-catalog-v1"],
      providers: [],
    });
    expect(connection.isReady()).toBe(false);
    expect(mockClientHandlers.onClosed).toHaveBeenCalledOnce();
    expect(mockClientHandlers.onReady).not.toHaveBeenCalled();
  });

  it("does not commit an ACK after disconnect during authorization", async () => {
    let finish!: (allowed: boolean) => void;
    mockClientHandlers.authorize = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    clientConnection.initiateHandshake();
    const handling = clientConnection.safeHandleMessage({
      type: NexusMessageType.HANDSHAKE_ACK,
      id: 1,
      metadata: hostMeta,
      capabilities: ["provider-catalog-v1"],
      providers: ["service.late"],
    });
    await vi.waitFor(() =>
      expect(mockClientHandlers.authorize).toHaveBeenCalledOnce(),
    );
    expect(clientConnection.remoteIdentity).toBeUndefined();
    clientConnection.handleDisconnect();
    finish(true);
    await handling;
    expect(clientConnection.isReady()).toBe(false);
    expect(clientConnection.remoteProviders.size).toBe(0);
    expect(mockClientHandlers.onReady).not.toHaveBeenCalled();
  });

  it("ignores provider messages and rejects sends after disconnect", async () => {
    clientConnection.handleDisconnect();
    await clientConnection.safeHandleMessage({
      type: NexusMessageType.PROVIDER_AVAILABLE,
      id: null,
      providers: ["service.late"],
    });
    expect(clientConnection.remoteProviders.size).toBe(0);
    expect(
      clientConnection.sendMessage({
        type: NexusMessageType.IDENTITY_UPDATE,
        id: null,
        updates: {},
      }),
    ).toMatchObject({ error: { code: "E_USAGE_INVALID" } });
  });

  it("does not acknowledge a request after closing during authorization", async () => {
    let finish!: (allowed: boolean) => void;
    mockHostHandlers.authorize = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const handling = hostConnection.safeHandleMessage({
      type: NexusMessageType.HANDSHAKE_REQ,
      id: 19,
      metadata: clientMeta,
      assigns: { context: "assigned", id: 9 },
      capabilities: ["provider-catalog-v1"],
    });
    await vi.waitFor(() =>
      expect(mockHostHandlers.authorize).toHaveBeenCalledOnce(),
    );
    hostConnection.close();
    finish(true);
    await handling;
    expect(hostConnection.remoteIdentity).toBeUndefined();
    expect(hostConnection.localIdentity).toEqual(hostMeta);
    expect(hostConnection.isReady()).toBe(false);
    expect(mockHostHandlers.onClosed).toHaveBeenCalledOnce();
  });

  it("does not publish an identity update authorized after disconnect", async () => {
    (mockHostHandlers.authorize as Mock).mockResolvedValue(true);
    clientConnection.initiateHandshake();
    await vi.waitFor(() => expect(clientConnection.isReady()).toBe(true));
    let finish!: (allowed: boolean) => void;
    mockClientHandlers.authorize = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const handling = clientConnection.safeHandleMessage({
      type: NexusMessageType.IDENTITY_UPDATE,
      id: null,
      updates: { id: 99 },
    });
    await vi.waitFor(() =>
      expect(mockClientHandlers.authorize).toHaveBeenCalledOnce(),
    );
    clientConnection.close();
    finish(true);
    await handling;
    expect(clientConnection.remoteIdentity).toEqual(hostMeta);
    expect(mockClientHandlers.onIdentityUpdated).not.toHaveBeenCalled();
    expect(mockClientHandlers.onClosed).toHaveBeenCalledOnce();
  });

  it("freezes a shallow connection metadata snapshot", () => {
    hostConnectionMeta.from = "mutated";

    expect(clientConnection.context.connection).toEqual({ from: "host" });
    expect(Object.isFrozen(clientConnection.context.connection)).toBe(true);
    expect(() => {
      (clientConnection.context.connection as { from: string }).from =
        "replaced";
    }).toThrow(TypeError);
    expect(clientConnection.context.connection.from).toBe("host");
  });

  describe("Successful Handshake (A1)", () => {
    it("should establish a connection when handshake succeeds", async () => {
      // Arrange: Host policy allows the connection
      (mockHostHandlers.authorize as Mock).mockResolvedValue(true);

      // Act: Client initiates the handshake
      clientConnection.initiateHandshake();

      // Assert: The full handshake completes successfully
      await vi.waitFor(() => {
        // 1. Host verifies the client
        expect(mockHostHandlers.authorize).toHaveBeenCalled();
        expect(mockHostHandlers.authorize).toHaveBeenCalledWith(
          expect.objectContaining<ConnectionAuthContext<TestAdapterModel>>({
            localIdentity: hostMeta,
            remoteIdentity: clientMeta,
            connection: clientConnectionMeta,
            direction: "incoming",
          }),
        );
      });

      await vi.waitFor(() => {
        // 2. Both sides are notified of verification
        expect(mockHostHandlers.onReady).toHaveBeenCalledOnce();
        expect(mockHostHandlers.onReady).toHaveBeenCalledWith(
          hostConnection,
          clientMeta,
        );

        expect(mockClientHandlers.onReady).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onReady).toHaveBeenCalledWith(
          clientConnection,
          hostMeta,
        );

        // 3. Both connections are now ready
        expect(clientConnection.isReady()).toBe(true);
        expect(hostConnection.isReady()).toBe(true);

        // 4. Remote identities are correctly stored
        expect(clientConnection.remoteIdentity).toEqual(hostMeta);
        expect(hostConnection.remoteIdentity).toEqual(clientMeta);
        expect(clientConnection.remoteProviders.size).toBe(0);
        expect(hostConnection.remoteProviders.size).toBe(0);
      });
    });

    it("makes the active side ready synchronously after sending READY", async () => {
      const sent: NexusMessage[] = [];
      const handlers: LogicalConnectionHandlers<TestAdapterModel> = {
        onAttached: vi.fn(() => Result.ok(undefined)),
        onReady: vi.fn(() => Result.ok(undefined)),
        onClosed: vi.fn(),
        onMessage: vi.fn(),
        onIdentityUpdated: vi.fn(),
        authorize: vi.fn().mockResolvedValue(true),
      };
      const connection = new LogicalConnection(
        {
          sendMessage: vi.fn((message: NexusMessage) => {
            sent.push(message);
            return Result.ok(undefined);
          }),
          close: vi.fn(() => Result.ok(undefined)),
        },
        handlers,
        {
          connectionId: "conn-active-ready",
          connectionMeta: hostConnectionMeta,
          direction: "outgoing",
          localEndpointMeta: clientMeta,
          nextMessageId: () => 1,
        },
      );

      expect(connection.initiateHandshake().isOk()).toBe(true);
      await connection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_ACK,
        id: 1,
        metadata: hostMeta,
        capabilities: ["provider-catalog-v1"],
      });

      expect(sent).toContainEqual(
        expect.objectContaining({ type: NexusMessageType.HANDSHAKE_READY }),
      );
      expect(connection.isReady()).toBe(true);
      expect(handlers.onReady).not.toHaveBeenCalled();
      const response = {
        type: NexusMessageType.RES,
        id: 2,
        result: "queued",
      } as const;
      expect(connection.sendMessage(response).isOk()).toBe(true);
      expect(sent).not.toContain(response);
      await vi.waitFor(() => expect(handlers.onReady).toHaveBeenCalledOnce());
      expect(sent.at(-1)).toBe(response);
    });

    it("merges authorized handshake catalogs monotonically", async () => {
      (mockHostHandlers.authorize as Mock).mockResolvedValue(true);
      expect(clientConnection.initiateHandshake().isOk()).toBe(true);

      await vi.waitFor(() => {
        expect(clientConnection.isReady()).toBe(true);
        expect(hostConnection.isReady()).toBe(true);
      });

      await clientConnection.safeHandleMessage({
        type: NexusMessageType.PROVIDER_AVAILABLE,
        id: null,
        providers: ["service.a", "service.a", "service.b"],
      });
      await clientConnection.safeHandleMessage({
        type: NexusMessageType.PROVIDER_AVAILABLE,
        id: null,
        providers: ["service.b"],
      });

      expect(clientConnection.remoteProviders).toEqual(
        new Set(["service.a", "service.b"]),
      );
    });

    it("flushes providers registered at each handshake phase and after readiness", async () => {
      vi.useFakeTimers();
      const sent: NexusMessage[] = [];
      const handlers: LogicalConnectionHandlers<TestAdapterModel> = {
        onAttached: vi.fn(() => Result.ok(undefined)),
        onReady: vi.fn(() => Result.ok(undefined)),
        onClosed: vi.fn(),
        onMessage: vi.fn(),
        onIdentityUpdated: vi.fn(),
        authorize: vi.fn().mockResolvedValue(true),
      };
      const createConnection = () =>
        new LogicalConnection(
          {
            sendMessage: vi.fn((message: NexusMessage) => {
              sent.push(message);
              return Result.ok(undefined);
            }),
            close: vi.fn(() => Result.ok(undefined)),
          },
          handlers,
          {
            connectionId: "conn-phase",
            connectionMeta: hostConnectionMeta,
            direction: "outgoing",
            localEndpointMeta: clientMeta,
            nextMessageId: () => 1,
          },
        );

      try {
        const reqBeforeAck = createConnection();
        reqBeforeAck.initiateHandshake();
        reqBeforeAck.publishProviders(["req.provider"]);
        await reqBeforeAck.safeHandleMessage({
          type: NexusMessageType.HANDSHAKE_ACK,
          id: 1,
          metadata: hostMeta,
          capabilities: ["provider-catalog-v1"],
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toContainEqual(
          expect.objectContaining({
            type: NexusMessageType.PROVIDER_AVAILABLE,
            providers: ["req.provider"],
          }),
        );

        sent.length = 0;
        const ackBeforeReady = new LogicalConnection(
          {
            sendMessage: vi.fn((message: NexusMessage) => {
              sent.push(message);
              return Result.ok(undefined);
            }),
            close: vi.fn(() => Result.ok(undefined)),
          },
          handlers,
          {
            connectionId: "conn-ack-phase",
            connectionMeta: hostConnectionMeta,
            direction: "incoming",
            localEndpointMeta: hostMeta,
            nextMessageId: () => 1,
          },
        );
        await ackBeforeReady.safeHandleMessage({
          type: NexusMessageType.HANDSHAKE_REQ,
          id: 1,
          metadata: clientMeta,
          capabilities: ["provider-catalog-v1"],
        });
        ackBeforeReady.publishProviders(["ack.provider"]);
        await ackBeforeReady.safeHandleMessage({
          type: NexusMessageType.HANDSHAKE_READY,
          id: 1,
          capabilities: ["provider-catalog-v1"],
        });
        expect(sent).toContainEqual(
          expect.objectContaining({
            type: NexusMessageType.PROVIDER_AVAILABLE,
            providers: ["ack.provider"],
          }),
        );

        sent.length = 0;
        expect(reqBeforeAck.publishProviders(["ready.provider"]).isOk()).toBe(
          true,
        );
        expect(sent).toEqual([
          expect.objectContaining({
            type: NexusMessageType.PROVIDER_AVAILABLE,
            providers: ["ready.provider"],
          }),
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("closes before verification when a queued provider publication fails", async () => {
      const sendMessage = vi
        .fn()
        .mockReturnValueOnce(Result.ok(undefined))
        .mockReturnValueOnce(
          Result.err(new NexusProtocolError("provider publication failed")),
        );
      const portProcessor: PortProcessor.Context = {
        sendMessage,
        close: vi.fn(() => Result.ok(undefined)),
      };
      const handlers: LogicalConnectionHandlers<TestAdapterModel> = {
        onAttached: vi.fn(() => Result.ok(undefined)),
        onReady: vi.fn(() => Result.ok(undefined)),
        onClosed: vi.fn(),
        onMessage: vi.fn(),
        onIdentityUpdated: vi.fn(),
        authorize: vi.fn().mockResolvedValue(true),
      };
      const connection = new LogicalConnection(portProcessor, handlers, {
        connectionId: "conn-publication-failure",
        connectionMeta: hostConnectionMeta,
        direction: "incoming",
        localEndpointMeta: clientMeta,
        nextMessageId: () => 1,
      });

      await connection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_REQ,
        id: 1,
        metadata: hostMeta,
        capabilities: ["provider-catalog-v1"],
      });
      expect(connection.publishProviders(["service.queued"]).isOk()).toBe(true);

      await connection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_READY,
        id: 1,
        capabilities: ["provider-catalog-v1"],
      });

      expect(connection.isReady()).toBe(false);
      expect(handlers.onReady).not.toHaveBeenCalled();
      expect(handlers.onClosed).toHaveBeenCalledWith(connection, undefined);
    });
  });

  describe("Rejected Handshake (A2)", () => {
    it.each(["throw", "reject"])(
      "contains a policy %s without a manager and rejects rather than committing",
      async (failure) => {
        const problem = Object.create(null);
        mockClientHandlers.authorize = () => {
          if (failure === "throw") throw problem;
          return Promise.reject(problem);
        };
        const sent: NexusMessage[] = [];
        const connection = new LogicalConnection<TestAdapterModel>(
          {
            sendMessage: (message) => {
              sent.push(message);
              return Result.ok(undefined);
            },
            close: () => Result.ok(undefined),
          },
          mockClientHandlers,
          {
            connectionId: "standalone-policy",
            direction: "outgoing",
            localEndpointMeta: clientMeta,
            connectionMeta: hostConnectionMeta,
            nextMessageId: () => 1,
          },
        );
        connection.initiateHandshake();
        const handled = await connection.safeHandleMessage({
          type: NexusMessageType.HANDSHAKE_ACK,
          id: 1,
          metadata: hostMeta,
          capabilities: ["provider-catalog-v1"],
        });
        expect(handled.isOk()).toBe(true);
        expect(connection.remoteIdentity).toBeUndefined();
        expect(connection.handshakeRejectionError).toMatchObject({
          code: "E_AUTH_CONNECT_DENIED",
        });
        expect(sent.at(-1)).toMatchObject({
          type: NexusMessageType.HANDSHAKE_REJECT,
          error: { code: "E_AUTH_CONNECT_DENIED" },
        });
        expect(mockClientHandlers.onReady).not.toHaveBeenCalled();
        expect(mockClientHandlers.onClosed).toHaveBeenCalledExactlyOnceWith(
          connection,
          undefined,
        );
      },
    );

    it("rejects an incompatible request before authorization or catalog publication", async () => {
      (mockHostHandlers.authorize as Mock).mockResolvedValue(false);

      await hostConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_REQ,
        id: 76,
        metadata: clientMeta,
      });

      expect(mockHostHandlers.authorize).not.toHaveBeenCalled();
      expect(hostConnection.handshakeRejectionError).toMatchObject({
        code: "E_PROTOCOL_INCOMPATIBLE",
      });
      expect(mockHostHandlers.onReady).not.toHaveBeenCalled();
    });

    it("rejects an ACK from a peer without provider-catalog-v1", async () => {
      (mockClientHandlers.authorize as Mock).mockResolvedValue(false);

      expect(clientConnection.initiateHandshake().isOk()).toBe(true);
      await clientConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_ACK,
        id: 1,
        metadata: hostMeta,
      });

      expect(clientConnection.handshakeRejectionError).toMatchObject({
        code: "E_PROTOCOL_INCOMPATIBLE",
      });
      expect(clientConnection.isReady()).toBe(false);
      expect(mockClientHandlers.authorize).not.toHaveBeenCalled();
      expect(mockClientHandlers.onReady).not.toHaveBeenCalled();
    });

    it("does not disclose catalogs in incompatible REQ or ACK replies when policy denies", async () => {
      const sentByHost: NexusMessage[] = [];
      const sentByClient: NexusMessage[] = [];
      const createConnection = (
        direction: "incoming" | "outgoing",
        sent: NexusMessage[],
        handlers: LogicalConnectionHandlers<TestAdapterModel>,
      ) =>
        new LogicalConnection(
          {
            sendMessage: vi.fn((message: NexusMessage) => {
              sent.push(message);
              return Result.ok(undefined);
            }),
            close: vi.fn(() => Result.ok(undefined)),
          },
          handlers,
          {
            connectionId: `conn-${direction}`,
            connectionMeta: hostConnectionMeta,
            direction,
            localEndpointMeta: direction === "incoming" ? hostMeta : clientMeta,
            nextMessageId: () => 1,
            localProviders: () => ["private.service"],
          },
        );
      const denyingHandlers =
        (): LogicalConnectionHandlers<TestAdapterModel> => ({
          onAttached: vi.fn(() => Result.ok(undefined)),
          onReady: vi.fn(() => Result.ok(undefined)),
          onClosed: vi.fn(),
          onMessage: vi.fn(),
          onIdentityUpdated: vi.fn(),
          authorize: vi.fn().mockResolvedValue(false),
        });
      const incoming = createConnection(
        "incoming",
        sentByHost,
        denyingHandlers(),
      );

      await incoming.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_REQ,
        id: 1,
        metadata: clientMeta,
      });

      expect(sentByHost).toEqual([
        expect.objectContaining({
          type: NexusMessageType.HANDSHAKE_REJECT,
          error: expect.objectContaining({ code: "E_PROTOCOL_INCOMPATIBLE" }),
        }),
      ]);
      expect(sentByHost).not.toContainEqual(
        expect.objectContaining({
          type: NexusMessageType.HANDSHAKE_ACK,
          providers: expect.anything(),
        }),
      );

      const outgoing = createConnection(
        "outgoing",
        sentByClient,
        denyingHandlers(),
      );
      expect(outgoing.initiateHandshake().isOk()).toBe(true);
      await outgoing.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_ACK,
        id: 1,
        metadata: hostMeta,
      });

      expect(sentByClient).toEqual([
        expect.objectContaining({ type: NexusMessageType.HANDSHAKE_REQ }),
        expect.objectContaining({
          type: NexusMessageType.HANDSHAKE_REJECT,
          error: expect.objectContaining({ code: "E_PROTOCOL_INCOMPATIBLE" }),
        }),
      ]);
      expect(sentByClient).not.toContainEqual(
        expect.objectContaining({
          type: NexusMessageType.HANDSHAKE_READY,
          providers: expect.anything(),
        }),
      );
    });

    it("preserves a remote incompatible rejection's structured cause", async () => {
      expect(clientConnection.initiateHandshake().isOk()).toBe(true);
      await clientConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_REJECT,
        id: 1,
        error: {
          name: "NexusProtocolIncompatibleError",
          code: "E_PROTOCOL_INCOMPATIBLE",
          message: "provider catalog missing",
          cause: {
            name: "VersionError",
            code: "E_UNKNOWN",
            message: "old peer",
          },
        },
      });

      expect(clientConnection.handshakeRejectionError).toMatchObject({
        code: "E_PROTOCOL_INCOMPATIBLE",
        cause: {
          code: "E_UNKNOWN",
          message: "old peer",
        },
      });
    });

    it("holds passive READY behind pending authorization and discards it on denial", async () => {
      let resolveVerify!: (allowed: boolean) => void;
      (mockHostHandlers.authorize as Mock).mockReturnValue(
        new Promise<boolean>((resolve) => {
          resolveVerify = resolve;
        }),
      );

      void hostConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_REQ,
        id: 77,
        metadata: clientMeta,
        capabilities: ["provider-catalog-v1"],
      });

      await vi.waitFor(() => {
        expect(mockHostHandlers.authorize).toHaveBeenCalledOnce();
      });

      const readyBeforeVerify = hostConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_READY,
        id: 77,
        capabilities: ["provider-catalog-v1"],
      });

      expect(hostConnection.isReady()).toBe(false);
      expect(mockHostHandlers.onReady).not.toHaveBeenCalled();

      resolveVerify(false);
      expect((await readyBeforeVerify).isOk()).toBe(true);
      await vi.waitFor(() => {
        expect(hostConnection.isReady()).toBe(false);
        expect(mockHostHandlers.onReady).not.toHaveBeenCalled();
      });
      hostConnection.close();
    });

    it("should ignore passive HANDSHAKE_READY with the wrong handshake id", async () => {
      (mockHostHandlers.authorize as Mock).mockResolvedValue(true);

      await hostConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_REQ,
        id: 88,
        metadata: clientMeta,
        capabilities: ["provider-catalog-v1"],
      });

      await vi.waitFor(() => {
        expect(mockHostHandlers.authorize).toHaveBeenCalledOnce();
      });

      const wrongReady = await hostConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_READY,
        id: 89,
        capabilities: ["provider-catalog-v1"],
      });

      expect(wrongReady.isOk()).toBe(true);
      expect(hostConnection.isReady()).toBe(false);
      expect(mockHostHandlers.onReady).not.toHaveBeenCalled();
    });

    it("should reject the active side when ACK verification fails", async () => {
      (mockHostHandlers.authorize as Mock).mockResolvedValue(true);
      (mockClientHandlers.authorize as Mock).mockResolvedValue(false);

      clientConnection.initiateHandshake();

      await vi.waitFor(() => {
        expect(mockClientHandlers.authorize).toHaveBeenCalledWith(
          expect.objectContaining<ConnectionAuthContext<TestAdapterModel>>({
            localIdentity: clientMeta,
            remoteIdentity: hostMeta,
            connection: hostConnectionMeta,
            direction: "outgoing",
          }),
        );
        expect(mockClientHandlers.onReady).not.toHaveBeenCalled();
        expect(clientConnection.isReady()).toBe(false);
      });

      expect(clientConnection.handshakeRejectionError).toEqual(
        expect.objectContaining({ code: "E_AUTH_CONNECT_DENIED" }),
      );
      expect(mockHostHandlers.onReady).not.toHaveBeenCalled();
      expect(hostConnection.isReady()).toBe(false);
    });

    it("should ignore active HANDSHAKE_ACK with the wrong handshake id", async () => {
      (mockClientHandlers.authorize as Mock).mockResolvedValue(true);

      const startResult = clientConnection.initiateHandshake();
      expect(startResult.isOk()).toBe(true);

      const wrongAck = await clientConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_ACK,
        id: 999,
        metadata: hostMeta,
        capabilities: ["provider-catalog-v1"],
      });

      expect(wrongAck.isOk()).toBe(true);
      expect(mockClientHandlers.authorize).not.toHaveBeenCalled();
      expect(mockClientHandlers.onReady).not.toHaveBeenCalled();
      expect(clientConnection.isReady()).toBe(false);
    });

    it("should close the connection when host rejects the handshake", async () => {
      // Arrange: Host policy rejects the connection
      (mockHostHandlers.authorize as Mock).mockResolvedValue(false);

      // Act: Client initiates the handshake
      clientConnection.initiateHandshake();

      // Assert: The connection is refused and closed
      await vi.waitFor(() => {
        // 1. Host attempts to verify
        expect(mockHostHandlers.authorize).toHaveBeenCalledOnce();
        expect(mockHostHandlers.authorize).toHaveBeenCalledWith(
          expect.objectContaining({ remoteIdentity: clientMeta }),
        );
      });

      await vi.waitFor(() => {
        // 2. Neither session is ready for owner registration.
        expect(mockHostHandlers.onReady).not.toHaveBeenCalled();
        expect(mockClientHandlers.onReady).not.toHaveBeenCalled();

        // 3. onClosed IS called for both parties
        expect(mockHostHandlers.onClosed).toHaveBeenCalledOnce();
        // Identity is undefined because the connection was never verified
        expect(mockHostHandlers.onClosed).toHaveBeenCalledWith(
          hostConnection,
          undefined,
        );

        expect(mockClientHandlers.onClosed).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onClosed).toHaveBeenCalledWith(
          clientConnection,
          undefined,
        );
      });

      // 4. Connections are not ready
      expect(clientConnection.isReady()).toBe(false);
      expect(hostConnection.isReady()).toBe(false);
    });
  });

  describe("Christening Handshake (Naming)", () => {
    it("authorizes later identity changes against the session's assigned and updated identity", async () => {
      const assigned: TestUserMeta = { context: "worker", id: 99 };
      mockHostHandlers.authorize = vi.fn(() => true);
      clientConnection.initiateHandshake(assigned);
      await vi.waitFor(() =>
        expect(mockHostHandlers.onReady).toHaveBeenCalledOnce(),
      );
      hostConnection.updateLocalIdentity({ id: 100 });
      await hostConnection.safeHandleMessage({
        type: NexusMessageType.IDENTITY_UPDATE,
        id: null,
        updates: { id: 200 },
      });
      expect(mockHostHandlers.authorize).toHaveBeenLastCalledWith({
        localIdentity: { ...assigned, id: 100 },
        remoteIdentity: { ...clientMeta, id: 200 },
        connection: clientConnectionMeta,
        direction: "incoming",
      });
      expect(mockHostHandlers.onIdentityUpdated).toHaveBeenLastCalledWith(
        hostConnection,
        { ...clientMeta, id: 200 },
        clientMeta,
      );
      clientConnection.close();
    });

    it("should adopt assigned metadata during a christening handshake", async () => {
      // Arrange
      const assignmentMeta: TestUserMeta = { context: "worker", id: 99 };
      // Host policy must still allow the original client identity to connect
      (mockHostHandlers.authorize as Mock).mockResolvedValue(true);

      // Act: Client initiates handshake, assigning new metadata to the host
      clientConnection.initiateHandshake(assignmentMeta);

      // Assert
      await vi.waitFor(() => {
        // 1. Host still verifies the original client identity
        expect(mockHostHandlers.authorize).toHaveBeenCalledWith(
          expect.objectContaining({ remoteIdentity: clientMeta }),
        );

        // 2. Host adopts the new metadata and sends it back in the ACK.
        // We can verify this by checking the identity received by the client.
        expect(mockClientHandlers.onReady).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onReady).toHaveBeenCalledWith(
          clientConnection,
          assignmentMeta,
        );

        // 3. The host's local metadata has been updated internally.
        expect(hostConnection.localIdentity).toEqual(assignmentMeta);

        // 4. The client's remote identity is the new assigned metadata.
        expect(clientConnection.remoteIdentity).toEqual(assignmentMeta);
      });
    });

    it("should verify a christening handshake against the pre-assignment local identity", async () => {
      const assignmentMeta: TestUserMeta = { context: "worker", id: 99 };
      (mockHostHandlers.authorize as Mock).mockImplementationOnce(
        (context: ConnectionAuthContext<TestAdapterModel>) =>
          context.localIdentity === hostMeta,
      );

      clientConnection.initiateHandshake(assignmentMeta);

      await vi.waitFor(() => {
        expect(mockHostHandlers.authorize).toHaveBeenCalledWith(
          expect.objectContaining({
            localIdentity: hostMeta,
            remoteIdentity: clientMeta,
          }),
        );
        expect(hostConnection.localIdentity).toEqual(assignmentMeta);
        expect(mockHostHandlers.onReady).toHaveBeenCalledOnce();
      });
    });

    it("should not commit assigned metadata when christening authorization fails", async () => {
      const assignmentMeta: TestUserMeta = { context: "attacker", id: 666 };
      (mockHostHandlers.authorize as Mock).mockResolvedValueOnce(false);

      await hostConnection.safeHandleMessage({
        type: NexusMessageType.HANDSHAKE_REQ,
        id: 444,
        metadata: clientMeta,
        assigns: assignmentMeta,
        capabilities: ["provider-catalog-v1"],
      });

      expect(hostConnection.localIdentity).toEqual(hostMeta);
      expect(mockHostHandlers.onReady).not.toHaveBeenCalled();
      hostConnection.close();
    });
  });

  describe("Post-Handshake Communication", () => {
    beforeEach(async () => {
      // Establish a connection before each test in this block
      (mockHostHandlers.authorize as Mock).mockResolvedValue(true);
      clientConnection.initiateHandshake();
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
          hostConnection,
          testMessage,
        );
      });
      expect(mockClientHandlers.onMessage).not.toHaveBeenCalled();

      // Act: Host sends a message back to the client
      hostConnection.sendMessage(testMessage);

      // Assert: Client receives the message correctly
      await vi.waitFor(() => {
        expect(mockClientHandlers.onMessage).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onMessage).toHaveBeenCalledWith(
          clientConnection,
          testMessage,
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
          hostConnection,
          applyMessage,
        );
      });

      clientConnection.sendMessage(responseMessage);

      await vi.waitFor(() => {
        expect(mockHostHandlers.onMessage).toHaveBeenCalledWith(
          hostConnection,
          responseMessage,
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
        expect(mockHostHandlers.onClosed).toHaveBeenCalledWith(
          hostConnection,
          clientMeta,
        );

        expect(mockClientHandlers.onClosed).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onClosed).toHaveBeenCalledWith(
          clientConnection,
          hostMeta,
        );
      });

      // Connections are no longer ready
      expect(clientConnection.isReady()).toBe(false);
      expect(hostConnection.isReady()).toBe(false);
    });
  });

  describe("Dynamic Identity Update", () => {
    beforeEach(async () => {
      // Establish a connection before each test in this block
      (mockHostHandlers.authorize as Mock).mockResolvedValue(true);
      clientConnection.initiateHandshake();
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
          clientConnection,
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
      (mockClientHandlers.authorize as Mock).mockResolvedValueOnce(false);
      const updateMessage: IdentityUpdateMessage = {
        type: NexusMessageType.IDENTITY_UPDATE,
        id: null,
        updates: { context: "admin" },
      };

      hostConnection.sendMessage(updateMessage);

      await vi.waitFor(() => {
        expect(mockClientHandlers.authorize).toHaveBeenCalledWith(
          expect.objectContaining<ConnectionAuthContext<TestAdapterModel>>({
            localIdentity: clientMeta,
            remoteIdentity: { ...hostMeta, context: "admin" },
            connection: hostConnectionMeta,
            direction: "outgoing",
          }),
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
          { onLogicalMessage: vi.fn(), onDisconnect: vi.fn() },
          { chunkSize: Infinity },
        ),
        mockClientHandlers,
        {
          connectionId: "conn-fresh",
          localEndpointMeta: clientMeta,
          connectionMeta: hostConnectionMeta,
          direction: "incoming",
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
      (mockClientHandlers.authorize as Mock).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstVerify = resolve;
          }),
      );
      (mockClientHandlers.authorize as Mock).mockResolvedValueOnce(true);

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
        expect(mockClientHandlers.authorize).toHaveBeenCalledTimes(1);
      });
      expect(clientConnection.remoteIdentity).toEqual(hostMeta);

      resolveFirstVerify?.(true);

      await vi.waitFor(() => {
        expect(mockClientHandlers.authorize).toHaveBeenCalledTimes(2);
        expect(clientConnection.remoteIdentity).toEqual({
          ...hostMeta,
          id: 10,
          context: "latest",
        });
      });
      expect(mockClientHandlers.onIdentityUpdated).toHaveBeenNthCalledWith(
        1,
        clientConnection,
        { ...hostMeta, id: 10 },
        hostMeta,
      );
      expect(mockClientHandlers.onIdentityUpdated).toHaveBeenNthCalledWith(
        2,
        clientConnection,
        { ...hostMeta, id: 10, context: "latest" },
        { ...hostMeta, id: 10 },
      );
    });

    it("should forward service messages only after earlier identity update authorization completes", async () => {
      let resolveVerify: ((value: boolean) => void) | undefined;
      (mockClientHandlers.authorize as Mock).mockImplementationOnce(
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
        expect(mockClientHandlers.authorize).toHaveBeenCalledOnce();
      });
      expect(mockClientHandlers.onMessage).not.toHaveBeenCalled();

      resolveVerify?.(true);

      await vi.waitFor(() => {
        expect(clientConnection.remoteIdentity).toEqual({
          ...hostMeta,
          id: 42,
        });
        expect(mockClientHandlers.onMessage).toHaveBeenCalledWith(
          clientConnection,
          applyMessage,
        );
      });
    });

    it("should forward responses while an earlier identity update authorization is pending", async () => {
      let resolveVerify: ((value: boolean) => void) | undefined;
      (mockClientHandlers.authorize as Mock).mockImplementationOnce(
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
        expect(mockClientHandlers.authorize).toHaveBeenCalledOnce();
        expect(mockClientHandlers.onMessage).toHaveBeenCalledWith(
          clientConnection,
          responseMessage,
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
      if (result.isErr()) expect(result.error).toBe(error);
    });
  });
});
