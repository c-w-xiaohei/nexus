import { Result } from "better-result";
import {
  NexusMessageType,
  type ApplyMessage,
  type GetMessage,
  type NexusMessage,
} from "@/types/message";
import {
  NexusDisconnectedError,
  type NexusCallError,
} from "@/errors/call-errors";
import { toFrameworkProtocolError } from "@/errors/serialized-error";
import type { PayloadProcessor } from "./payload/payload-processor";
import type { PendingCallManager } from "./pending-call-manager";
import { scopeClosedError, type ResourceScope } from "./resource-scope";
import type {
  ByteReservationBudget,
  ByteReservationLease,
} from "./payload/byte-reservation";

export type CallBinding = {
  timeout: number;
  connectionId: string;
  scope?: ResourceScope;
};
export type DispatchCallOptions = CallBinding & {
  path: (string | number)[];
  resourceId: string | null;
} & ({ type: "GET" } | { type: "APPLY"; args: any[] });

/** Dispatches one session-bound operation; collection composition belongs to callers. */
export class CallProcessor {
  private messageIdSeq = 1;

  /** Bind transport, payload, and response ownership dependencies for dispatch. */
  constructor(
    private readonly deps: {
      isConnectionReady(connectionId: string): boolean;
      safeSendMessage(
        message: NexusMessage,
        connectionId: string,
        options?: { lease?: ByteReservationLease; signal?: AbortSignal },
      ): Promise<Result<void, Error>>;
      payloadReservation?: ByteReservationBudget;
      payloadProcessor: Pick<
        PayloadProcessor,
        "safeSanitize" | "releaseSanitizedResources"
      >;
      pendingCallManager: PendingCallManager;
    },
  ) {}

  /** Encode and send one bound operation, returning its session-scoped result. */
  async safeProcess(
    options: DispatchCallOptions,
  ): Promise<Result<any, NexusCallError>> {
    const { connectionId } = options;
    if (!this.deps.isConnectionReady(connectionId))
      return Result.err(
        new NexusDisconnectedError(
          "The bound connection is closed.",
          "E_CONN_CLOSED",
          { connectionId, path: options.path },
        ),
      );
    if (options.scope?.closed)
      return Result.err(scopeClosedError(options.scope));
    const id = this.messageIdSeq++;
    const abort = new AbortController();
    let settled = false;
    const pending = this.deps.pendingCallManager.register(id, {
      connectionId,
      timeout: options.timeout,
      ...(options.scope ? { scope: options.scope } : {}),
      onSettled: (result) => {
        settled = true;
        if (
          options.scope?.closed ||
          (result.isErr() && result.error.code === "E_CALL_TIMEOUT")
        )
          abort.abort();
      },
    });
    const stopAbort = options.scope?.onClosed(() => abort.abort());
    let lease: ByteReservationLease | undefined;
    let sent: Result<void, Error>;
    try {
      const base = {
        id,
        resourceId: options.resourceId,
        path: options.path,
        ...(options.scope
          ? {
              scopeId: options.scope.id,
              timeoutMs: options.timeout,
              hops: 16,
            }
          : {}),
      };
      let encoded: Result<GetMessage | ApplyMessage, Error>;
      if (options.type === "GET") {
        encoded = Result.ok({ ...base, type: NexusMessageType.GET });
      } else {
        const preparing = this.deps.payloadProcessor.safeSanitize(
          options.args,
          connectionId,
          options.scope,
          {
            reserveBytes:
              this.deps.payloadReservation?.reserveBytes ?? (() => true),
            releaseBytes:
              this.deps.payloadReservation?.releaseBytes ?? (() => {}),
            signal: abort.signal,
            onLease: (value) => {
              lease = value;
              if (settled) value.releaseAll();
            },
          },
        );
        const outcome = await Promise.race([
          preparing.then((result) => ({ kind: "prepared" as const, result })),
          pending.then((result) => ({ kind: "settled" as const, result })),
        ]);
        if (outcome.kind === "settled") {
          stopAbort?.();
          return outcome.result;
        }
        encoded = outcome.result.map((args) => ({
          ...base,
          type: NexusMessageType.APPLY,
          args,
        }));
      }
      if (encoded.isErr()) sent = encoded;
      else {
        let delivered = false;
        try {
          sent = await this.deps.safeSendMessage(encoded.value, connectionId, {
            lease,
            signal: abort.signal,
          });
          delivered = sent.isOk();
        } finally {
          if (!delivered) {
            this.deps.payloadProcessor.releaseSanitizedResources(encoded.value);
            lease?.releaseAll();
          }
        }
      }
    } catch (error) {
      sent = Result.err(toFrameworkProtocolError(error));
    }
    stopAbort?.();
    if (sent.isErr()) this.deps.pendingCallManager.fail(id, sent.error);
    void pending.finally(() => lease?.releaseAll());
    return pending;
  }
}
