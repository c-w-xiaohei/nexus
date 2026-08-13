import type { PlatformMeta, EndpointMeta } from "../types/identity.js";
import { NexusMessageType } from "../types/message.js";
import type { ApplyMessage, GetMessage, SetMessage } from "../types/message.js";
import type { DispatchCallOptions } from "./engine.js";
import { PendingCallManager } from "./pending-call-manager.js";
import { PayloadProcessor } from "./payload/payload-processor.js";
import type {
  CallTarget,
  MessageTarget,
  ResolveOptions,
} from "../connection/types.js";
import type { NexusMessage } from "../types/message.js";
import type { LogicalConnection } from "../connection/logical-connection.js";
import { Logger } from "../logger.js";
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

  export interface Dependencies<
    U extends EndpointMeta,
    P extends PlatformMeta,
  > {
    nextMessageId: () => number;
    resolveConnection: (
      target: ResolveOptions<U, P>,
    ) => Promise<Result<LogicalConnection<U, P> | null, globalThis.Error>>;
    sendMessage: (
      target: MessageTarget<U>,
      message: NexusMessage,
    ) => Result<string[], globalThis.Error>;
    payloadProcessor: PayloadProcessor.Runtime<U, P>;
    pendingCallManager: PendingCallManager.Runtime;
  }

  export interface Runtime {
    safeProcess(
      options: DispatchCallOptions,
    ): Promise<Result<any, globalThis.Error>>;
  }

  export const create = <U extends EndpointMeta, P extends PlatformMeta>(
    deps: Dependencies<U, P>,
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

    const resolveTarget = async (
      target: CallTarget<U, P>,
    ): Promise<Result<MessageTarget<U> | null, globalThis.Error>> => {
      if ("descriptor" in target && target.descriptor) {
        const resolved = await deps.resolveConnection({
          descriptor: target.descriptor,
          matcher: "matcher" in target ? target.matcher : undefined,
        });
        return resolved.map((resolvedConnection) => {
          if (!resolvedConnection) {
            return null;
          }

          return {
            ...target,
            connectionId: resolvedConnection.connectionId,
          };
        });
      }

      return ok(target as MessageTarget<U>);
    };

    const buildMessage = (
      options: DispatchCallOptions,
      finalTarget: MessageTarget<U>,
    ): Result<GetMessage | SetMessage | ApplyMessage, globalThis.Error> => {
      const { type, resourceId, path } = options;
      const messageId = deps.nextMessageId();
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

    const adaptResult = async (
      result: Promise<any[]>,
      strategy: "one" | "first",
    ): Promise<Result<any, globalThis.Error>> =>
      Result.tryPromise({
        try: () => result,
        catch: (error) =>
          error instanceof globalThis.Error
            ? error
            : new globalThis.Error(String(error)),
      }).then((result) =>
        result.andThen((results) => safeAdaptResult(results, strategy)),
      );

    const safeExecuteDispatch = async (
      options: DispatchCallOptions,
      strategy: "one" | "first" | "all" | "stream",
    ): Promise<Result<any, globalThis.Error>> => {
      logger.debug("Resolving target...", options.target);
      const resolvedTarget = await resolveTarget(options.target);
      return resolvedTarget.andThenAsync(async (finalTarget) => {
        if (!finalTarget) {
          logger.warn(
            `Could not resolve target, call to [${options.path.join(
              ".",
            )}] will not be sent.`,
            options.target,
          );
          return ok(getEmptyResultForStrategy(strategy));
        }

        logger.debug("Target resolved.", {
          original: options.target,
          resolved: finalTarget,
        });

        const messageResult = buildMessage(options, finalTarget);
        if (messageResult.isErr()) {
          return err(messageResult.error);
        }

        const message = messageResult.value;
        logger.debug(`Built message #${message.id}`, message);

        const sendResult = deps.sendMessage(finalTarget, message);
        if (sendResult.isErr()) {
          return err(sendResult.error);
        }

        const sentConnectionIds = sendResult.value;
        const sentCount = sentConnectionIds.length;
        logger.debug(
          `Message #${message.id} sent to ${sentCount} connection(s)`,
          sentConnectionIds,
        );

        if (sentCount === 0) {
          if ("connectionId" in finalTarget && finalTarget.connectionId) {
            return err(
              new Error.Disconnected(
                `Call failed. The connection "${finalTarget.connectionId}" was closed or is no longer available.`,
                {
                  context: {
                    connectionId: finalTarget.connectionId,
                    path: options.path,
                  },
                },
              ),
            );
          }

          logger.debug(
            `Message #${message.id} found no matching connections for its target. Returning empty result for strategy '${strategy}'.`,
            finalTarget,
          );
          return ok(getEmptyResultForStrategy(strategy));
        }

        if (strategy === "one" && sentCount !== 1) {
          return err(
            new Error.Targeting(
              `Expected to send to exactly one target for a call with strategy 'one', but sent to ${sentCount}.`,
              {
                context: {
                  expected: 1,
                  received: sentCount,
                  path: options.path,
                },
              },
            ),
          );
        }

        logger.debug(`Registering pending call for message #${message.id}`);
        const timeout =
          options.timeout ?? options.proxyOptions?.timeout ?? 5000;
        const isBroadcast = "matcher" in finalTarget || "group" in finalTarget;
        const pendingStrategy = strategy === "stream" ? "stream" : "all";

        const registerResult = Result.try({
          try: () =>
            deps.pendingCallManager.register(message.id, {
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

        if (registerResult.isErr()) {
          return err(registerResult.error);
        }

        if (strategy === "first" || strategy === "one") {
          logger.debug(
            `Adapting result for message #${message.id} with strategy '${strategy}'`,
          );
          return adaptResult(registerResult.value as Promise<any[]>, strategy);
        }

        if (strategy === "all") {
          return Result.tryPromise({
            try: () => registerResult.value as Promise<any>,
            catch: (error) =>
              error instanceof globalThis.Error
                ? error
                : new globalThis.Error(String(error)),
          });
        }

        return ok(registerResult.value);
      });
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
