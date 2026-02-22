import {
  type MessageId,
  NexusMessageType,
  type ApplyMessage,
  type ErrMessage,
  type ReleaseMessage,
  type ResMessage,
  type GetMessage,
  type SetMessage,
} from "@/types/message";
import { toSerializedError } from "@/utils/error";
import { get, set } from "es-toolkit/compat";
import type { MessageHandlerFn, HandlerContext } from "./types";
import { ResourceManager } from "../resource-manager";
import { Result, ResultAsync, err, errAsync, ok, okAsync } from "neverthrow";

type MessageResourceErrorCode =
  | "E_RESOURCE_NOT_FOUND"
  | "E_RESOURCE_ACCESS_DENIED"
  | "E_INVALID_SERVICE_PATH"
  | "E_TARGET_NOT_CALLABLE"
  | "E_SET_ON_ROOT";

type MessageResourceErrorOptions = {
  readonly context?: Record<string, unknown>;
};

class MessageResourceError extends Error {
  readonly code: MessageResourceErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: MessageResourceErrorCode,
    options: MessageResourceErrorOptions = {},
  ) {
    super(message);
    this.name = "MessageResourceError";
    this.code = code;
    this.context = options.context;
  }
}

export const MessageHandlerMapError = {
  Resource: MessageResourceError,
} as const;

const toError = (error: unknown): globalThis.Error =>
  error instanceof globalThis.Error
    ? error
    : new globalThis.Error(String(error));

const safeSend = (
  context: HandlerContext<any, any>,
  message:
    | { type: NexusMessageType.RES; id: MessageId; result: any }
    | { type: NexusMessageType.ERR; id: MessageId; error: any },
  sourceConnectionId: string,
): Result<void, globalThis.Error> => {
  const sendResult = Result.fromThrowable(
    () => context.engine.safeSendMessage(message, sourceConnectionId),
    toError,
  )();

  if (sendResult.isErr()) {
    return err(sendResult.error);
  }

  if (sendResult.value.isErr()) {
    return err(sendResult.value.error);
  }

  return ok(undefined);
};

// =============================================================================
// Shared Helper Functions
// =============================================================================

/**
 * A higher-order function that wraps request handlers (GET, SET, APPLY)
 * to provide centralized try/catch error handling and response sending.
 * This simplifies each handler to only contain its core execution logic.
 *
 * @param executor The core logic function for the request.
 * @returns A full MessageHandlerFn with error handling and response logic.
 */
function createRequestHandler<T extends GetMessage | SetMessage | ApplyMessage>(
  executor: (
    context: HandlerContext<any, any>,
    message: T,
    sourceConnectionId: string,
  ) => ResultAsync<any, globalThis.Error>,
): MessageHandlerFn<T, any, any> {
  return async (context, message, sourceConnectionId) => {
    const { id } = message;

    const handled = await executor(context, message, sourceConnectionId).match(
      (result) => {
        const sanitizeResult = context.payloadProcessor.safeSanitize(
          [result],
          sourceConnectionId,
        );

        if (sanitizeResult.isErr()) {
          return safeSend(
            context,
            {
              type: NexusMessageType.ERR,
              id,
              error: toSerializedError(sanitizeResult.error),
            },
            sourceConnectionId,
          );
        }

        return safeSend(
          context,
          {
            type: NexusMessageType.RES,
            id,
            result: sanitizeResult.value[0],
          },
          sourceConnectionId,
        );
      },
      (error) => {
        return safeSend(
          context,
          {
            type: NexusMessageType.ERR,
            id,
            error: toSerializedError(error),
          },
          sourceConnectionId,
        );
      },
    );

    if (handled.isErr()) {
      throw handled.error;
    }
  };
}

/**
 * A comprehensive resolver that finds all relevant parts of an execution path
 * for a message. It finds the root object, the property path, the final
 * target value, and the target's immediate parent.
 * It also performs the crucial security check to ensure the caller owns the
 * resource it's trying to access.
 *
 * @returns An object containing `root`, `propertyPath`, `target`, and `parent`.
 */
function resolveExecutionPath(
  resourceManager: ResourceManager.Runtime,
  resourceId: string | null,
  path: (string | number)[],
  sourceConnectionId: string,
): Result<
  {
    root: any;
    propertyPath: (string | number)[];
    target: any;
    parent: any;
  },
  InstanceType<typeof MessageHandlerMapError.Resource>
> {
  let root: any;
  let propertyPath: (string | number)[];

  if (resourceId) {
    // Case 1: Operating on a local resource reference (@Ref or callback)
    const resource = resourceManager.getLocalResource(resourceId);
    if (!resource) {
      return err(
        new MessageHandlerMapError.Resource(
          `Local resource with ID "${resourceId}" not found.`,
          "E_RESOURCE_NOT_FOUND",
          { context: { resourceId } },
        ),
      );
    }
    // Security check: The caller must be the owner of the resource proxy
    if (resource.ownerConnectionId !== sourceConnectionId) {
      return err(
        new MessageHandlerMapError.Resource(
          `Connection "${sourceConnectionId}" is not authorized to access resource "${resourceId}".`,
          "E_RESOURCE_ACCESS_DENIED",
          { context: { sourceConnectionId, resourceId } },
        ),
      );
    }
    root = resource.target;
    propertyPath = path;
  } else {
    // Case 2: Operating on a globally exposed service
    if (typeof path[0] !== "string" || path.length === 0) {
      return err(
        new MessageHandlerMapError.Resource(
          "Invalid path for service call. Path must start with a service name.",
          "E_INVALID_SERVICE_PATH",
          { context: { path } },
        ),
      );
    }
    root = resourceManager.getExposedService(path[0]);
    propertyPath = path.slice(1);
  }

  if (root === undefined) {
    const rootName = resourceId ?? path[0];
    return err(
      new MessageHandlerMapError.Resource(
        `Target resource or service "${rootName}" not found.`,
        "E_RESOURCE_NOT_FOUND",
        { context: { resourceId, path } },
      ),
    );
  }

  // Find the final target value using the path.
  const target = propertyPath.length > 0 ? get(root, propertyPath) : root;

  // Find the parent for setting the `this` context.
  let parent: any = null;
  if (propertyPath.length > 0) {
    const parentPath = propertyPath.slice(0, -1);
    // If the parent path is empty, the parent is the root object.
    parent = parentPath.length > 0 ? get(root, parentPath) : root;
  }

  return ok({ root, propertyPath, target, parent });
}

const handlerMap = new Map<NexusMessageType, MessageHandlerFn<any, any, any>>([
  [
    NexusMessageType.APPLY,
    createRequestHandler(
      (context, message: ApplyMessage, sourceConnectionId) => {
        const { resourceManager, payloadProcessor } = context;
        const { resourceId, path, args } = message;

        const pathResult = resolveExecutionPath(
          resourceManager,
          resourceId,
          path,
          sourceConnectionId,
        );

        if (pathResult.isErr()) {
          return errAsync(pathResult.error);
        }

        const { target, parent } = pathResult.value;

        if (typeof target !== "function") {
          return errAsync(
            new MessageHandlerMapError.Resource(
              `Target at path [${[resourceId, ...path].join(".")}] is not a function.`,
              "E_TARGET_NOT_CALLABLE",
              { context: { resourceId, path } },
            ),
          );
        }

        const revivedArgsResult = payloadProcessor.safeRevive(
          args,
          sourceConnectionId,
        );

        if (revivedArgsResult.isErr()) {
          return errAsync(revivedArgsResult.error);
        }

        return ResultAsync.fromPromise(
          Promise.resolve().then(() =>
            target.apply(parent, revivedArgsResult.value),
          ),
          toError,
        );
      },
    ),
  ],

  // Responses
  [
    NexusMessageType.RES,
    async (
      context: HandlerContext<any, any>,
      message: ResMessage,
      sourceConnectionId: string,
    ) => {
      const revivedResult = context.payloadProcessor.safeRevive(
        [message.result],
        sourceConnectionId,
      );

      if (revivedResult.isErr()) {
        context.engine.handleResponse(
          message.id,
          null,
          toSerializedError(revivedResult.error),
          sourceConnectionId,
        );
        return;
      }

      context.engine.handleResponse(
        message.id,
        revivedResult.value[0],
        null,
        sourceConnectionId,
      );
    },
  ],
  [
    NexusMessageType.ERR,
    (
      context: HandlerContext<any, any>,
      message: ErrMessage,
      sourceConnectionId: string,
    ) => {
      context.engine.handleResponse(
        message.id,
        null,
        message.error,
        sourceConnectionId,
      );
    },
  ],

  // Notifications
  [
    NexusMessageType.RELEASE,
    (context: HandlerContext<any, any>, message: ReleaseMessage) => {
      context.resourceManager.releaseLocalResource(message.resourceId);
    },
  ],
  [
    NexusMessageType.GET,
    createRequestHandler((context, message: GetMessage, sourceConnectionId) => {
      const { resourceManager } = context;
      const { resourceId, path } = message;

      const pathResult = resolveExecutionPath(
        resourceManager,
        resourceId,
        path,
        sourceConnectionId,
      );

      if (pathResult.isErr()) {
        return errAsync(pathResult.error);
      }

      return okAsync(pathResult.value.target);
    }),
  ],
  [
    NexusMessageType.SET,
    createRequestHandler((context, message: SetMessage, sourceConnectionId) => {
      const { resourceManager, payloadProcessor } = context;
      const { resourceId, path, value } = message;

      const pathResult = resolveExecutionPath(
        resourceManager,
        resourceId,
        path,
        sourceConnectionId,
      );

      if (pathResult.isErr()) {
        return errAsync(pathResult.error);
      }

      const { root, propertyPath } = pathResult.value;

      const revivedValue = payloadProcessor.safeRevive(
        [value],
        sourceConnectionId,
      );

      if (revivedValue.isErr()) {
        return errAsync(revivedValue.error);
      }

      if (propertyPath.length === 0) {
        return errAsync(
          new MessageHandlerMapError.Resource(
            "SET requires a path. Cannot set a root resource or service directly.",
            "E_SET_ON_ROOT",
            { context: { resourceId, path } },
          ),
        );
      }

      const setResult = Result.fromThrowable(() => {
        set(root, propertyPath, revivedValue.value[0]);
        return true;
      }, toError)();

      if (setResult.isErr()) {
        return errAsync(setResult.error);
      }

      return okAsync(setResult.value);
    }),
  ],
]);

/**
 * Retrieves the handler function for a given message type.
 * @param type The NexusMessageType enum value.
 * @returns The corresponding handler function, or undefined if not found.
 */
export function getHandler(
  type: NexusMessageType,
): MessageHandlerFn<any, any, any> | undefined {
  return handlerMap.get(type);
}
