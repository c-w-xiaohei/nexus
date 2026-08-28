import type { AdapterModel } from "@/types/adapter-model";
import { NexusMessageType } from "@/types/message";
import type { ApplyMessage, GetMessage, SetMessage } from "@/types/message";
import type { DispatchCallOptions } from "./engine";
import { PendingCallManager } from "./pending-call-manager";
import { PayloadProcessor } from "./payload/payload-processor";
import type { MessageTarget } from "@/connection/types";
import type { NexusMessage } from "@/types/message";
import { Logger } from "@/logger";
import { Result } from "better-result";
const { err, ok } = Result;

export namespace CallProcessor {
  type ErrorCode =
    | "E_CONN_CLOSED"
    | "E_REMOTE_EXCEPTION"
    | "E_TARGET_UNEXPECTED_COUNT";

  type ErrorOptions = {
    readonly context?: Record<string, unknown>;
  };

  class BaseError extends globalThis.Error {
    readonly code: ErrorCode;
    readonly context?: Record<string, unknown>;

    constructor(message: string, code: ErrorCode, options: ErrorOptions = {}) {
      super(message);
      this.name = "CallProcessorError";
      this.code = code;
      this.context = options.context;
    }
  }

  class TargetingError extends BaseError {
    constructor(message: string, options: ErrorOptions = {}) {
      super(message, "E_TARGET_UNEXPECTED_COUNT", options);
      this.name = "CallProcessorTargetingError";
    }
  }

  class RemoteError extends BaseError {
    constructor(message: string, options: ErrorOptions = {}) {
      super(message, "E_REMOTE_EXCEPTION", options);
      this.name = "CallProcessorRemoteError";
    }
  }

  class DisconnectedError extends BaseError {
    constructor(message: string, options: ErrorOptions = {}) {
      super(message, "E_CONN_CLOSED", options);
      this.name = "CallProcessorDisconnectedError";
    }
  }

  export const Error = {
    Base: BaseError,
    Targeting: TargetingError,
    Remote: RemoteError,
    Disconnected: DisconnectedError,
  } as const;

  export interface Dependencies<M extends AdapterModel> {
    nextMessageId: () => number;
    getReadyConnectionIds: (
      target: MessageTarget<M>,
    ) => Result<string[], globalThis.Error>;
    sendMessage: (
      target: MessageTarget<M>,
      message: NexusMessage,
    ) => Result<string[], globalThis.Error>;
    payloadProcessor: PayloadProcessor.Runtime<M>;
    pendingCallManager: PendingCallManager.Runtime;
  }

  export interface Runtime {
    safeProcess(
      options: DispatchCallOptions,
    ): Promise<Result<any, globalThis.Error>>;
  }

  export const create = <M extends AdapterModel>(
    deps: Dependencies<M>,
  ): Runtime => {
    const logger = new Logger("L3 -> CallProcessor");

    const getEmptyResultForStrategy = (
      strategy: "one" | "first" | "all" | "stream",
    ): any => {
      if (strategy === "stream") {
        return (async function* () {})();
      }
      if (strategy === "one" || strategy === "first") {
        return undefined;
      }
      return [];
    };

    const buildMessage = (
      options: DispatchCallOptions,
      finalTarget: MessageTarget<M>,
      messageId: number,
    ): Result<GetMessage | SetMessage | ApplyMessage, globalThis.Error> => {
      const { type, resourceId, path } = options;
      const tempConnectionIdForSanitize =
        "connectionId" in finalTarget ? finalTarget.connectionId : "broadcast";

      switch (type) {
        case "GET":
          return ok({
            type: NexusMessageType.GET,
            id: messageId,
            resourceId,
            path,
            ...(options.invocationServiceName
              ? { invocationServiceName: options.invocationServiceName }
              : {}),
          });
        case "SET": {
          const sanitizedValue = deps.payloadProcessor.safeSanitize(
            [options.value],
            tempConnectionIdForSanitize,
          );

          if (sanitizedValue.isErr()) {
            return err(sanitizedValue.error);
          }

          return ok({
            type: NexusMessageType.SET,
            id: messageId,
            resourceId,
            path,
            ...(options.invocationServiceName
              ? { invocationServiceName: options.invocationServiceName }
              : {}),
            value: sanitizedValue.value[0],
          });
        }
        case "APPLY": {
          const sanitizedArgs = deps.payloadProcessor.safeSanitize(
            options.args,
            tempConnectionIdForSanitize,
          );

          if (sanitizedArgs.isErr()) {
            return err(sanitizedArgs.error);
          }

          return ok({
            type: NexusMessageType.APPLY,
            id: messageId,
            resourceId,
            path,
            ...(options.invocationServiceName
              ? { invocationServiceName: options.invocationServiceName }
              : {}),
            args: sanitizedArgs.value,
          });
        }
      }
    };

    const safeAdaptResult = (
      results: any[],
      strategy: "one" | "first",
    ): Result<
      any,
      InstanceType<typeof Error.Targeting> | InstanceType<typeof Error.Remote>
    > => {
      if (!results || results.length === 0) {
        if (strategy === "one") {
          return err(
            new Error.Targeting(
              "Expected exactly one result for a call with strategy 'one', but received 0.",
              { context: { expected: 1, received: 0 } },
            ),
          );
        }
        return ok(undefined);
      }

      if (strategy === "one" && results.length !== 1) {
        return err(
          new Error.Targeting(
            `Expected exactly one result for a call with strategy 'one', but received ${results.length}.`,
            { context: { expected: 1, received: results.length } },
          ),
        );
      }

      const [firstResult] = results;
      if (firstResult.status === "rejected") {
        const remoteError = firstResult.reason;
        return err(
          new Error.Remote(
            `Remote call failed: ${remoteError?.message || "Unknown error"}`,
            { context: { remoteError } },
          ),
        );
      }

      return ok(firstResult.value);
    };

    const adaptResult = (
      result: Promise<any[]>,
      strategy: "one" | "first",
    ): Promise<Result<any, globalThis.Error>> =>
      Result.tryPromise({
        try: () => result,
        catch: (error) => toCallError(error),
      }).then((resolved) =>
        resolved.andThen((results) => safeAdaptResult(results, strategy)),
      );

    const safeExecuteDispatch = (
      options: DispatchCallOptions,
      strategy: "one" | "first" | "all" | "stream",
    ): Promise<Result<any, globalThis.Error>> => {
      logger.debug("Resolving target...", options.target);
      const finalTarget = options.target;
      logger.debug("Target resolved.", {
        original: options.target,
        resolved: finalTarget,
      });

      const connectionIdsResult = deps.getReadyConnectionIds(finalTarget);
      if (connectionIdsResult.isErr()) {
        return Promise.resolve(err(connectionIdsResult.error));
      }
      const sentConnectionIds = connectionIdsResult.value;
      if (
        ("connectionId" in finalTarget && sentConnectionIds.length !== 1) ||
        ("connectionIds" in finalTarget &&
          sentConnectionIds.length !== finalTarget.connectionIds.length)
      ) {
        return Promise.resolve(
          err(
            new Error.Disconnected(
              "Call failed. A bound connection was closed or is no longer available.",
              { context: { path: options.path } },
            ),
          ),
        );
      }
      if (sentConnectionIds.length === 0) {
        return Promise.resolve(ok(getEmptyResultForStrategy(strategy)));
      }
      if (strategy === "one" && sentConnectionIds.length > 1) {
        return Promise.resolve(
          err(
            new Error.Targeting(
              `Expected to send to exactly one target for a call with strategy 'one', but sent to ${sentConnectionIds.length}.`,
              {
                context: {
                  expected: 1,
                  received: sentConnectionIds.length,
                  path: options.path,
                },
              },
            ),
          ),
        );
      }
      const messageId = deps.nextMessageId();
      const timeout = options.timeout ?? options.proxyOptions?.timeout ?? 5000;
      const isBroadcast = !("connectionId" in finalTarget);
      const pendingStrategy = strategy === "stream" ? "stream" : "all";
      const registerResult = Result.try({
        try: () =>
          deps.pendingCallManager.register(messageId, {
            strategy: pendingStrategy,
            isBroadcast,
            sentConnectionIds,
            timeout,
          }),
        catch: (error) =>
          error instanceof globalThis.Error
            ? error
            : new globalThis.Error(String(error)),
      });

      if (registerResult.isErr())
        return Promise.resolve(err(registerResult.error));
      for (const connectionId of sentConnectionIds) {
        const messageResult = buildMessage(
          options,
          { connectionId },
          messageId,
        );
        if (messageResult.isErr()) {
          deps.pendingCallManager.fail(messageId, messageResult.error);
          return Promise.resolve(err(messageResult.error));
        }
        const sendResult = deps.sendMessage(
          { connectionId },
          messageResult.value,
        );
        if (sendResult.isErr()) {
          deps.payloadProcessor.releaseSanitizedResources(messageResult.value);
          deps.pendingCallManager.fail(messageId, sendResult.error);
          return Promise.resolve(err(sendResult.error));
        }
      }
      const sentCount = sentConnectionIds.length;
      logger.debug(
        `Message #${messageId} sent to ${sentCount} connection(s)`,
        sentConnectionIds,
      );

      if (sentCount === 0) {
        if ("connectionId" in finalTarget && finalTarget.connectionId) {
          return Promise.resolve(
            err(
              new Error.Disconnected(
                `Call failed. The connection "${finalTarget.connectionId}" was closed or is no longer available.`,
                {
                  context: {
                    connectionId: finalTarget.connectionId,
                    path: options.path,
                  },
                },
              ),
            ),
          );
        }

        logger.debug(
          `Message #${messageId} found no matching connections for its target. Returning empty result for strategy '${strategy}'.`,
          finalTarget,
        );
        return Promise.resolve(ok(getEmptyResultForStrategy(strategy)));
      }

      if (strategy === "first" || strategy === "one") {
        logger.debug(
          `Adapting result for message #${messageId} with strategy '${strategy}'`,
        );
        return adaptResult(registerResult.value as Promise<any[]>, strategy);
      }

      if (strategy === "all") {
        return Result.tryPromise({
          try: () => registerResult.value as Promise<any>,
          catch: toCallError,
        });
      }

      return Promise.resolve(ok(registerResult.value));
    };

    const safeProcess = (
      options: DispatchCallOptions,
    ): Promise<Result<any, globalThis.Error>> => {
      const strategy = options.strategy ?? "first";
      return safeExecuteDispatch(options, strategy);
    };

    return { safeProcess };
  };
}

function toCallError(error: unknown): globalThis.Error {
  if (
    error instanceof globalThis.Error &&
    "code" in error &&
    error.code === "E_CONN_CLOSED"
  ) {
    return new CallProcessor.Error.Disconnected(error.message, {
      context:
        "context" in error
          ? (error.context as Record<string, unknown> | undefined)
          : undefined,
    });
  }

  return error instanceof globalThis.Error
    ? error
    : new globalThis.Error(String(error));
}
