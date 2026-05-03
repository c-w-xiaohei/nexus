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
import {
  type ServiceInvocationContext,
  getServiceInvocationHook,
  isServiceWithHooks,
  SERVICE_INVOKE_END,
  SERVICE_INVOKE_START,
} from "../service-invocation-hooks";

type MessageResourceErrorCode =
  | "E_RESOURCE_NOT_FOUND"
  | "E_RESOURCE_ACCESS_DENIED"
  | "E_AUTH_CALL_DENIED"
  | "E_INVOCATION_SERVICE_MISMATCH"
  | "E_INVALID_SERVICE_PATH"
  | "E_TARGET_NOT_CALLABLE"
  | "E_SET_ON_ROOT";

type MessageResourceErrorOptions = {
  readonly context?: Record<string, unknown>;
};

type AuthorizedCall = {
  readonly serviceName: string;
  readonly servicePolicy?: HandlerContext<any, any>["policy"];
};

type ExecutionPath = {
  readonly root: any;
  readonly propertyPath: (string | number)[];
  readonly target: any;
  readonly parent: any;
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
  ) => ResultAsync<
    { readonly result: any; readonly authorizedCall: AuthorizedCall },
    globalThis.Error
  >,
): MessageHandlerFn<T, any, any> {
  return async (context, message, sourceConnectionId) => {
    const { id } = message;

    const handled = await executor(context, message, sourceConnectionId).match(
      ({ result, authorizedCall }) => {
        const sanitizeResult = context.payloadProcessor.safeSanitizeFromService(
          [result],
          sourceConnectionId,
          authorizedCall.serviceName,
          authorizedCall.servicePolicy,
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
): Result<ExecutionPath, InstanceType<typeof MessageHandlerMapError.Resource>> {
  let root: any;
  let propertyPath: (string | number)[];

  const pathCheck = validateSafeRpcPath(path);
  if (pathCheck.isErr()) {
    return err(pathCheck.error);
  }

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

const DANGEROUS_PATH_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const validateSafeRpcPath = (
  path: readonly (string | number)[],
): Result<void, InstanceType<typeof MessageHandlerMapError.Resource>> => {
  const dangerousKey = path.find(
    (segment) =>
      typeof segment === "string" && DANGEROUS_PATH_KEYS.has(segment),
  );

  if (dangerousKey === undefined) {
    return ok(undefined);
  }

  return err(
    new MessageHandlerMapError.Resource(
      `Invalid RPC path. Segment "${dangerousKey}" is not allowed.`,
      "E_INVALID_SERVICE_PATH",
      { context: { path } },
    ),
  );
};

const operationName = (
  type: NexusMessageType.GET | NexusMessageType.SET | NexusMessageType.APPLY,
): "GET" | "SET" | "APPLY" => {
  switch (type) {
    case NexusMessageType.GET:
      return "GET";
    case NexusMessageType.SET:
      return "SET";
    case NexusMessageType.APPLY:
      return "APPLY";
  }
};

const resolveAuthoritativeServiceName = (
  context: HandlerContext<any, any>,
  message: GetMessage | SetMessage | ApplyMessage,
  sourceConnectionId: string,
): Result<string, InstanceType<typeof MessageHandlerMapError.Resource>> => {
  if (message.resourceId === null) {
    return ok(String(message.path[0]));
  }

  const localServiceName =
    context.resourceManager.getLocalResourceServiceName(message.resourceId) ??
    `resource:${message.resourceId}`;
  const incomingServiceName = message.invocationServiceName;

  if (
    incomingServiceName !== undefined &&
    incomingServiceName !== localServiceName
  ) {
    return err(
      new MessageHandlerMapError.Resource(
        `Resource invocation service mismatch for resource "${message.resourceId}".`,
        "E_INVOCATION_SERVICE_MISMATCH",
        {
          context: {
            sourceConnectionId,
            resourceId: message.resourceId,
            expectedServiceName: localServiceName,
            receivedServiceName: incomingServiceName,
          },
        },
      ),
    );
  }

  return ok(localServiceName);
};

const authorizeServiceCall = (
  context: HandlerContext<any, any>,
  message: GetMessage | SetMessage | ApplyMessage,
  sourceConnectionId: string,
): ResultAsync<AuthorizedCall, globalThis.Error> => {
  const serviceNameResult = resolveAuthoritativeServiceName(
    context,
    message,
    sourceConnectionId,
  );
  if (serviceNameResult.isErr()) {
    return errAsync(serviceNameResult.error);
  }

  const serviceName = serviceNameResult.value;
  const policy = getCallPolicy(context, message, serviceName);
  const canCall = policy?.canCall;

  if (!canCall) {
    return okAsync({ serviceName, servicePolicy: policy });
  }

  const authBase = context.getConnectionAuthContext?.(sourceConnectionId);
  if (!authBase) {
    return errAsync(
      new MessageHandlerMapError.Resource(
        `Connection "${sourceConnectionId}" is not authorized to call service "${serviceName}".`,
        "E_AUTH_CALL_DENIED",
        { context: { sourceConnectionId, path: message.path } },
      ),
    );
  }

  return ResultAsync.fromPromise(
    Promise.resolve().then(() =>
      canCall({
        ...authBase,
        connectionId: sourceConnectionId,
        serviceName,
        path:
          message.resourceId === null ? message.path.slice(1) : message.path,
        operation: operationName(message.type),
      }),
    ),
    () => createCallDeniedError(sourceConnectionId, serviceName, message.path),
  ).andThen((allowed) =>
    allowed === true
      ? okAsync({ serviceName, servicePolicy: policy })
      : errAsync(
          createCallDeniedError(sourceConnectionId, serviceName, message.path),
        ),
  );
};

const validateAuthorizableCall = (
  context: HandlerContext<any, any>,
  message: GetMessage | SetMessage | ApplyMessage,
  sourceConnectionId: string,
): ResultAsync<AuthorizedCall, globalThis.Error> => {
  const pathCheck = validateSafeRpcPath(message.path);
  if (pathCheck.isErr()) {
    return errAsync(pathCheck.error);
  }

  if (message.resourceId !== null) {
    const resource = context.resourceManager.getLocalResource(
      message.resourceId,
    );
    if (!resource) {
      return errAsync(
        new MessageHandlerMapError.Resource(
          `Local resource with ID "${message.resourceId}" not found.`,
          "E_RESOURCE_NOT_FOUND",
          { context: { resourceId: message.resourceId } },
        ),
      );
    }

    if (resource.ownerConnectionId !== sourceConnectionId) {
      return errAsync(
        new MessageHandlerMapError.Resource(
          `Connection "${sourceConnectionId}" is not authorized to access resource "${message.resourceId}".`,
          "E_RESOURCE_ACCESS_DENIED",
          {
            context: { sourceConnectionId, resourceId: message.resourceId },
          },
        ),
      );
    }
  }

  return authorizeServiceCall(context, message, sourceConnectionId);
};

const getCallPolicy = (
  context: HandlerContext<any, any>,
  message: GetMessage | SetMessage | ApplyMessage,
  serviceName: string,
) => {
  if (serviceName.startsWith("resource:")) {
    return context.policy;
  }

  if (message.resourceId !== null) {
    const resourcePolicy =
      context.resourceManager.getLocalResourceServicePolicy(message.resourceId);
    return resourcePolicy?.canCall ? resourcePolicy : context.policy;
  }

  const servicePolicy =
    context.resourceManager.getExposedServiceRecord(serviceName)?.policy;

  return servicePolicy?.canCall ? servicePolicy : context.policy;
};

const createCallDeniedError = (
  sourceConnectionId: string,
  serviceName: string,
  path: (string | number)[],
) =>
  new MessageHandlerMapError.Resource(
    `Connection "${sourceConnectionId}" is not authorized to call service "${serviceName}".`,
    "E_AUTH_CALL_DENIED",
    { context: { sourceConnectionId, path } },
  );

const handlerMap = new Map<NexusMessageType, MessageHandlerFn<any, any, any>>([
  [
    NexusMessageType.APPLY,
    createRequestHandler(
      (context, message: ApplyMessage, sourceConnectionId) => {
        const { payloadProcessor } = context;
        const { resourceId, path, args } = message;

        const authResult = validateAuthorizableCall(
          context,
          message,
          sourceConnectionId,
        );

        return authResult.andThen((authorizedCall) => {
          const pathResult = resolveExecutionPath(
            context.resourceManager,
            resourceId,
            path,
            sourceConnectionId,
          );

          if (pathResult.isErr()) {
            return errAsync(pathResult.error);
          }

          const { root, target, parent } = pathResult.value;

          if (typeof target !== "function") {
            return errAsync(
              new MessageHandlerMapError.Resource(
                `Target at path [${[resourceId, ...path].join(".")}] is not a function.`,
                "E_TARGET_NOT_CALLABLE",
                { context: { resourceId, path } },
              ),
            );
          }

          const hookTarget = !authorizedCall.serviceName.startsWith("resource:")
            ? context.resourceManager.getExposedService(
                authorizedCall.serviceName,
              )
            : undefined;
          const invocationHookTarget = isServiceWithHooks(hookTarget)
            ? hookTarget
            : isServiceWithHooks(root)
              ? root
              : isServiceWithHooks(parent ?? target)
                ? (parent ?? target)
                : undefined;
          const onInvokeStart = getServiceInvocationHook(
            invocationHookTarget,
            SERVICE_INVOKE_START,
          ) as
            | ((
                invocationContext: ServiceInvocationContext,
              ) => ServiceInvocationContext)
            | undefined;
          const onInvokeEnd = getServiceInvocationHook(
            invocationHookTarget,
            SERVICE_INVOKE_END,
          ) as
            | ((invocationContext?: ServiceInvocationContext) => void)
            | undefined;
          return ResultAsync.fromPromise(
            Promise.resolve().then(async () => {
              const invocationContext: ServiceInvocationContext | undefined =
                onInvokeStart
                  ? onInvokeStart({
                      sourceConnectionId,
                      sourceIdentity:
                        context.getConnectionAuthContext?.(sourceConnectionId)
                          ?.remoteIdentity,
                      localIdentity:
                        context.getConnectionAuthContext?.(sourceConnectionId)
                          ?.localIdentity,
                      platform:
                        context.getConnectionAuthContext?.(sourceConnectionId)
                          ?.platform,
                    })
                  : undefined;
              try {
                const revivedArgsResult = payloadProcessor.safeRevive(
                  args,
                  sourceConnectionId,
                );

                if (revivedArgsResult.isErr()) {
                  throw revivedArgsResult.error;
                }

                const invokeArgs =
                  typeof invocationContext === "undefined"
                    ? revivedArgsResult.value
                    : [...revivedArgsResult.value, invocationContext];

                return await Reflect.apply(target, parent, invokeArgs);
              } finally {
                if (onInvokeEnd) {
                  onInvokeEnd(invocationContext);
                }
              }
            }),
            toError,
          ).map((result) => ({ result, authorizedCall }));
        });
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
    (
      context: HandlerContext<any, any>,
      message: ReleaseMessage,
      sourceConnectionId: string,
    ) => {
      const resource = context.resourceManager.getLocalResource(
        message.resourceId,
      );
      if (resource?.ownerConnectionId === sourceConnectionId) {
        context.resourceManager.releaseLocalResource(message.resourceId);
      }
    },
  ],
  [
    NexusMessageType.GET,
    createRequestHandler((context, message: GetMessage, sourceConnectionId) => {
      const { resourceId, path } = message;

      const authResult = validateAuthorizableCall(
        context,
        message,
        sourceConnectionId,
      );

      return authResult.andThen((authorizedCall) => {
        const pathResult = resolveExecutionPath(
          context.resourceManager,
          resourceId,
          path,
          sourceConnectionId,
        );

        if (pathResult.isErr()) {
          return errAsync(pathResult.error);
        }

        return okAsync({ result: pathResult.value.target, authorizedCall });
      });
    }),
  ],
  [
    NexusMessageType.SET,
    createRequestHandler((context, message: SetMessage, sourceConnectionId) => {
      const { payloadProcessor } = context;
      const { resourceId, path, value } = message;

      const authResult = validateAuthorizableCall(
        context,
        message,
        sourceConnectionId,
      );

      return authResult.andThen((authorizedCall) => {
        const pathResult = resolveExecutionPath(
          context.resourceManager,
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

        return okAsync({ result: setResult.value, authorizedCall });
      });
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
