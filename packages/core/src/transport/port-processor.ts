import { NexusMessageType, type NexusMessage } from "../types/message.js";
import type { IPort } from "./types/port.js";
import type { ISerializer } from "./serializers/interface.js";
import type { ByteReservationLease } from "../service/payload/byte-reservation.js";
import { NexusProtocolError } from "../errors/transport-errors.js";
import { Result } from "better-result";
import {
  concatChunks,
  isChunkControl,
  isApplicationPacketKind,
  CHUNK_WINDOW,
  type Reassembly,
} from "./chunking.js";
import { DEFAULT_TRANSPORT_LIMITS } from "./transport-config.js";
const { err, ok } = Result;
const MAX_QUEUED_SENDS = 1024;
type SendOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  lease?: ByteReservationLease;
};

export interface PortProcessorHandlers {
  /** Receive a decoded packet; registration may synchronously replay buffered data. */
  onLogicalMessage: (message: NexusMessage) => void | Promise<void>;
  /** Handle native disconnect; session owners must tolerate repeated notifications. */
  onDisconnect: () => void;
  /** Handle malformed packets; the session owner decides whether to close. */
  onProtocolError?: (error: NexusProtocolError) => void;
}

export function isDeterminateTransferError(
  error: Error,
): error is NexusProtocolError {
  return (
    error instanceof NexusProtocolError &&
    error.context?.transferOutcome === "determinate"
  );
}

export namespace PortProcessor {
  export interface Context {
    /** Serialize and submit one logical message through the native port. */
    sendMessage(
      message: NexusMessage,
      options?: SendOptions,
    ): Promise<Result<void, NexusProtocolError>>;
    /** Close the native port, returning any native exception as a protocol error. */
    close(): Result<void, NexusProtocolError>;
    /** Buffer decoded ingress during the native READY submission window. */
    beginActivation?(
      packetMode?: "json" | "binary",
    ): Result<void, NexusProtocolError>;
    /** Release buffered ingress once the connection publishes as ready. */
    completeActivation?(): void;
    /** Apply limits agreed during the handshake before application traffic. */
    activateSession?(limits: {
      maxFrameBytes: number;
      maxMessageBytes: number;
      packetMode?: "json" | "binary";
    }): Result<void, NexusProtocolError>;
  }

  export interface CreateOptions {
    maxFrameBytes?: number;
    maxMessageBytes?: number;
    maxBufferedBytes?: number;
    timeoutMs?: number;
    reserveBytes?: (bytes: number) => boolean;
    releaseBytes?: (bytes: number) => void;
    bootstrapJson?: boolean;
    jsonSerializer?: ISerializer;
    binarySerializer?: ISerializer;
    transferables?: boolean;
  }

  /**
   * Bind codec and native events to a port. Subscribes synchronously and takes
   * ownership of cleanup if subscription fails; rethrows the original setup error.
   */
  export const create = (
    port: IPort,
    serializer: ISerializer,
    handlers: PortProcessorHandlers,
    options: CreateOptions = {},
  ): Context => {
    const configuredMaxFrameBytes = Math.min(
      options.maxFrameBytes ?? DEFAULT_TRANSPORT_LIMITS.maxFrameBytes,
      port.maxPacketBytes ?? Infinity,
    );
    const configuredMaxMessageBytes =
      options.maxMessageBytes ?? DEFAULT_TRANSPORT_LIMITS.maxMessageBytes;
    let maxFrameBytes = configuredMaxFrameBytes;
    let maxMessageBytes = configuredMaxMessageBytes;
    const maxBufferedBytes =
      options.maxBufferedBytes ?? DEFAULT_TRANSPORT_LIMITS.maxBufferedBytes;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const encoder = new TextEncoder();
    let transferId = 1;
    let lastInboundId = 0;
    let reassembly: Reassembly | undefined;
    let reassemblyTimer: ReturnType<typeof setTimeout> | undefined;
    let reservedBytes = 0;
    let activationPending = false;
    let activationBytes = 0;
    const activationQueue: { rawMessage: unknown; bytes: number }[] = [];
    const activationByteLimit = 1024 * 1024;
    const activationItemLimit = 256;
    const reserveBytes = (bytes: number) => {
      if (reservedBytes + bytes > maxBufferedBytes) return false;
      if (options.reserveBytes && !options.reserveBytes(bytes)) return false;
      reservedBytes += bytes;
      return true;
    };
    const releaseBytes = (bytes: number) => {
      reservedBytes = Math.max(0, reservedBytes - bytes);
      options.releaseBytes?.(bytes);
    };
    const controlBudget = 16 * 1024;
    const waiters = new Map<
      number,
      {
        resolve: (result: Result<void, NexusProtocolError>) => void;
        offsets: number[];
        sentOffset: number;
        lastAckOffset: number;
        startAccepted: boolean;
        finalDataAttempted: boolean;
        packet: Uint8Array;
        pumping: boolean;
      }
    >();
    // The waiter owns its packet reservation. Removing it settles and releases
    // once, including reentrant or late ACK/CANCEL and disconnect callbacks.
    const settleTransfer = (
      id: number,
      result: Result<void, NexusProtocolError>,
    ) => {
      const waiter = waiters.get(id);
      if (!waiter) return;
      waiters.delete(id);
      releaseBytes(waiter.packet.byteLength);
      waiter.resolve(result);
    };

    const rawSize = (packet: string | ArrayBuffer): number =>
      typeof packet === "string"
        ? encoder.encode(packet).byteLength
        : packet.byteLength;
    const jsonSerializer = options.jsonSerializer ?? serializer;
    const binarySerializer = options.binarySerializer ?? serializer;
    let bootstrapPending = options.bootstrapJson === true;
    let activationPacketMode: "json" | "binary" | undefined;
    let sessionMode: "json" | "binary" =
      serializer.packetType === "arraybuffer" ? "binary" : "json";
    const activeSerializer = () =>
      sessionMode === "binary" ? binarySerializer : jsonSerializer;
    const isBootstrapMessage = (message: NexusMessage) =>
      message.type === NexusMessageType.HANDSHAKE_REQ ||
      message.type === NexusMessageType.HANDSHAKE_ACK ||
      message.type === NexusMessageType.HANDSHAKE_READY;
    const decodePacket = (packet: string | ArrayBuffer) => {
      const selected = bootstrapPending
        ? activationPacketMode === "binary" && packet instanceof ArrayBuffer
          ? binarySerializer
          : jsonSerializer
        : activeSerializer();
      return selected.safeDeserialize(packet);
    };
    const dispatchLogical = (message: NexusMessage) =>
      Result.tryPromise({
        try: async () => handlers.onLogicalMessage(message),
        catch: (error) =>
          new NexusProtocolError("Logical message dispatch failed", {
            originalError: error,
          }),
      }).then((result) => {
        if (result.isErr()) handlers.onProtocolError?.(result.error);
      });
    const drainActivationQueue = () => {
      const messages = activationQueue.splice(0);
      activationBytes = 0;
      for (const item of messages) {
        releaseBytes(item.bytes);
        handleRawMessage(item.rawMessage);
      }
    };
    const sendRaw = async (
      packet: string | ArrayBuffer,
      signal?: AbortSignal,
    ): Promise<Result<void, NexusProtocolError>> => {
      const frameBytes = rawSize(packet);
      if (frameBytes > maxFrameBytes)
        return err(
          new NexusProtocolError(
            "Encoded transport frame exceeds configured limit",
            { frameBytes, maxFrameBytes },
          ),
        );
      return safePostMessage(packet, signal);
    };
    const sendControl = async (message: NexusMessage, signal?: AbortSignal) => {
      const selected =
        bootstrapPending && isBootstrapMessage(message)
          ? jsonSerializer
          : activeSerializer();
      const serialized = selected.safeSerialize(message);
      if (serialized.isErr()) return serialized;
      if (rawSize(serialized.value) > controlBudget)
        return err(
          new NexusProtocolError("Chunk control packet exceeds control budget"),
        );
      return sendRaw(serialized.value, signal);
    };
    const submitControl = async (
      message: NexusMessage,
      signal?: AbortSignal,
    ) => {
      const sent = await sendControl(message, signal);
      if (sent.isErr()) handlers.onProtocolError?.(sent.error);
      return sent;
    };
    const rejectTransfer = (
      id: number,
      reason: "rejected" | "cancelled" | "timeout" | "uncertain",
    ) => {
      settleTransfer(
        id,
        err(
          new NexusProtocolError(
            reason === "uncertain"
              ? "Chunk transfer may have been committed"
              : `Chunk transfer ${reason}`,
            {
              code: reason === "uncertain" ? "E_TRANSFER_UNCERTAIN" : undefined,
              transferOutcome:
                reason === "uncertain" ? "uncertain" : "determinate",
              reason,
              id,
            },
          ),
        ),
      );
    };
    const cleanup = () => {
      for (const id of waiters.keys()) {
        settleTransfer(
          id,
          err(
            new NexusProtocolError("Port disconnected during chunk transfer", {
              id,
            }),
          ),
        );
      }
      if (reassembly) releaseBytes(reassembly.reservedBytes);
      reassembly = undefined;
      clearTimeout(reassemblyTimer);
      reassemblyTimer = undefined;
    };
    const safePostMessage = async (
      packet: string | ArrayBuffer,
      signal?: AbortSignal,
    ): Promise<Result<void, NexusProtocolError>> => {
      try {
        const transfer =
          packet instanceof ArrayBuffer && options.transferables !== false
            ? [packet]
            : undefined;
        await port.postMessage(packet, transfer, signal);
        return ok(undefined);
      } catch (error) {
        return err(
          new NexusProtocolError(
            `Failed to post transport packet: ${error instanceof Error ? error.message : String(error)}`,
            { originalError: error },
          ),
        );
      }
    };

    const sendMessageNow = async (
      message: NexusMessage,
      options: SendOptions = {},
    ): Promise<Result<void, NexusProtocolError>> => {
      const selected =
        bootstrapPending && isBootstrapMessage(message)
          ? jsonSerializer
          : activeSerializer();
      const serialized = selected.safeSerialize(message, {
        lease: options.lease,
      });
      if (serialized.isErr()) return serialized;
      if (options.signal?.aborted)
        return err(
          new NexusProtocolError("Transport send aborted before submission", {
            code: "E_CALL_TIMEOUT",
            transferOutcome: "determinate",
          }),
        );
      const bytes =
        typeof serialized.value === "string"
          ? encoder.encode(serialized.value)
          : new Uint8Array(serialized.value);
      if (bytes.byteLength > maxMessageBytes)
        return err(
          new NexusProtocolError("Encoded message exceeds configured limit", {
            messageBytes: bytes.byteLength,
            maxMessageBytes,
          }),
        );
      if (bytes.byteLength <= maxFrameBytes)
        return sendRaw(serialized.value, options.signal);
      if (!isApplicationPacketKind(message))
        return err(
          new NexusProtocolError("Control packet exceeds frame limit", {
            messageType: message.type,
          }),
        );
      if (!reserveBytes(bytes.byteLength))
        return err(
          new NexusProtocolError("Transport buffer capacity exceeded", {
            code: "E_TRANSPORT_CAPACITY",
            transferOutcome: "determinate",
          }),
        );
      if (transferId > Number.MAX_SAFE_INTEGER) {
        releaseBytes(bytes.byteLength);
        return err(new NexusProtocolError("Chunk transfer ID exhausted"));
      }
      const id = transferId++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      try {
        return await new Promise<Result<void, NexusProtocolError>>(
          (resolve) => {
            const state = {
              resolve,
              offsets: [] as number[],
              sentOffset: 0,
              lastAckOffset: 0,
              startAccepted: false,
              finalDataAttempted: false,
              packet: bytes,
              pumping: false,
            };
            waiters.set(id, state);
            const cancelTransfer = (reason: "cancelled" | "timeout") => {
              void submitControl({
                type: NexusMessageType.CHUNK_CANCEL,
                id,
                version: 1,
                reason,
              });
              rejectTransfer(
                id,
                state.finalDataAttempted ? "uncertain" : reason,
              );
              if (state.finalDataAttempted)
                handlers.onProtocolError?.(
                  new NexusProtocolError("Transfer outcome is uncertain", {
                    code: "E_TRANSFER_UNCERTAIN",
                    id,
                  }),
                );
            };
            const abort = () => cancelTransfer("cancelled");
            if (options.signal?.aborted) return rejectTransfer(id, "cancelled");
            options.signal?.addEventListener("abort", abort, { once: true });
            abortListener = () =>
              options.signal?.removeEventListener("abort", abort);
            timer = setTimeout(
              () => cancelTransfer("timeout"),
              options.timeoutMs ?? timeoutMs,
            );
            const start = submitControl(
              {
                type: NexusMessageType.CHUNK_START,
                id,
                version: 1,
                packetKind: message.type,
                totalBytes: bytes.byteLength,
              },
              options.signal,
            );
            void start.then((result) => {
              if (result.isErr()) return rejectTransfer(id, "rejected");
            });
          },
        );
      } finally {
        if (timer) clearTimeout(timer);
        abortListener?.();
      }
    };

    let sending = false;
    const queuedSends: {
      message: NexusMessage;
      options: SendOptions;
      resolve: (result: Result<void, NexusProtocolError>) => void;
    }[] = [];
    const pumpSends = async () => {
      if (sending) return;
      sending = true;
      try {
        while (queuedSends.length) {
          const queued = queuedSends.shift()!;
          if (queued.options.signal?.aborted) {
            queued.resolve(
              err(
                new NexusProtocolError("Queued transport send was aborted", {
                  code: "E_CALL_TIMEOUT",
                }),
              ),
            );
            continue;
          }
          queued.resolve(await sendMessageNow(queued.message, queued.options));
        }
      } finally {
        sending = false;
        if (queuedSends.length) void pumpSends();
      }
    };
    const sendMessage = (
      message: NexusMessage,
      options: SendOptions = {},
    ): Promise<Result<void, NexusProtocolError>> =>
      new Promise((resolve) => {
        if (sending && queuedSends.length >= MAX_QUEUED_SENDS) {
          const error = new NexusProtocolError(
            "Transport send queue capacity exceeded",
            { code: "E_TRANSPORT_CAPACITY" },
          );
          resolve(err(error));
          handlers.onProtocolError?.(error);
        } else {
          queuedSends.push({ message, options, resolve });
          void pumpSends();
        }
      });

    const failTransferProtocol = (id: number, error: NexusProtocolError) => {
      settleTransfer(id, err(error));
      handlers.onProtocolError?.(error);
    };

    const handleRawMessage = (rawMessage: any): void => {
      const frameBytes =
        typeof rawMessage === "string"
          ? encoder.encode(rawMessage).byteLength
          : rawMessage instanceof ArrayBuffer
            ? rawMessage.byteLength
            : Number.POSITIVE_INFINITY;
      if (frameBytes > maxFrameBytes) {
        handlers.onProtocolError?.(
          new NexusProtocolError(
            "Received transport frame exceeds configured limit",
            { frameBytes, maxFrameBytes },
          ),
        );
        return;
      }
      if (activationPending) {
        if (
          activationQueue.length >= activationItemLimit ||
          activationBytes + frameBytes > activationByteLimit
        ) {
          handlers.onProtocolError?.(
            new NexusProtocolError("READY activation ingress queue exceeded"),
          );
          return;
        }
        if (!reserveBytes(frameBytes)) {
          handlers.onProtocolError?.(
            new NexusProtocolError("Inbound transport capacity exceeded", {
              code: "E_TRANSPORT_CAPACITY",
            }),
          );
          return;
        }
        const decoded = decodePacket(rawMessage);
        if (decoded.isErr()) {
          releaseBytes(frameBytes);
          handlers.onProtocolError?.(decoded.error);
          return;
        }
        if (
          isChunkControl(decoded.value) &&
          decoded.value.type !== NexusMessageType.CHUNK_ACK &&
          decoded.value.type !== NexusMessageType.CHUNK_CANCEL
        ) {
          releaseBytes(frameBytes);
          handlers.onProtocolError?.(
            new NexusProtocolError(
              "Chunk START/DATA is invalid during READY activation",
            ),
          );
          return;
        }
        activationQueue.push({ rawMessage, bytes: frameBytes });
        activationBytes += frameBytes;
        return;
      }
      if (!reserveBytes(frameBytes)) {
        handlers.onProtocolError?.(
          new NexusProtocolError("Inbound transport capacity exceeded", {
            code: "E_TRANSPORT_CAPACITY",
            frameBytes,
          }),
        );
        return;
      }
      const deserialized = decodePacket(rawMessage);
      if (deserialized.isErr()) {
        releaseBytes(frameBytes);
        handlers.onProtocolError?.(deserialized.error);
        return;
      }

      const message = deserialized.value;
      if (isChunkControl(message)) {
        releaseBytes(frameBytes);
        if (message.type === NexusMessageType.CHUNK_ACK) {
          const waiter = waiters.get(message.id);
          if (!waiter) return;
          if (message.committed) {
            if (
              !waiter.startAccepted ||
              waiter.sentOffset === 0 ||
              message.offset !== waiter.sentOffset
            )
              return failTransferProtocol(
                message.id,
                new NexusProtocolError("Invalid final chunk acknowledgment"),
              );
            settleTransfer(message.id, ok(undefined));
            return;
          }
          if (message.offset === 0) {
            if (waiter.startAccepted) return;
            waiter.startAccepted = true;
            void pump(message.id);
            return;
          }
          if (message.offset <= waiter.lastAckOffset) return;
          const boundaryIndex = waiter.offsets.indexOf(message.offset);
          if (boundaryIndex < 0)
            return failTransferProtocol(
              message.id,
              new NexusProtocolError("ACK does not match a sent DATA boundary"),
            );
          waiter.offsets.splice(0, boundaryIndex + 1);
          waiter.lastAckOffset = message.offset;
          void pump(message.id);
          return;
        }
        if (message.type === NexusMessageType.CHUNK_CANCEL) {
          if (message.id >= transferId && message.id > lastInboundId) {
            handlers.onProtocolError?.(
              new NexusProtocolError("CANCEL references a future transfer ID"),
            );
            return;
          }
          settleTransfer(
            message.id,
            err(
              new NexusProtocolError(
                `Chunk transfer cancelled: ${message.reason}`,
                { reason: message.reason, transferOutcome: "determinate" },
              ),
            ),
          );
          if (reassembly?.id === message.id) {
            releaseBytes(reassembly.reservedBytes);
            reassembly = undefined;
            clearTimeout(reassemblyTimer);
            reassemblyTimer = undefined;
          }
          return;
        }
        if (message.type === NexusMessageType.CHUNK_START) {
          const expectedId = message.id === lastInboundId + 1;
          if (expectedId) lastInboundId = message.id;
          const refuseCapacity = () =>
            submitControl({
              type: NexusMessageType.CHUNK_CANCEL,
              id: message.id,
              version: 1,
              reason: "capacity",
            });
          if (
            !expectedId ||
            reassembly ||
            message.totalBytes > maxMessageBytes ||
            reservedBytes + message.totalBytes > maxBufferedBytes
          ) {
            void refuseCapacity();
            return;
          }
          if (!reserveBytes(message.totalBytes)) {
            void refuseCapacity();
            return;
          }
          reassembly = {
            id: message.id,
            packetKind: message.packetKind,
            totalBytes: message.totalBytes,
            reservedBytes:
              message.totalBytes *
              (activeSerializer().packetType === "string" ? 2 : 3),
            chunks: [],
            receivedBytes: 0,
            receivedFrames: 0,
          };
          const extraReservation =
            reassembly.reservedBytes - message.totalBytes;
          if (extraReservation > 0 && !reserveBytes(extraReservation)) {
            releaseBytes(message.totalBytes);
            reassembly = undefined;
            void refuseCapacity();
            return;
          }
          reassemblyTimer = setTimeout(() => {
            if (reassembly?.id !== message.id) return;
            releaseBytes(reassembly.reservedBytes);
            reassembly = undefined;
            reassemblyTimer = undefined;
          }, timeoutMs);
          void submitControl({
            type: NexusMessageType.CHUNK_ACK,
            id: message.id,
            version: 1,
            offset: 0,
            committed: false,
          });
          return;
        }
        if (message.type === NexusMessageType.CHUNK_DATA) {
          const active = reassembly;
          if (message.id <= lastInboundId && active?.id !== message.id) return;
          const data =
            message.data instanceof ArrayBuffer
              ? new Uint8Array(message.data)
              : message.data;
          if (
            !active ||
            active.id !== message.id ||
            message.offset !== active.receivedBytes ||
            data.byteLength > maxFrameBytes ||
            active.receivedBytes + data.byteLength > active.totalBytes
          ) {
            handlers.onProtocolError?.(
              new NexusProtocolError("Invalid chunk DATA sequence"),
            );
            return;
          }
          active.chunks.push(new Uint8Array(data));
          active.receivedBytes += data.byteLength;
          active.receivedFrames++;
          if (active.receivedBytes === active.totalBytes) {
            try {
              const assembled = concatChunks(active.chunks, active.totalBytes);
              const raw: string | ArrayBuffer =
                activeSerializer().packetType === "string"
                  ? new TextDecoder().decode(assembled)
                  : (assembled.buffer as ArrayBuffer);
              const decoded = activeSerializer().safeDeserialize(raw);
              if (decoded.isErr() || decoded.value.type !== active.packetKind)
                throw decoded.isErr()
                  ? decoded.error
                  : new TypeError("Chunk packet kind mismatch");
              reassembly = undefined;
              clearTimeout(reassemblyTimer);
              reassemblyTimer = undefined;
              void submitControl({
                type: NexusMessageType.CHUNK_ACK,
                id: active.id,
                version: 1,
                offset: active.totalBytes,
                committed: true,
              }).then((ack) => {
                if (ack.isErr()) {
                  releaseBytes(active.reservedBytes);
                } else {
                  void dispatchLogical(decoded.value).finally(() => {
                    releaseBytes(active.reservedBytes);
                  });
                }
              });
            } catch (error) {
              releaseBytes(active.reservedBytes);
              reassembly = undefined;
              clearTimeout(reassemblyTimer);
              reassemblyTimer = undefined;
              handlers.onProtocolError?.(
                new NexusProtocolError(
                  "Failed to reassemble transport packet",
                  { originalError: error },
                ),
              );
            }
          } else if (active.receivedFrames % CHUNK_WINDOW === 0) {
            void submitControl({
              type: NexusMessageType.CHUNK_ACK,
              id: active.id,
              version: 1,
              offset: active.receivedBytes,
              committed: false,
            });
          }
          return;
        }
      }
      if (isApplicationPacketKind(message)) {
        void dispatchLogical(message).finally(() => releaseBytes(frameBytes));
        return;
      }
      releaseBytes(frameBytes);
      void dispatchLogical(message);
    };

    const pump = async (id: number): Promise<void> => {
      const waiter = waiters.get(id);
      if (!waiter || waiter.pumping) return;
      const current = waiter.packet;
      waiter.pumping = true;
      try {
        const inflight = waiter.offsets.length;
        const chunkCapacity = Math.max(1, maxFrameBytes - 256);
        let offset = waiter.sentOffset;
        for (
          let i = inflight;
          i < CHUNK_WINDOW && offset < current.byteLength;
          i++
        ) {
          let end = Math.min(current.byteLength, offset + chunkCapacity);
          let encoded: Result<string | ArrayBuffer, NexusProtocolError>;
          for (;;) {
            const data = current.slice(offset, end);
            encoded = activeSerializer().safeSerialize({
              type: NexusMessageType.CHUNK_DATA,
              id,
              version: 1,
              offset,
              data,
            });
            if (encoded.isErr()) {
              settleTransfer(id, err(encoded.error));
              return;
            }
            if (rawSize(encoded.value) <= maxFrameBytes) break;
            const excess = rawSize(encoded.value) - maxFrameBytes;
            const nextEnd = end - Math.max(excess, 1);
            if (nextEnd <= offset) {
              settleTransfer(
                id,
                err(
                  new NexusProtocolError(
                    "Frame limit cannot fit a chunk envelope",
                  ),
                ),
              );
              return;
            }
            end = nextEnd;
          }
          const submittedOffset = end;
          offset = submittedOffset;
          waiter.sentOffset = offset;
          waiter.offsets.push(offset);
          if (submittedOffset === current.byteLength)
            waiter.finalDataAttempted = true;
          const sent = await safePostMessage(encoded.value);
          // Cancellation or disconnect can settle this transfer during a native
          // write. Its captured waiter must not submit another DATA window.
          if (waiters.get(id) !== waiter) return;
          if (sent.isErr()) {
            const failure = waiter.finalDataAttempted
              ? new NexusProtocolError(
                  "Final DATA submission failed; transfer outcome is uncertain",
                  {
                    code: "E_TRANSFER_UNCERTAIN",
                    originalError: sent.error,
                  },
                )
              : sent.error;
            settleTransfer(id, err(failure));
            if (waiter.finalDataAttempted) cleanup();
            handlers.onProtocolError?.(failure);
            return;
          }
        }
      } finally {
        waiter.pumping = false;
      }
      const currentWaiter = waiters.get(id);
      if (
        currentWaiter &&
        currentWaiter.offsets.length < CHUNK_WINDOW &&
        currentWaiter.sentOffset < currentWaiter.packet.byteLength
      )
        await pump(id);
    };

    // Subscribe to disconnect first: onMessage may synchronously replay data.
    // Until both subscriptions succeed, this factory still owns the raw port.
    const subscribed = Result.try({
      try: () => {
        port.onDisconnect(() => {
          cleanup();
          handlers.onDisconnect();
        });
        port.onMessage(handleRawMessage);
      },
      catch: (error) => error,
    });
    if (subscribed.isErr()) {
      Result.try({ try: () => port.close(), catch: (error) => error }).match({
        ok: () => undefined,
        err: (error) =>
          console.error(
            "Nexus DEV: failed to close partially subscribed port",
            error,
          ),
      });
      // Preserve the original setup failure at this throw-style factory boundary.
      throw subscribed.error;
    }

    return {
      sendMessage,
      beginActivation: (packetMode) => {
        if (activationPending)
          return err(
            new NexusProtocolError("READY activation already pending"),
          );
        activationPending = true;
        activationPacketMode = packetMode;
        if (packetMode) sessionMode = packetMode;
        return ok(undefined);
      },
      activateSession: (limits) => {
        if (
          limits.maxFrameBytes > configuredMaxFrameBytes ||
          limits.maxMessageBytes > configuredMaxMessageBytes ||
          limits.maxFrameBytes <= 0 ||
          limits.maxMessageBytes <= 0
        )
          return err(
            new NexusProtocolError("Negotiated transport limits are invalid"),
          );
        maxFrameBytes = limits.maxFrameBytes;
        maxMessageBytes = limits.maxMessageBytes;
        if (limits.packetMode) sessionMode = limits.packetMode;
        if (!activationPending) bootstrapPending = false;
        return ok(undefined);
      },
      completeActivation: () => {
        activationPending = false;
        bootstrapPending = false;
        drainActivationQueue();
      },
      close: () => {
        try {
          cleanup();
          activationPending = false;
          for (const item of activationQueue.splice(0))
            releaseBytes(item.bytes);
          activationBytes = 0;
          const error = new NexusProtocolError(
            "Transport closed before queued send",
            { code: "E_CONN_CLOSED" },
          );
          for (const queued of queuedSends.splice(0))
            queued.resolve(err(error));
          port.close();
          return ok(undefined);
        } catch (error) {
          return err(
            new NexusProtocolError(
              `Failed to close transport port: ${error instanceof Error ? error.message : String(error)}`,
              { originalError: error },
            ),
          );
        }
      },
    };
  };
}
