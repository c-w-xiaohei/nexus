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
    safeSanitize(
      args: any[],
      targetConnectionId: string,
    ): TResult<any[], globalThis.Error>;
    safeSanitizeFromService(
      args: any[],
      targetConnectionId: string,
      serviceName: string,
      servicePolicy?: NexusAuthorizationPolicy<M>,
    ): TResult<any[], globalThis.Error>;
    safeRevive(
      args: any[],
      sourceConnectionId: string,
    ): TResult<any[], globalThis.Error>;
    releaseSanitizedResources(value: unknown): void;
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

      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype
      ) {
        const result: { [key: string]: any } = {};
        for (const key in value) {
          if (Object.prototype.hasOwnProperty.call(value, key)) {
            result[key] = internalSanitize(value[key], context);
          }
        }
        return result;
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
      if (Array.isArray(value)) {
        for (const item of value) releaseSanitizedResources(item);
        return;
      }
      if (value && typeof value === "object") {
        for (const item of Object.values(value))
          releaseSanitizedResources(item);
        return;
      }
      const placeholder = Placeholder.fromString(value);
      if (
        placeholder?.type === PlaceholderType.RESOURCE &&
        placeholder.payload
      ) {
        resourceManager.releaseLocalResource(placeholder.payload);
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
      servicePolicyOverride?: NexusAuthorizationPolicy<M>,
    ): TResult<any[], globalThis.Error> {
      const servicePolicy =
        arguments.length >= 4
          ? servicePolicyOverride
          : resourceManager.getExposedServiceRecord(serviceName)?.policy;
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
    };

    return runtime;
  };
}
