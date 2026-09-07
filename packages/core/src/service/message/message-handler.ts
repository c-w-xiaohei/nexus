import { Result } from "better-result";
import { get, set } from "es-toolkit/compat";
import {
  NexusMessageType,
  type GetMessage,
  type SetMessage,
  type ApplyMessage,
  type NexusMessage,
} from "@/types/message";
import type {
  AdapterModel,
  ContextMetaOf,
  ConnectionMetaOf,
} from "@/types/adapter-model";
import type { NexusAuthorizationPolicy } from "@/api/types/config";
import { toSerializedError } from "@/utils/error";
import type { PayloadProcessor } from "../payload/payload-processor";
import type { PendingCallManager } from "../pending-call-manager";
import type { ResourceManager } from "../resource-manager";
import {
  getServiceInvocationHook,
  isServiceWithHooks,
  SERVICE_INVOKE_START,
  SERVICE_INVOKE_END,
  type ServiceInvocationContext,
} from "../service-invocation-hooks";

type Request = GetMessage | SetMessage | ApplyMessage;
type AuthorizedCall<M extends AdapterModel> = {
  serviceName: string;
  servicePolicy: NexusAuthorizationPolicy<M> | undefined;
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));
const dangerousPathKeys = new Set(["__proto__", "prototype", "constructor"]);

class MessageResourceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MessageResourceError";
  }
}

/** Owns incoming RPC processing for one Engine; dependencies and methods are shared across requests. */
export class MessageHandler<M extends AdapterModel> {
  constructor(private readonly context: MessageHandler.Context<M>) {}

  /**
   * Processes one message. Only requests receive replies, with one send attempt.
   * Late responses release orphan capabilities without creating remote facades.
   */
  public async safeHandleMessage(
    message: NexusMessage,
    source: string,
  ): Promise<Result<void, Error>> {
    return Result.tryPromise({
      try: async (): Promise<Result<void, Error>> => {
        const {
          payloadProcessor: payload,
          pendingCalls: pending,
          resourceManager: resources,
        } = this.context;
        switch (message.type) {
          case NexusMessageType.GET:
          case NexusMessageType.SET:
          case NexusMessageType.APPLY:
            return this.safeReply(message, source);
          case NexusMessageType.RES: {
            // Reject before revival so duplicate/late responses cannot allocate orphan facades.
            if (!pending.canHandleResponse(message.id, source)) {
              payload.releaseOrphanedResponseResources(
                message.result,
                source,
                this.context.dispatchRelease,
              );
              break;
            }
            const revived = payload.safeRevive([message.result], source);
            pending.handleResponse(
              message.id,
              revived.isOk() ? revived.value[0] : null,
              revived.isErr() ? toSerializedError(revived.error) : null,
              source,
            );
            break;
          }
          case NexusMessageType.ERR:
            pending.handleResponse(message.id, null, message.error, source);
            break;
          case NexusMessageType.RELEASE:
            if (
              resources.getLocalResource(message.resourceId)
                ?.ownerConnectionId === source
            ) {
              resources.releaseLocalResource(message.resourceId);
            }
            break;
          default:
            return Result.err(
              Object.assign(
                new Error(
                  `No message handler found for message type "${message.type}"`,
                ),
                { code: "E_USAGE_INVALID" },
              ),
            );
        }
        return Result.ok(undefined);
      },
      catch: toError,
    }).then((result) => result.andThen((value) => value));
  }

  // ===== Request lifecycle: authorize -> execute -> encode -> hand off =====

  /** Keeps execution errors inside the reply boundary, but never replies again after a send failure. */
  private async safeReply(
    message: Request,
    source: string,
  ): Promise<Result<void, Error>> {
    const encoded = await Result.tryPromise({
      try: () => this.prepareReply(message, source),
      catch: toError,
    }).then((result) => result.andThen((value) => value));
    const reply: NexusMessage = encoded.isErr()
      ? {
          type: NexusMessageType.ERR,
          id: message.id,
          error: toSerializedError(encoded.error),
        }
      : {
          type: NexusMessageType.RES,
          id: message.id,
          result: encoded.value[0],
        };
    const sent = Result.try({
      try: () => this.context.safeSendMessage(reply, source),
      catch: toError,
    }).andThen((result) => result);
    if (sent.isErr() && encoded.isOk())
      this.context.payloadProcessor.releaseSanitizedResources(encoded.value);
    return sent;
  }

  /**
   * Executes and encodes under the captured policy, including undefined.
   * Property/hook/application exceptions are caught by safeReply, not by Result callbacks.
   */
  private async prepareReply(
    message: Request,
    source: string,
  ): Promise<Result<any[], Error>> {
    const authorization = this.authorize(message, source);
    // No-policy APPLY must enter State/Relay's scope without yielding a microtask.
    const authorized =
      message.type === NexusMessageType.APPLY &&
      !(authorization instanceof Promise)
        ? authorization
        : await authorization;
    if (authorized.isErr()) return authorized;

    // Authorization may await application code. Recheck before any getter or proxy trap.
    const resolved = this.resolvePath(message, source);
    if (resolved.isErr()) return resolved;
    const { root, propertyPath, target, parent } = resolved.value;
    const payload = this.context.payloadProcessor;
    let result: any;
    switch (message.type) {
      case NexusMessageType.GET:
        result = target; // GET transports Promise-valued properties without awaiting them.
        break;
      case NexusMessageType.SET: {
        const revived = payload.safeRevive([message.value], source);
        if (revived.isErr()) return revived;
        if (!propertyPath.length)
          return Result.err(
            new MessageResourceError(
              "SET requires a path. Cannot set a root resource or service directly.",
              "E_SET_ON_ROOT",
              { resourceId: message.resourceId, path: message.path },
            ),
          );
        set(root, propertyPath, revived.value[0]);
        result = true;
        break;
      }
      case NexusMessageType.APPLY: {
        if (typeof target !== "function")
          return Result.err(
            new MessageResourceError(
              `Target at path [${[message.resourceId, ...message.path].join(".")}] is not a function.`,
              "E_TARGET_NOT_CALLABLE",
              { resourceId: message.resourceId, path: message.path },
            ),
          );
        const serviceName = authorized.value.serviceName;
        const service = !serviceName.startsWith("resource:")
          ? this.context.resourceManager.getExposedService(serviceName)
          : undefined;
        // Preserve hook lookup priority and short-circuiting: getters may run application code.
        const hookTarget = isServiceWithHooks(service)
          ? service
          : isServiceWithHooks(root)
            ? root
            : isServiceWithHooks(parent ?? target)
              ? (parent ?? target)
              : undefined;
        const start = getServiceInvocationHook(
          hookTarget,
          SERVICE_INVOKE_START,
        ) as
          | ((
              context: ServiceInvocationContext,
            ) => ServiceInvocationContext | undefined)
          | undefined;
        const end = getServiceInvocationHook(hookTarget, SERVICE_INVOKE_END) as
          | ((context?: ServiceInvocationContext) => void)
          | undefined;
        const auth = start
          ? this.context.getConnectionAuthContext?.(source)
          : undefined;
        const invocation = start?.({
          sourceConnectionId: source,
          sourceIdentity: auth?.remoteIdentity,
          localIdentity: auth?.localIdentity,
          platform: auth?.connection,
        });
        try {
          const args = payload.safeRevive(message.args, source);
          if (args.isErr()) return args;
          result = Reflect.apply(
            target,
            parent,
            invocation === undefined ? args.value : [...args.value, invocation],
          );
        } finally {
          // State/Relay require start -> revive -> apply -> end synchronously, even on failure.
          end?.(invocation);
        }
        result = await result;
        break;
      }
    }
    // The registration may have changed while we awaited; never reload the authorized policy.
    return payload.safeSanitizeFromService(
      [result],
      source,
      authorized.value.serviceName,
      authorized.value.servicePolicy,
    );
  }

  // ===== Authorization: registry metadata first, application properties afterwards =====

  /** Captures the effective host policy without evaluating the requested property path. */
  private authorize(
    message: Request,
    source: string,
  ):
    | Result<AuthorizedCall<M>, Error>
    | Promise<Result<AuthorizedCall<M>, Error>> {
    const checked = validatePath(message.path);
    if (checked.isErr()) return checked;
    let serviceName: string;
    let servicePolicy: NexusAuthorizationPolicy<M> | undefined;
    if (message.resourceId !== null) {
      const resource = this.ownedResource(message.resourceId, source);
      if (resource.isErr()) return resource;
      serviceName =
        resource.value.serviceName ?? `resource:${message.resourceId}`;
      servicePolicy = resource.value.servicePolicy;
      if (
        message.invocationServiceName !== undefined &&
        message.invocationServiceName !== serviceName
      ) {
        return Result.err(
          new MessageResourceError(
            `Resource invocation service mismatch for resource "${message.resourceId}".`,
            "E_INVOCATION_SERVICE_MISMATCH",
            {
              sourceConnectionId: source,
              resourceId: message.resourceId,
              expectedServiceName: serviceName,
              receivedServiceName: message.invocationServiceName,
            },
          ),
        );
      }
    } else {
      serviceName = String(message.path[0]);
      servicePolicy =
        this.context.resourceManager.getExposedServiceRecord(
          serviceName,
        )?.policy;
    }
    const policy =
      !serviceName.startsWith("resource:") && servicePolicy?.canCall
        ? servicePolicy
        : this.context.policy;
    const authorized = { serviceName, servicePolicy: policy };
    const canCall = policy?.canCall;
    if (!canCall) return Result.ok(authorized);
    const denied = () =>
      new MessageResourceError(
        `Connection "${source}" is not authorized to call service "${serviceName}".`,
        "E_AUTH_CALL_DENIED",
        { sourceConnectionId: source, path: message.path },
      );
    const auth = this.context.getConnectionAuthContext?.(source);
    if (!auth) return Result.err(denied());
    return Result.tryPromise({
      try: () =>
        Promise.resolve().then(() =>
          canCall({
            ...auth,
            connectionId: source,
            serviceName,
            path:
              message.resourceId === null
                ? message.path.slice(1)
                : message.path,
            operation:
              message.type === NexusMessageType.GET
                ? "GET"
                : message.type === NexusMessageType.SET
                  ? "SET"
                  : "APPLY",
          }),
        ),
      catch: denied,
    }).then((result) =>
      result.andThen((allowed) =>
        allowed === true ? Result.ok(authorized) : Result.err(denied()),
      ),
    );
  }

  /** Resolves properties only after authorization, with a fresh resource ownership check. */
  private resolvePath(message: Request, source: string) {
    const { resourceId, path } = message;
    const checked = validatePath(path);
    if (checked.isErr()) return checked;
    let root: any;
    const propertyPath = resourceId === null ? path.slice(1) : path;
    if (resourceId !== null) {
      const resource = this.ownedResource(resourceId, source);
      if (resource.isErr()) return resource;
      root = resource.value.target;
    } else {
      if (typeof path[0] !== "string")
        return Result.err(
          new MessageResourceError(
            "Invalid path for service call. Path must start with a service name.",
            "E_INVALID_SERVICE_PATH",
            { path },
          ),
        );
      root = this.context.resourceManager.getExposedService(path[0]);
    }
    if (root === undefined)
      return Result.err(
        new MessageResourceError(
          `Target resource or service "${resourceId ?? path[0]}" not found.`,
          "E_RESOURCE_NOT_FOUND",
          { resourceId, path },
        ),
      );
    // Keep property-read order, including SET's validation reads; getters are observable.
    const target = propertyPath.length ? get(root, propertyPath) : root;
    const parent =
      propertyPath.length > 1
        ? get(root, propertyPath.slice(0, -1))
        : propertyPath.length
          ? root
          : null;
    return Result.ok({ root, propertyPath, target, parent });
  }

  /** Checks registry ownership without evaluating any property on the target. */
  private ownedResource(resourceId: string, source: string) {
    const resource = this.context.resourceManager.getLocalResource(resourceId);
    if (!resource)
      return Result.err(
        new MessageResourceError(
          `Local resource with ID "${resourceId}" not found.`,
          "E_RESOURCE_NOT_FOUND",
          { resourceId },
        ),
      );
    if (resource.ownerConnectionId !== source)
      return Result.err(
        new MessageResourceError(
          `Connection "${source}" is not authorized to access resource "${resourceId}".`,
          "E_RESOURCE_ACCESS_DENIED",
          { sourceConnectionId: source, resourceId },
        ),
      );
    return Result.ok(resource);
  }
}

export namespace MessageHandler {
  export interface Context<M extends AdapterModel> {
    readonly safeSendMessage: (
      message: NexusMessage,
      connectionId: string,
    ) => Result<void, Error>;
    readonly dispatchRelease: (
      resourceId: string,
      connectionId: string,
    ) => void;
    readonly pendingCalls: Pick<
      PendingCallManager.Runtime,
      "handleResponse" | "canHandleResponse"
    >;
    readonly resourceManager: ResourceManager.Runtime;
    readonly payloadProcessor: PayloadProcessor.Runtime<M>;
    policy?: NexusAuthorizationPolicy<M>;
    getConnectionAuthContext?: (connectionId: string) =>
      | {
          readonly localIdentity: ContextMetaOf<M>;
          readonly remoteIdentity: ContextMetaOf<M>;
          readonly connection: ConnectionMetaOf<M>;
        }
      | undefined;
  }
}

function validatePath(path: readonly (string | number)[]): Result<void, Error> {
  const dangerous = path.find(
    (key) => typeof key === "string" && dangerousPathKeys.has(key),
  );
  return dangerous === undefined
    ? Result.ok(undefined)
    : Result.err(
        new MessageResourceError(
          `Invalid RPC path. Segment "${dangerous}" is not allowed.`,
          "E_INVALID_SERVICE_PATH",
          { path },
        ),
      );
}
