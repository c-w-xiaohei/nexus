import type { AdapterModel } from "@/types/adapter-model";
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
} from "./protocol";
import { Logger } from "@/logger";
import { Result } from "better-result";
import { NexusProtocolError, toFrameworkProtocolError } from "@/errors";

type RevivalContext = {
  sourceConnectionId: string;
  callTimeout?: number;
  revived: Map<string, { proxy: object; existedBeforeRevive: boolean }>;
};
type SanitizeContext = {
  targetConnectionId: string;
  createdResourceIds: string[];
  serviceName?: string;
  servicePolicy?: NexusAuthorizationPolicy<AdapterModel>;
};

/** Transactional payload conversion for one Engine, with session-owned capabilities. */
export class PayloadProcessor {
  private readonly logger = new Logger("L3 --- PayloadProcessor");
  /** Shares the Engine's capability registry and proxy factory across independent payload transactions. */
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
    callTimeout?: number,
  ): Result<any[], Error> {
    const context: RevivalContext = {
      sourceConnectionId,
      callTimeout,
      revived: new Map(),
    };
    const result = Result.try({
      try: () => {
        const revived = this.revive(args, context);
        return Array.isArray(revived) ? revived : [revived];
      },
      catch: toFrameworkProtocolError,
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

  /** Run one transactional encoding pass and roll back IDs on conversion failure. */
  private safeSanitizeWithContext(
    args: any[],
    context: Omit<SanitizeContext, "createdResourceIds">,
  ): Result<any[], Error> {
    const createdResourceIds: string[] = [];
    const result = Result.try({
      try: () => {
        const encoded = this.sanitize(args, { ...context, createdResourceIds });
        return Array.isArray(encoded) ? encoded : [encoded];
      },
      catch: toFrameworkProtocolError,
    });
    // Encoding is transactional until a message is accepted by the connection.
    if (result.isErr())
      for (const id of createdResourceIds)
        this.resourceManager.releaseLocalResource(id);
    return result;
  }

  /** Recursively encode values and allocate session-owned capability IDs. */
  private sanitize(value: any, context: SanitizeContext): any {
    if (typeof value === "function" || isRefWrapper(value)) {
      const id = this.resourceManager.registerLocalResource(
        typeof value === "function" ? value : value.target,
        context.targetConnectionId,
        context.serviceName || undefined,
        context.serviceName ? context.servicePolicy : undefined,
      );
      context.createdResourceIds.push(id);
      return Placeholder.encode(PlaceholderType.RESOURCE, id);
    }
    if (value === undefined)
      return Placeholder.encode(PlaceholderType.UNDEFINED);
    if (typeof value === "string")
      return value.startsWith(PLACEHOLDER_PREFIX) ||
        value.startsWith(ESCAPE_CHAR)
        ? ESCAPE_CHAR + value
        : value;
    if (typeof value === "bigint")
      return Placeholder.encode(PlaceholderType.BIGINT, value.toString());
    if (value instanceof Map)
      return Placeholder.encode(
        PlaceholderType.MAP,
        JSON.stringify([...value]),
      );
    if (value instanceof Set)
      return Placeholder.encode(
        PlaceholderType.SET,
        JSON.stringify([...value]),
      );
    if (Array.isArray(value))
      return value.map((item) => this.sanitize(item, context));
    if (value !== null && typeof value === "object") {
      const result: Record<string, any> = Object.create(null);
      for (const key of Object.keys(value))
        result[key] = this.sanitize(value[key], context);
      return result;
    }
    return value;
  }

  /** Recursively decode placeholders, sharing identities within one payload. */
  private revive(value: any, context: RevivalContext): any {
    if (typeof value === "string" && value.startsWith(ESCAPE_CHAR))
      return value.substring(ESCAPE_CHAR.length);
    const placeholder = Placeholder.fromString(value);
    if (placeholder) {
      if (placeholder.type !== PlaceholderType.RESOURCE) {
        const handler = REVIVER_TABLE_CONFIG.get(placeholder.type);
        if (handler) return handler(placeholder.payload!);
        this.logger.warn(
          `No reviver handler for placeholder type "${placeholder.type}". Returning as is.`,
          placeholder,
        );
        return value;
      }
      if (!placeholder.payload)
        throw new NexusProtocolError(
          "Resource placeholder requires a non-empty ID.",
        );
      // One payload can repeat an identity; keep one facade and one rollback entry.
      const identity = placeholder.payload;
      const previous = context.revived.get(identity);
      if (previous) return previous.proxy;
      const existedBeforeRevive = this.resourceManager.hasRemoteProxy(
        identity,
        context.sourceConnectionId,
      );
      const proxy = this.proxyFactory.createRemoteResourceProxy(
        identity,
        context.sourceConnectionId,
        context.callTimeout,
      );
      context.revived.set(identity, { proxy, existedBeforeRevive });
      return proxy;
    }
    if (Array.isArray(value))
      return value.map((item: any) => this.revive(item, context));
    if (value !== null && typeof value === "object") {
      // Preserve null-prototype revival: a wire __proto__ key must stay ordinary data.
      const result: Record<string, any> = Object.create(null);
      for (const key of Object.keys(value))
        result[key] = this.revive(value[key], context);
      return result;
    }
    return value;
  }
}

/** Collect resource placeholders so an unaccepted payload can release its IDs. */
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
