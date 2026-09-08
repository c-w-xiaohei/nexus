import { Result } from "better-result";
import {
  NexusMessageType,
  type ApplyMessage,
  type GetMessage,
  type SetMessage,
} from "@/types/message";
import {
  NexusDisconnectedError,
  NexusRemoteError,
  NexusTargetingError,
} from "@/errors/call-errors";
import type { PayloadProcessor } from "./payload/payload-processor";
import type { PendingCallManager } from "./pending-call-manager";
import type { AdapterModel } from "@/types/adapter-model";
import type { Engine } from "./engine";

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** Acquisition-time session snapshot. Calls never resolve or select recipients again. */
export type CallBinding = { timeout: number } & (
  | { target: { connectionId: string }; strategy: "one" }
  | { target: { connectionIds: readonly string[] }; strategy: "all" | "stream" }
);

export type ProxyOperation = { path: (string | number)[] } & (
  | { type: "GET" }
  | { type: "SET"; value: any }
  | { type: "APPLY"; args: any[] }
);

export type DispatchCallOptions = CallBinding &
  ProxyOperation & {
    resourceId: string | null;
  };

/** Dispatches fixed-session calls using shared methods and one Engine's dependencies. */
export class CallProcessor {
  private messageIdSeq = 1;

  constructor(
    private readonly deps: {
      getReadyConnectionIds(
        target: CallBinding["target"],
      ): Result<string[], Error>;
      sendMessage: Engine<AdapterModel>["safeSendMessage"];
      payloadProcessor: PayloadProcessor;
      pendingCallManager: PendingCallManager;
    },
  ) {}

  /**
   * Dispatches one operation to its bound sessions using caller-owned dependencies.
   * Registers pending before sending and allocates capabilities per recipient.
   * Returns a value for one, ordered settlements for all, or a cancellable stream.
   * Partial dispatch failure keeps capabilities already handed to earlier recipients.
   */
  public safeProcess(
    options: DispatchCallOptions,
  ): Promise<Result<any, Error>> {
    const deps = this.deps;
    return Result.tryPromise({
      try: async (): Promise<Result<any, Error>> => {
        // 1. Validate the complete fixed binding before allocating call state.
        const ready = deps.getReadyConnectionIds(options.target);
        if (ready.isErr()) return Result.err(ready.error);
        const connectionIds = ready.value;
        const boundIds =
          "connectionId" in options.target
            ? [options.target.connectionId]
            : options.target.connectionIds;
        // Exact sends recheck later: earlier sends can close another session synchronously.
        if (
          connectionIds.length !== boundIds.length ||
          connectionIds.some((id, index) => id !== boundIds[index])
        ) {
          return Result.err(
            new NexusDisconnectedError(
              "Call failed. A bound connection was closed or is no longer available.",
              "E_CONN_CLOSED",
              { path: options.path },
            ),
          );
        }
        if (connectionIds.length === 0) {
          return Result.ok(
            options.strategy === "stream" ? (async function* () {})() : [],
          );
        }

        // 2. Establish the consumer before any reentrant transport can reply.
        const id = this.messageIdSeq++;
        const pendingOptions = {
          isBroadcast: options.strategy !== "one",
          sentConnectionIds: connectionIds,
          timeout: options.timeout,
        };
        const pending =
          options.strategy === "stream"
            ? deps.pendingCallManager.register(id, {
                ...pendingOptions,
                strategy: "stream",
              })
            : deps.pendingCallManager.register(id, {
                ...pendingOptions,
                strategy: "all",
              });

        // 3. Each handoff has independent capability ownership and rollback.
        for (const connectionId of connectionIds) {
          const sent = this.safeSend(options, connectionId, id);
          if (sent.isErr()) {
            deps.pendingCallManager.fail(id, sent.error);
            return sent;
          }
        }

        // 4. Keep multicast semantics even for one recipient; unwrap only unicast.
        if (!(pending instanceof Promise)) return Result.ok(pending);
        const result = await pending;
        if (result.isErr() || options.strategy === "all") return result;
        const [settled] = result.value;
        if (result.value.length !== 1 || !settled) {
          return Result.err(
            new NexusTargetingError(
              "Expected exactly one result for a unicast call.",
              "E_TARGET_UNEXPECTED_COUNT",
              { expected: 1, received: result.value.length },
            ),
          );
        }
        return settled.status === "fulfilled"
          ? Result.ok(settled.value)
          : Result.err(
              new NexusRemoteError(
                `Remote call failed: ${settled.reason?.message || "Unknown error"}`,
                "E_REMOTE_EXCEPTION",
                { remoteError: settled.reason },
              ),
            );
      },
      catch: toError,
    }).then((result) => result.andThen((value) => value));
  }

  /** Encodes and hands off one recipient's capabilities; earlier accepted handoffs are never rolled back. */
  private safeSend(
    options: DispatchCallOptions,
    connectionId: string,
    id: number,
  ): Result<void, Error> {
    return Result.try({
      try: (): Result<void, Error> => {
        const encoded = buildMessage(
          this.deps.payloadProcessor,
          options,
          connectionId,
          id,
        );
        if (encoded.isErr()) return encoded;
        let delivered = false;
        try {
          const sent = this.deps.sendMessage(encoded.value, connectionId);
          delivered = sent.isOk();
          return sent;
        } finally {
          // A throwing transport has the same ownership outcome as a rejected handoff.
          if (!delivered)
            this.deps.payloadProcessor.releaseSanitizedResources(encoded.value);
        }
      },
      catch: toError,
    }).andThen((result) => result);
  }
}

/** Encodes a fresh message whose callback/ref capabilities belong to one recipient. */
function buildMessage(
  payload: PayloadProcessor,
  options: DispatchCallOptions,
  connectionId: string,
  id: number,
): Result<GetMessage | SetMessage | ApplyMessage, Error> {
  const base = { id, resourceId: options.resourceId, path: options.path };
  switch (options.type) {
    case "GET":
      return Result.ok({ ...base, type: NexusMessageType.GET });
    case "SET":
      return payload
        .safeSanitize([options.value], connectionId)
        .map(([value]) => ({ ...base, type: NexusMessageType.SET, value }));
    case "APPLY":
      return payload
        .safeSanitize(options.args, connectionId)
        .map((args) => ({ ...base, type: NexusMessageType.APPLY, args }));
  }
}
