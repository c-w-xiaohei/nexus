import {
  NexusMessageType,
  type ApplyMessage,
  type ErrMessage,
  type ReleaseMessage,
  type ResMessage,
  type GetMessage,
  type SetMessage,
  type SerializedError,
} from "@/types/message";
import { createSerializedError } from "@/utils/error";
import { get, set } from "es-toolkit/compat";
import type { MessageHandlerFn, HandlerContext } from "./types";
import { ResourceManager } from "../resource-manager";

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
    sourceConnectionId: string
  ) => Promise<any>
): MessageHandlerFn<T, any, any> {
  return async (context, message, sourceConnectionId) => {
    const { id } = message;
    try {
      // 1. Execute the core logic for the specific message type.
      const result = await executor(context, message, sourceConnectionId);

      // 2. Sanitize the successful result before sending back.
      const sanitizedResult = context.payloadProcessor.sanitize(
        [result],
        sourceConnectionId
      )[0];

      // 3. Send the successful response.
      context.engine.sendMessage(
        {
          type: NexusMessageType.RES,
          id,
          result: sanitizedResult,
        },
        sourceConnectionId
      );
    } catch (error) {
      // 4. If any error occurs, send a serialized error response.
      context.engine.sendMessage(
        {
          type: NexusMessageType.ERR,
          id,
          error: createSerializedError(error),
        },
        sourceConnectionId
      );
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
  resourceManager: ResourceManager,
  resourceId: string | null,
  path: (string | number)[],
  sourceConnectionId: string
) {
  let root: any;
  let propertyPath: (string | number)[];

  if (resourceId) {
    // Case 1: Operating on a local resource reference (@Ref or callback)
    const resource = resourceManager.getLocalResource(resourceId);
    if (!resource) {
      throw new Error(`Local resource with ID "${resourceId}" not found.`);
    }
    // Security check: The caller must be the owner of the resource proxy
    if (resource.ownerConnectionId !== sourceConnectionId) {
      throw new Error(
        `Connection "${sourceConnectionId}" is not authorized to access resource "${resourceId}".`
      );
    }
    root = resource.target;
    propertyPath = path;
  } else {
    // Case 2: Operating on a globally exposed service
    if (typeof path[0] !== "string" || path.length === 0) {
      throw new Error(
        "Invalid path for service call. Path must start with a service name."
      );
    }
    root = resourceManager.getExposedService(path[0]);
    propertyPath = path.slice(1);
  }

  if (root === undefined) {
    const rootName = resourceId ?? path[0];
    throw new Error(`Target resource or service "${rootName}" not found.`);
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

  return { root, propertyPath, target, parent };
}

const handlerMap = new Map<NexusMessageType, MessageHandlerFn<any, any, any>>([
  [
    NexusMessageType.APPLY,
    createRequestHandler(
      async (context, message: ApplyMessage, sourceConnectionId) => {
        const { resourceManager, payloadProcessor } = context;
        const { resourceId, path, args } = message;

        const { target, parent } = resolveExecutionPath(
          resourceManager,
          resourceId,
          path,
          sourceConnectionId
        );

        if (typeof target !== "function") {
          throw new Error(
            `Target at path [${[resourceId, ...path].join(
              "."
            )}] is not a function.`
          );
        }

        const revivedArgs = payloadProcessor.revive(args, sourceConnectionId);
        return target.apply(parent, revivedArgs);
      }
    ),
  ],

  // Responses
  [
    NexusMessageType.RES,
    async (
      context: HandlerContext<any, any>,
      message: ResMessage,
      sourceConnectionId: string
    ) => {
      const revivedResult = context.payloadProcessor.revive(
        [message.result],
        sourceConnectionId
      )[0];
      context.engine.handleResponse(
        message.id,
        revivedResult,
        null,
        sourceConnectionId
      );
    },
  ],
  [
    NexusMessageType.ERR,
    (
      context: HandlerContext<any, any>,
      message: ErrMessage,
      sourceConnectionId: string
    ) => {
      context.engine.handleResponse(
        message.id,
        null,
        message.error,
        sourceConnectionId
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
    createRequestHandler(
      async (context, message: GetMessage, sourceConnectionId) => {
        const { resourceManager } = context;
        const { resourceId, path } = message;

        const { target } = resolveExecutionPath(
          resourceManager,
          resourceId,
          path,
          sourceConnectionId
        );

        return target;
      }
    ),
  ],
  [
    NexusMessageType.SET,
    createRequestHandler(
      async (context, message: SetMessage, sourceConnectionId) => {
        const { resourceManager, payloadProcessor } = context;
        const { resourceId, path, value } = message;

        const { root, propertyPath } = resolveExecutionPath(
          resourceManager,
          resourceId,
          path,
          sourceConnectionId
        );

        const revivedValue = payloadProcessor.revive(
          [value],
          sourceConnectionId
        )[0];

        if (propertyPath.length === 0) {
          throw new Error(
            "SET requires a path. Cannot set a root resource or service directly."
          );
        }

        set(root, propertyPath, revivedValue);

        return true; // Acknowledge successful set
      }
    ),
  ],
]);

/**
 * Retrieves the handler function for a given message type.
 * @param type The NexusMessageType enum value.
 * @returns The corresponding handler function, or undefined if not found.
 */
export function getHandler(
  type: NexusMessageType
): MessageHandlerFn<any, any, any> | undefined {
  return handlerMap.get(type);
}
