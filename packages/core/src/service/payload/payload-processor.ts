import type { AdapterModel } from "../../types/adapter-model";
import {
  getValueType,
  LocalResourceType,
  type ReviveContext,
  type SanitizeContext,
  ValueType,
} from "../types";
import type { ProxyFactory } from "../proxy-factory";
import type { ResourceManager } from "../resource-manager";
import type { NexusAuthorizationPolicy } from "@/api/types/config";
import { isRefWrapper } from "@/types/ref-wrapper";
import { RELEASE_PROXY_SYMBOL } from "@/types/symbols";
import { Placeholder } from "./placeholder";
import {
  ESCAPE_CHAR,
  PLACEHOLDER_PREFIX,
  PlaceholderType,
  REVIVER_TABLE_CONFIG,
  SANITIZER_TABLE_CONFIG,
} from "./protocol";
import { Logger } from "@/logger";
import { Result, type Result as TResult } from "better-result";
const { err, ok } = Result;

function collectResourceIds(
  value: unknown,
  ids = new Set<string>(),
): Set<string> {
  if (value && typeof value === "object") {
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      collectResourceIds(item, ids);
    }
  } else {
    const placeholder = Placeholder.fromString(value);
    if (placeholder?.type === PlaceholderType.RESOURCE && placeholder.payload) {
      ids.add(placeholder.payload);
    }
  }
  return ids;
}

export namespace PayloadProcessor {
  type ErrorCode = "E_PROTOCOL_ERROR";

  type ErrorOptions = {
    readonly context?: Record<string, unknown>;
  };

  class UnsupportedTypeError extends globalThis.Error {
    readonly code: ErrorCode = "E_PROTOCOL_ERROR";
    readonly context?: Record<string, unknown>;

    constructor(message: string, options: ErrorOptions = {}) {
      super(message);
      this.name = "PayloadProcessorUnsupportedTypeError";
      this.context = options.context;
    }
  }

  export const Error = {
    UnsupportedType: UnsupportedTypeError,
  } as const;

  export interface Runtime<M extends AdapterModel> {
    readonly resourceManager: ResourceManager.Runtime;
    readonly proxyFactory: ProxyFactory<M>;
    /**
     * Encodes call arguments for one session.
     * Failed encoding rolls back newly registered capabilities.
     */
    safeSanitize(
      args: any[],
      targetConnectionId: string,
    ): TResult<any[], globalThis.Error>;
    /**
     * Encodes service results using the exact authorized policy snapshot,
     * including undefined rather than falling back to the current registration.
     */
    safeSanitizeFromService(
      args: any[],
      targetConnectionId: string,
      serviceName: string,
      servicePolicy: NexusAuthorizationPolicy<M> | undefined,
    ): TResult<any[], globalThis.Error>;
    /**
     * Revives one payload, deduplicating resource identities.
     * Failure rolls back new facades without releasing pre-existing identities.
     */
    safeRevive(
      args: any[],
      sourceConnectionId: string,
    ): TResult<any[], globalThis.Error>;
    /** Releases local capabilities encoded for a handoff that was not accepted. */
    releaseSanitizedResources(value: unknown): void;
    /**
     * Releases late-response identities only when no existing remote facade
     * owns them; repeated identities are released once per payload.
     */
    releaseOrphanedResponseResources(
      value: unknown,
      sourceConnectionId: string,
      dispatchRelease: (resourceId: string, connectionId: string) => void,
    ): void;
  }

  export const create = <M extends AdapterModel>(
    resourceManager: ResourceManager.Runtime,
    proxyFactory: ProxyFactory<M>,
  ): Runtime<M> => {
    const logger = new Logger("L3 --- PayloadProcessor");

    const internalSanitize = (value: any, context: SanitizeContext): any => {
      if (isRefWrapper(value)) {
        const resourceId = context.serviceName
          ? resourceManager.registerLocalResource(
              value.target,
              context.targetConnectionId,
              LocalResourceType.OBJECT,
              context.serviceName,
              context.servicePolicy,
            )
          : resourceManager.registerLocalResource(
              value.target,
              context.targetConnectionId,
              LocalResourceType.OBJECT,
            );
        logger.debug(
          `-> Sanitized nexus.ref() object by creating local resource #${resourceId}.`,
        );
        context.createdResourceIds?.push(resourceId);
        return new Placeholder(PlaceholderType.RESOURCE, resourceId).toString();
      }

      const type = getValueType(value);

      if (type === ValueType.PRIMITIVE) {
        if (typeof value === "undefined") {
          return new Placeholder(PlaceholderType.UNDEFINED).toString();
        }
        if (typeof value === "string") {
          if (
            value.startsWith(PLACEHOLDER_PREFIX) ||
            value.startsWith(ESCAPE_CHAR)
          ) {
            return `${ESCAPE_CHAR}${value}`;
          }
        }
        return value;
      }

      if (type === ValueType.ARRAY) {
        return value.map((item: any) => internalSanitize(item, context));
      }

      if (type === ValueType.PLAIN_OBJECT) {
        const result: { [key: string]: any } = {};
        for (const key in value) {
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            result[key] = internalSanitize(value[key], context);
          }
        }
        return result;
      }

      const handler = SANITIZER_TABLE_CONFIG.get(type);
      if (handler) {
        return handler(
          runtime as unknown as Runtime<AdapterModel>,
          value,
          context,
        ).toString();
      }

      logger.error(
        `Nexus serialization error: Unsupported type for value.`,
        value,
      );
      throw new Error.UnsupportedType(
        `Nexus serialization error: Unsupported type "${typeof value}"`,
        { context: { valueType: typeof value } },
      );
    };

    const releaseSanitizedResources = (value: unknown): void => {
      for (const resourceId of collectResourceIds(value)) {
        resourceManager.releaseLocalResource(resourceId);
      }
    };

    const internalRevive = (
      value: any,
      context: ReviveContext & {
        readonly revivedResourcesByIdentity: Map<
          string,
          { proxy: object; existedBeforeRevive: boolean }
        >;
      },
    ): any => {
      if (typeof value === "string" && value.startsWith(ESCAPE_CHAR)) {
        return value.substring(ESCAPE_CHAR.length);
      }

      const placeholder = Placeholder.fromString(value);
      if (placeholder) {
        logger.debug(
          `<- Reviving placeholder for resource #${placeholder.payload} from connection ${context.sourceConnectionId}.`,
          placeholder,
        );
        const handler = REVIVER_TABLE_CONFIG.get(placeholder.type);
        if (handler) {
          if (placeholder.type !== PlaceholderType.RESOURCE) {
            return handler(
              runtime as unknown as Runtime<AdapterModel>,
              placeholder,
              context,
            );
          }

          const resourceIdentity = `${context.sourceConnectionId}\u0000${placeholder.payload}`;
          const previousRevival =
            context.revivedResourcesByIdentity.get(resourceIdentity);
          if (previousRevival) return previousRevival.proxy;

          const existedBeforeRevive = runtime.resourceManager.hasRemoteProxy(
            placeholder.payload!,
            context.sourceConnectionId,
          );
          const revived = handler(
            runtime as unknown as Runtime<AdapterModel>,
            placeholder,
            context,
          );
          context.revivedResourcesByIdentity.set(resourceIdentity, {
            proxy: revived,
            existedBeforeRevive,
          });
          return revived;
        }
        logger.warn(
          `No reviver handler for placeholder type "${placeholder.type}". Returning as is.`,
          placeholder,
        );
        return value;
      }

      if (Array.isArray(value)) {
        return value.map((item: any) => internalRevive(item, context));
      }

      if (value !== null && typeof value === "object") {
        const result: { [key: string]: any } = Object.create(null);
        for (const key in value) {
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            result[key] = internalRevive(value[key], context);
          }
        }
        return result;
      }

      return value;
    };

    const safeSanitize = (
      args: any[],
      targetConnectionId: string,
    ): TResult<any[], globalThis.Error> =>
      safeSanitizeWithContext(args, { targetConnectionId });

    function safeSanitizeFromService(
      args: any[],
      targetConnectionId: string,
      serviceName: string,
      servicePolicy: NexusAuthorizationPolicy<M> | undefined,
    ): TResult<any[], globalThis.Error> {
      // Undefined is also an authorized snapshot, never a request to reload policy.
      return safeSanitizeWithContext(args, {
        targetConnectionId,
        serviceName,
        servicePolicy,
      });
    }

    const safeSanitizeWithContext = (
      args: any[],
      context: SanitizeContext,
    ): TResult<any[], globalThis.Error> => {
      const createdResourceIds: string[] = [];
      const result = Result.try({
        try: () => {
          const sanitized = internalSanitize(args, {
            ...context,
            createdResourceIds,
          });
          return Array.isArray(sanitized) ? sanitized : [sanitized];
        },
        catch: (error) =>
          error instanceof globalThis.Error
            ? error
            : new Error.UnsupportedType(
                `Nexus serialization error: ${String(error)}`,
                { context: { ...context } },
              ),
      });

      // Encoding is transactional until its message is handed to the connection.
      if (result.isErr()) {
        for (const resourceId of createdResourceIds) {
          resourceManager.releaseLocalResource(resourceId);
        }
        return err(result.error);
      }

      return ok(result.value);
    };

    const safeRevive = (
      args: any[],
      sourceConnectionId: string,
    ): TResult<any[], globalThis.Error> => {
      const context = {
        sourceConnectionId,
        revivedResourcesByIdentity: new Map(),
      };
      const result = Result.try({
        try: () => {
          const revived = internalRevive(args, context);
          return Array.isArray(revived) ? revived : [revived];
        },
        catch: (error) =>
          error instanceof globalThis.Error
            ? error
            : new Error.UnsupportedType(
                `Nexus revive error: ${String(error)}`,
                { context: { sourceConnectionId } },
              ),
      });

      // A pre-existing identity survives rollback: discard only this attempt's facade.
      if (result.isErr()) {
        for (const {
          proxy,
          existedBeforeRevive,
        } of context.revivedResourcesByIdentity.values()) {
          if (existedBeforeRevive) {
            proxyFactory.discardRemoteResourceProxy(proxy);
            continue;
          }
          const release = (proxy as { [RELEASE_PROXY_SYMBOL]?: unknown })[
            RELEASE_PROXY_SYMBOL
          ];
          if (typeof release === "function") release();
        }
        return err(result.error);
      }

      return ok(result.value);
    };

    const runtime: Runtime<M> = {
      resourceManager,
      proxyFactory,
      safeSanitize,
      safeSanitizeFromService,
      safeRevive,
      releaseSanitizedResources,
      releaseOrphanedResponseResources: (value, source, dispatchRelease) => {
        for (const resourceId of collectResourceIds(value)) {
          // A duplicate response must not release a capability already held by the caller.
          if (!resourceManager.hasRemoteProxy(resourceId, source)) {
            dispatchRelease(resourceId, source);
          }
        }
      },
    };

    return runtime;
  };
}
