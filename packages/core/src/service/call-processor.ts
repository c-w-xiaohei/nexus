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

export type CallBinding = {
  timeout: number;
  connectionId: string;
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
      sendMessage(
        message: NexusMessage,
        connectionId: string,
      ): Result<void, Error>;
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
    const id = this.messageIdSeq++;
    const pending = this.deps.pendingCallManager.register(id, {
      connectionId,
      timeout: options.timeout,
    });
    const sent = Result.try({
      try: () => {
        const base = { id, resourceId: options.resourceId, path: options.path };
        const encoded: Result<GetMessage | ApplyMessage, Error> =
          options.type === "GET"
            ? Result.ok({ ...base, type: NexusMessageType.GET })
            : this.deps.payloadProcessor
                .safeSanitize(options.args, connectionId)
                .map((args) => ({
                  ...base,
                  type: NexusMessageType.APPLY,
                  args,
                }));
        if (encoded.isErr()) return encoded;
        let delivered = false;
        try {
          const result = this.deps.sendMessage(encoded.value, connectionId);
          delivered = result.isOk();
          return result;
        } finally {
          if (!delivered)
            this.deps.payloadProcessor.releaseSanitizedResources(encoded.value);
        }
      },
      catch: toFrameworkProtocolError,
    }).andThen((result) => result);
    if (sent.isErr()) this.deps.pendingCallManager.fail(id, sent.error);
    return pending;
  }
}
