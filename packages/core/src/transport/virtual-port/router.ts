import { err, errAsync, ok, ResultAsync, type Result } from "neverthrow";
import type { IPort } from "../types/port";
import {
  VirtualPortCloseError,
  VirtualPortConnectError,
  VirtualPortListenError,
} from "./errors";
import { VirtualPortProtocol } from "./protocol";
import { createVirtualPort } from "./virtual-port";

type ChannelState = "connecting" | "open" | "closed";

type PendingConnect =
  | { readonly state: "none" }
  | {
      readonly state: "pending";
      readonly resolve: (value: IPort) => void;
      readonly reject: (error: VirtualPortConnectError) => void;
      readonly timeout: ReturnType<typeof setTimeout>;
    };

interface Channel {
  readonly id: string;
  readonly nonce: string;
  readonly port: ReturnType<typeof createVirtualPort>;
  state: ChannelState;
  seq: number;
  missedPongs: number;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  pending: PendingConnect;
}

interface ContextInternals {
  readonly channels: Map<string, Channel>;
  readonly closedChannels: Set<string>;
}

const internals = new WeakMap<VirtualPortRouter.Context, ContextInternals>();

const getInternals = (context: VirtualPortRouter.Context): ContextInternals => {
  const value = internals.get(context);
  if (!value) {
    throw new VirtualPortCloseError("Virtual port router context is invalid");
  }
  return value;
};

export namespace VirtualPortRouter {
  type SendResult = void | Result<void, unknown>;

  export interface Bus {
    send(message: unknown, transfer?: Transferable[]): SendResult;
    subscribe(handler: (message: unknown) => void): () => void;
  }

  export interface HeartbeatOptions {
    readonly enabled?: boolean;
    readonly intervalMs?: number;
    readonly maxMisses?: number;
  }

  export interface Options {
    readonly bus: Bus;
    readonly localId?: string;
    readonly heartbeat?: HeartbeatOptions;
    readonly connectTimeoutMs?: number;
  }

  export interface Context {
    readonly bus: Bus;
    readonly localId: string;
    readonly heartbeat: Required<HeartbeatOptions>;
    readonly connectTimeoutMs: number;
    unsubscribe: () => void;
    listening: boolean;
    onConnectHandler?: (port: IPort) => void;
    closed: boolean;
  }

  export const create = (options: Options): Context => {
    const context: Context = {
      bus: options.bus,
      localId: options.localId ?? createId("vp-local"),
      heartbeat: {
        enabled: options.heartbeat?.enabled ?? true,
        intervalMs: options.heartbeat?.intervalMs ?? 5000,
        maxMisses: options.heartbeat?.maxMisses ?? 3,
      },
      connectTimeoutMs: options.connectTimeoutMs ?? 5000,
      unsubscribe: () => undefined,
      listening: false,
      closed: false,
    };
    internals.set(context, { channels: new Map(), closedChannels: new Set() });

    context.unsubscribe = context.bus.subscribe((message) => {
      try {
        handleMessage(context, message);
      } catch (error) {
        console.error(
          "Nexus DEV: unhandled virtual port bus message error",
          error,
        );
      }
    });

    return context;
  };

  export const safeListen = (
    context: Context,
    onConnect: (port: IPort) => void,
  ): Result<void, VirtualPortListenError> => {
    if (context.closed) {
      return err(new VirtualPortListenError("Virtual port router is closed"));
    }

    context.listening = true;
    context.onConnectHandler = onConnect;
    return ok(undefined);
  };

  export const safeConnect = (
    context: Context,
  ): ResultAsync<IPort, VirtualPortConnectError> => {
    if (context.closed) {
      return errAsync(
        new VirtualPortConnectError("Virtual port router is closed"),
      );
    }

    const channelId = createId("vp-channel");
    const nonce = createId("vp-nonce");
    const channel = createChannel(context, channelId, nonce);
    const promise = new Promise<IPort>((resolve, reject) => {
      const timeout = setTimeout(() => {
        rejectPending(channel, "Virtual port connection timed out", "timeout");
        closeChannel(context, channel, false);
      }, context.connectTimeoutMs);
      channel.pending = { state: "pending", resolve, reject, timeout };
      const sendResult = safeSend(context, {
        ...VirtualPortProtocol.createBase({
          channelId,
          from: context.localId,
          nonce,
        }),
        type: "connect",
      });
      if (sendResult.isErr()) {
        rejectPending(
          channel,
          "Failed to send virtual port connect message",
          undefined,
          sendResult.error,
        );
        closeChannel(context, channel, false);
      }
    });

    return ResultAsync.fromPromise(promise, (error) =>
      error instanceof VirtualPortConnectError
        ? error
        : new VirtualPortConnectError("Failed to connect virtual port", {
            originalError: error,
          }),
    );
  };

  export const safeClose = (
    context: Context,
  ): Result<void, VirtualPortCloseError> => {
    if (context.closed) return ok(undefined);
    let closeError: unknown;
    try {
      context.closed = true;
      context.unsubscribe();
    } catch (error) {
      closeError = error;
    }

    for (const channel of Array.from(getInternals(context).channels.values())) {
      closeChannel(context, channel, true);
    }

    if (closeError) {
      return err(
        new VirtualPortCloseError("Failed to close virtual port router", {
          originalError: closeError,
        }),
      );
    }

    return ok(undefined);
  };
}

const handleMessage = (
  context: VirtualPortRouter.Context,
  rawMessage: unknown,
): void => {
  const result = VirtualPortProtocol.safeClassify(rawMessage);
  if (result.isErr()) return;
  const message = result.value;
  if (message.from === context.localId || context.closed) return;

  if (message.type === "connect") {
    const contextInternals = getInternals(context);
    const existingChannel = contextInternals.channels.get(message.channelId);
    if (existingChannel) {
      if (
        existingChannel.state === "open" &&
        existingChannel.nonce === message.nonce
      ) {
        safeSend(context, {
          ...VirtualPortProtocol.createBase({
            channelId: message.channelId,
            from: context.localId,
            nonce: message.nonce,
          }),
          type: "accept",
        });
      }
      return;
    }

    if (
      !context.listening ||
      contextInternals.closedChannels.has(message.channelId)
    ) {
      safeSend(context, {
        ...VirtualPortProtocol.createBase({
          channelId: message.channelId,
          from: context.localId,
          nonce: message.nonce,
        }),
        type: "reject",
        reason: "listener-unavailable",
      });
      return;
    }

    const channel = createChannel(context, message.channelId, message.nonce);
    channel.state = "open";
    safeSend(context, {
      ...VirtualPortProtocol.createBase({
        channelId: message.channelId,
        from: context.localId,
        nonce: message.nonce,
      }),
      type: "accept",
    });
    startHeartbeat(context, channel);
    try {
      context.onConnectHandler?.(channel.port);
    } catch (error) {
      console.error(
        "Nexus DEV: unhandled error in VirtualPortRouter.safeListen onConnect callback",
        error,
      );
    }
    return;
  }

  const channel = getInternals(context).channels.get(message.channelId);
  if (
    !channel ||
    channel.nonce !== message.nonce ||
    channel.state === "closed"
  ) {
    return;
  }

  switch (message.type) {
    case "accept":
      if (channel.state !== "connecting") return;
      channel.state = "open";
      startHeartbeat(context, channel);
      resolvePending(channel);
      break;
    case "reject":
      if (
        channel.state !== "connecting" ||
        channel.pending.state !== "pending"
      ) {
        return;
      }
      rejectPending(
        channel,
        `Virtual port connection rejected: ${message.reason ?? "unknown"}`,
        message.reason,
      );
      closeChannel(context, channel, false);
      break;
    case "data":
      if (channel.state === "open") channel.port.receive(message);
      break;
    case "close":
      closeChannel(context, channel, false);
      break;
    case "ping":
      if (channel.state !== "open") return;
      safeSend(context, {
        ...VirtualPortProtocol.createBase({
          channelId: channel.id,
          from: context.localId,
          nonce: channel.nonce,
        }),
        type: "pong",
      });
      break;
    case "pong":
      if (channel.state === "open") channel.missedPongs = 0;
      break;
  }
};

const createChannel = (
  context: VirtualPortRouter.Context,
  channelId: string,
  nonce: string,
): Channel => {
  const channel: Channel = {
    id: channelId,
    nonce,
    state: "connecting",
    seq: 0,
    missedPongs: 0,
    port: createVirtualPort(
      (payload, transfer) => {
        const current = getInternals(context).channels.get(channelId);
        if (!current || current.state !== "open") return;
        current.seq += 1;
        safeSend(
          context,
          {
            ...VirtualPortProtocol.createBase({
              channelId,
              from: context.localId,
              nonce,
            }),
            type: "data",
            seq: current.seq,
            payload,
          },
          transfer,
        );
      },
      () => {
        const current = getInternals(context).channels.get(channelId);
        if (current) closeChannel(context, current, true);
      },
    ),
    pending: { state: "none" },
  };
  getInternals(context).channels.set(channelId, channel);
  return channel;
};

const startHeartbeat = (
  context: VirtualPortRouter.Context,
  channel: Channel,
): void => {
  if (!context.heartbeat.enabled) return;
  channel.heartbeatTimer = setInterval(() => {
    if (channel.state !== "open") return;
    channel.missedPongs += 1;
    if (channel.missedPongs >= context.heartbeat.maxMisses) {
      closeChannel(context, channel, false);
      return;
    }
    safeSend(context, {
      ...VirtualPortProtocol.createBase({
        channelId: channel.id,
        from: context.localId,
        nonce: channel.nonce,
      }),
      type: "ping",
    });
  }, context.heartbeat.intervalMs);
};

const closeChannel = (
  context: VirtualPortRouter.Context,
  channel: Channel,
  notifyRemote: boolean,
): void => {
  if (channel.state === "closed") return;
  const contextInternals = getInternals(context);
  channel.state = "closed";
  contextInternals.closedChannels.add(channel.id);
  contextInternals.channels.delete(channel.id);
  if (channel.heartbeatTimer) clearInterval(channel.heartbeatTimer);
  if (notifyRemote) {
    safeSend(context, {
      ...VirtualPortProtocol.createBase({
        channelId: channel.id,
        from: context.localId,
        nonce: channel.nonce,
      }),
      type: "close",
    });
  }
  rejectPending(channel, "Virtual port channel closed before accept");
  channel.port.disconnect();
};

const rejectPending = (
  channel: Channel,
  message: string,
  reason?: string,
  originalError?: unknown,
): void => {
  if (channel.pending.state !== "pending") return;
  clearTimeout(channel.pending.timeout);
  const error = new VirtualPortConnectError(message, {
    channelId: channel.id,
    reason,
    originalError,
  });
  channel.pending.reject(error);
  channel.pending = { state: "none" };
};

const resolvePending = (channel: Channel): void => {
  if (channel.pending.state !== "pending") return;
  clearTimeout(channel.pending.timeout);
  channel.pending.resolve(channel.port);
  channel.pending = { state: "none" };
};

const safeSend = (
  context: VirtualPortRouter.Context,
  message: VirtualPortProtocol.Message,
  transfer?: Transferable[],
): Result<void, unknown> => {
  try {
    const result = context.bus.send(message, transfer);
    if (isResultErr(result)) return err(result.error);
    return ok(undefined);
  } catch (error) {
    return err(error);
  }
};

const isResultErr = (
  value: unknown,
): value is { isErr(): true; error: unknown } =>
  typeof value === "object" &&
  value !== null &&
  "isErr" in value &&
  typeof value.isErr === "function" &&
  value.isErr();

const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
