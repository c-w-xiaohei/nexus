import type { AdapterModel } from "@/types/adapter-model";
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
import { Result } from "better-result";

type Revival = { proxy: object; existedBeforeRevive: boolean };
type RevivalContext = ReviveContext & { revived: Map<string, Revival> };

class UnsupportedTypeError extends Error {
  readonly code = "E_PROTOCOL_ERROR";
  constructor(
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PayloadProcessorUnsupportedTypeError";
  }
}

/** Transactional payload conversion for one Engine; protocol rules remain in the conversion tables. */
export class PayloadProcessor {
  private readonly logger = new Logger("L3 --- PayloadProcessor");
  constructor(
    readonly resourceManager: ResourceManager,
    readonly proxyFactory: ProxyFactory,
  ) {}

  /** Encodes arguments for one session, rolling back newly registered capabilities on failure. */
  public safeSanitize(
    args: any[],
    targetConnectionId: string,
  ): Result<any[], Error> {
    return this.safeSanitizeWithContext(args, { targetConnectionId });
  }

  /** Encodes results with the exact authorized policy, including an explicit undefined snapshot. */
  public safeSanitizeFromService(
    args: any[],
    targetConnectionId: string,
    serviceName: string,
    servicePolicy: NexusAuthorizationPolicy<AdapterModel> | undefined,
  ): Result<any[], Error> {
    return this.safeSanitizeWithContext(args, {
      targetConnectionId,
      serviceName,
      servicePolicy,
    });
  }

  /** Revives one payload; failed conversion discards new facades without releasing older identities. */
  public safeRevive(
    args: any[],
    sourceConnectionId: string,
  ): Result<any[], Error> {
    const context: RevivalContext = { sourceConnectionId, revived: new Map() };
    const result = Result.try({
      try: () => {
        const revived = this.revive(args, context);
        return Array.isArray(revived) ? revived : [revived];
      },
      catch: (error) =>
        error instanceof Error
          ? error
          : new UnsupportedTypeError(`Nexus revive error: ${String(error)}`, {
              sourceConnectionId,
            }),
    });
    if (result.isErr()) {
      for (const { proxy, existedBeforeRevive } of context.revived.values()) {
        if (existedBeforeRevive)
          this.proxyFactory.discardRemoteResourceProxy(proxy);
        else {
          const release = (proxy as { [RELEASE_PROXY_SYMBOL]?: unknown })[
            RELEASE_PROXY_SYMBOL
          ];
          if (typeof release === "function") release();
        }
      }
    }
    return result;
  }

  /** Releases local capabilities encoded for an unaccepted handoff. */
  public releaseSanitizedResources(value: unknown): void {
    for (const id of collectResourceIds(value))
      this.resourceManager.releaseLocalResource(id);
  }

  /** A late response must not release a capability already held by the caller. */
  public releaseOrphanedResponseResources(
    value: unknown,
    source: string,
    dispatchRelease: (id: string, source: string) => void,
  ): void {
    for (const id of collectResourceIds(value)) {
      if (!this.resourceManager.hasRemoteProxy(id, source))
        dispatchRelease(id, source);
    }
  }

  // ===== Conversion transactions: mutable tracking belongs to the payload, not the processor =====

  private safeSanitizeWithContext(
    args: any[],
    context: SanitizeContext,
  ): Result<any[], Error> {
    const createdResourceIds: string[] = [];
    const result = Result.try({
      try: () => {
        const encoded = this.sanitize(args, { ...context, createdResourceIds });
        return Array.isArray(encoded) ? encoded : [encoded];
      },
      catch: (error) =>
        error instanceof Error
          ? error
          : new UnsupportedTypeError(
              `Nexus serialization error: ${String(error)}`,
              { ...context },
            ),
    });
    // Encoding is transactional until a message is accepted by the connection.
    if (result.isErr())
      for (const id of createdResourceIds)
        this.resourceManager.releaseLocalResource(id);
    return result;
  }

  private sanitize(value: any, context: SanitizeContext): any {
    if (isRefWrapper(value)) {
      const id = this.resourceManager.registerLocalResource(
        value.target,
        context.targetConnectionId,
        LocalResourceType.OBJECT,
        context.serviceName || undefined,
        context.serviceName ? context.servicePolicy : undefined,
      );
      context.createdResourceIds?.push(id);
      return new Placeholder(PlaceholderType.RESOURCE, id).toString();
    }
    const type = getValueType(value);
    switch (type) {
      case ValueType.PRIMITIVE:
        if (value === undefined)
          return new Placeholder(PlaceholderType.UNDEFINED).toString();
        if (
          typeof value === "string" &&
          (value.startsWith(PLACEHOLDER_PREFIX) ||
            value.startsWith(ESCAPE_CHAR))
        )
          return `${ESCAPE_CHAR}${value}`;
        return value;
      case ValueType.ARRAY:
        return value.map((item: any) => this.sanitize(item, context));
      case ValueType.PLAIN_OBJECT: {
        const result: Record<string, any> = {};
        for (const key in value)
          if (Object.prototype.hasOwnProperty.call(value, key))
            result[key] = this.sanitize(value[key], context);
        return result;
      }
      default: {
        const handler = SANITIZER_TABLE_CONFIG.get(type);
        if (handler) return handler(this, value, context).toString();
        throw new UnsupportedTypeError(
          `Nexus serialization error: Unsupported type "${typeof value}"`,
          { valueType: typeof value },
        );
      }
    }
  }

  private revive(value: any, context: RevivalContext): any {
    if (typeof value === "string" && value.startsWith(ESCAPE_CHAR))
      return value.substring(ESCAPE_CHAR.length);
    const placeholder = Placeholder.fromString(value);
    if (placeholder) {
      const handler = REVIVER_TABLE_CONFIG.get(placeholder.type);
      if (!handler) {
        this.logger.warn(
          `No reviver handler for placeholder type "${placeholder.type}". Returning as is.`,
          placeholder,
        );
        return value;
      }
      if (placeholder.type !== PlaceholderType.RESOURCE)
        return handler(this, placeholder, context);
      // One payload can repeat an identity; keep one facade and one rollback entry.
      const identity = `${context.sourceConnectionId}\u0000${placeholder.payload}`;
      const previous = context.revived.get(identity);
      if (previous) return previous.proxy;
      const existedBeforeRevive = this.resourceManager.hasRemoteProxy(
        placeholder.payload!,
        context.sourceConnectionId,
      );
      const proxy = handler(this, placeholder, context);
      context.revived.set(identity, { proxy, existedBeforeRevive });
      return proxy;
    }
    if (Array.isArray(value))
      return value.map((item: any) => this.revive(item, context));
    if (value !== null && typeof value === "object") {
      // Preserve null-prototype revival: a wire __proto__ key must stay ordinary data.
      const result: Record<string, any> = Object.create(null);
      for (const key in value)
        if (Object.prototype.hasOwnProperty.call(value, key))
          result[key] = this.revive(value[key], context);
      return result;
    }
    return value;
  }
}

function collectResourceIds(
  value: unknown,
  ids = new Set<string>(),
): Set<string> {
  if (value && typeof value === "object") {
    for (const item of Array.isArray(value) ? value : Object.values(value))
      collectResourceIds(item, ids);
  } else {
    const placeholder = Placeholder.fromString(value);
    if (placeholder?.type === PlaceholderType.RESOURCE && placeholder.payload)
      ids.add(placeholder.payload);
  }
  return ids;
}
