import type { MessageId, SerializedError } from "@/types/message";
import { Result } from "better-result";
import {
  NexusDisconnectedError,
  NexusCallTimeoutError,
  NexusRemoteError,
} from "@/errors/call-errors";
import { reviveFrameworkError } from "@/errors/serialized-error";
import { toFrameworkProtocolError } from "@/errors/serialized-error";
import {
  NexusError,
  NexusResourceError,
  NexusServiceError,
  NexusProtocolError,
  NexusProtocolIncompatibleError,
  type NexusCallError,
} from "@/errors";

type PendingCall = {
  connectionId: string;
  timeout: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(result: Result<any, NexusCallError>): void;
};

/** Each request belongs to exactly one session. Late replies are handled as orphans. */
export class PendingCallManager {
  private readonly calls = new Map<MessageId, PendingCall>();

  /** Reserve a response slot and start the deadline that owns its failure. */
  register(
    id: MessageId,
    options: { connectionId: string; timeout: number },
  ): Promise<Result<any, NexusCallError>> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () =>
          this.fail(
            id,
            new NexusCallTimeoutError(
              `Call #${id} timed out.`,
              "E_CALL_TIMEOUT",
              { messageId: id, connectionId: options.connectionId },
            ),
          ),
        options.timeout,
      );
      this.calls.set(id, { ...options, timer, resolve });
    });
  }

  /** Accept a response only from the session that created the request. */
  canHandleResponse(id: MessageId, source: string): boolean {
    return this.calls.get(id)?.connectionId === source;
  }

  /** Return a caller's timeout only while its response slot remains owned. */
  getCallTimeout(id: MessageId, source: string): number | undefined {
    const pending = this.calls.get(id);
    return pending?.connectionId === source ? pending.timeout : undefined;
  }

  /** Complete a matching request, reviving framework errors when possible. */
  handleResponse(
    id: MessageId,
    value: any,
    error: SerializedError | null,
    source: string,
  ): void {
    if (!this.canHandleResponse(id, source)) return;
    this.finish(
      id,
      error
        ? Result.err(
            reviveFrameworkError(error) ??
              new NexusRemoteError(
                `Remote call failed: ${error.message}`,
                "E_REMOTE_EXCEPTION",
                { remoteError: error },
              ),
          )
        : Result.ok(value),
    );
  }

  /** Fail every pending request owned by a disconnected session. */
  onDisconnect(connectionId: string): void {
    for (const [id, pending] of this.calls) {
      if (pending.connectionId === connectionId)
        this.fail(
          id,
          new NexusDisconnectedError(
            `Connection "${connectionId}" was closed.`,
            "E_CONN_CLOSED",
            { connectionId, messageId: id },
          ),
        );
    }
  }

  /** Normalize a local failure and settle the request if it is still pending. */
  fail(id: MessageId, error: Error): void {
    let concrete: NexusCallError;
    if (error instanceof NexusServiceError) {
      concrete =
        error.code === "E_SERVICE_UNAVAILABLE"
          ? new NexusServiceError(error.message, "E_SERVICE_UNAVAILABLE", {
              context: error.context,
              cause: error.cause,
              stack: error.stack,
            })
          : toFrameworkProtocolError(error);
    } else if (
      error instanceof NexusDisconnectedError ||
      error instanceof NexusCallTimeoutError ||
      error instanceof NexusRemoteError ||
      error instanceof NexusResourceError ||
      error instanceof NexusProtocolError ||
      error instanceof NexusProtocolIncompatibleError
    ) {
      concrete = error;
    } else if (error instanceof NexusError) {
      concrete = reviveFrameworkError({
        name: error.name,
        message: error.message,
        code: error.code,
        origin: "framework",
      })!;
    } else {
      concrete = toFrameworkProtocolError(error);
    }
    this.finish(id, Result.err(concrete));
  }

  /** Settle once, clear the deadline, and remove the response slot. */
  private finish(id: MessageId, result: Result<any, NexusCallError>): void {
    const pending = this.calls.get(id);
    if (!pending) return;
    this.calls.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }
}
