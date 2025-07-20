import type { ConnectionManager } from "@/connection/connection-manager";
import type { PlatformMetadata, UserMetadata } from "@/types/identity";
import { NexusMessageType } from "@/types/message";
import type { ApplyMessage, GetMessage, SetMessage } from "@/types/message";
import type { DispatchCallOptions } from "./engine";
import type { PendingCallManager } from "./pending-call-manager";
import type { PayloadProcessor } from "./payload/payload-processor";
import type { ResourceManager } from "./resource-manager";
import type { CallTarget, MessageTarget } from "@/connection/types";
import { Logger } from "@/logger";
import {
  NexusDisconnectedError,
  NexusRemoteError,
  NexusTargetingError,
  NexusNoMatchingConnectionError,
} from "@/errors";

let nextMessageId = 1;

export interface CallProcessorDependencies<
  U extends UserMetadata,
  P extends PlatformMetadata,
> {
  connectionManager: ConnectionManager<U, P>;
  payloadProcessor: PayloadProcessor<U, P>;
  pendingCallManager: PendingCallManager;
  resourceManager: ResourceManager;
}

/**
 * Handles the logic for processing a single outgoing call from a proxy.
 * It encapsulates the entire lifecycle of a dispatch, from resolving
 * connections to sending messages and awaiting responses.
 */
export class CallProcessor<U extends UserMetadata, P extends PlatformMetadata> {
  private readonly logger = new Logger("L3 -> CallProcessor");

  constructor(private readonly deps: CallProcessorDependencies<U, P>) {}

  public process(
    options: DispatchCallOptions & { broadcastOptions?: { strategy: "stream" } }
  ): AsyncIterable<any>;
  public process(options: DispatchCallOptions): Promise<any>;
  public process(
    options: DispatchCallOptions
  ): Promise<any> | AsyncIterable<any> {
    const strategy = options.strategy ?? "first";

    // `executeDispatch` always returns a promise because of its async IIFE.
    const resultPromise = this.executeDispatch(options, strategy);

    if (strategy === "stream") {
      // The promise will resolve to an async iterator. We must return an
      // async iterator synchronously. We do this by wrapping the promise.
      async function* streamWrapper() {
        const iterator = await resultPromise;
        // The result could be an empty iterator if no connections were found,
        // or the promise could have rejected. The for-await loop handles both.
        yield* iterator as AsyncIterable<any>;
      }
      return streamWrapper();
    }

    return resultPromise;
  }

  private _getEmptyResultForStrategy(
    strategy: "one" | "first" | "all" | "stream"
  ): any {
    if (strategy === "stream") {
      return (async function* () {})();
    }
    if (strategy === "one" || strategy === "first") {
      return undefined;
    }
    // For 'all' strategy.
    return [];
  }

  private async _resolveTarget(
    target: CallTarget<U, P>
  ): Promise<MessageTarget<U> | null> {
    // This is the restored logic.
    // If a descriptor is provided, we must resolve it to find/create a connection.
    // This is crucial for `createMulticast`'s "find or create" semantics.
    if ("descriptor" in target && target.descriptor) {
      const resolvedConnection =
        await this.deps.connectionManager.resolveConnection({
          descriptor: target.descriptor as any,
          matcher: "matcher" in target ? (target.matcher as any) : undefined,
        });

      if (resolvedConnection) {
        // We found or created a connection.
        // For 'one'/'first', we bind to it. For 'all'/'stream', this is one of the potential targets.
        // The `sendMessage` logic will handle the fan-out if a matcher is also present.
        return {
          ...target,
          connectionId: resolvedConnection.connectionId,
        };
      }
      // If descriptor was provided but couldn't be resolved, it's a failure.
      return null;
    }
    // No descriptor, so we use the target as is (e.g., a pre-bound connectionId from `create`,
    // or a matcher-only target for broadcast).
    return target as MessageTarget<U>;
  }

  private _buildMessage(
    options: DispatchCallOptions,
    finalTarget: MessageTarget<U>
  ): GetMessage | SetMessage | ApplyMessage {
    const { type, resourceId, path, args, value } = options;
    const messageId = nextMessageId++;
    const tempConnectionIdForSanitize =
      "connectionId" in finalTarget ? finalTarget.connectionId : "broadcast";

    switch (type) {
      case "GET":
        return {
          type: NexusMessageType.GET,
          id: messageId,
          resourceId,
          path,
        };
      case "SET":
        const sanitizedValue = this.deps.payloadProcessor.sanitize(
          [value],
          tempConnectionIdForSanitize
        )[0];
        return {
          type: NexusMessageType.SET,
          id: messageId,
          resourceId,
          path,
          value: sanitizedValue,
        };
      case "APPLY":
        const sanitizedArgs = this.deps.payloadProcessor.sanitize(
          args ?? [],
          tempConnectionIdForSanitize
        );
        return {
          type: NexusMessageType.APPLY,
          id: messageId,
          resourceId,
          path,
          args: sanitizedArgs,
        };
    }
  }

  private _adaptResult(
    result: Promise<any[]>,
    strategy: "one" | "first"
  ): Promise<any> {
    return result.then((results) => {
      if (!results || results.length === 0) {
        if (strategy === "one") {
          throw new NexusTargetingError(
            `Expected exactly one result for a call with strategy 'one', but received 0.`,
            "E_TARGET_UNEXPECTED_COUNT",
            { expected: 1, received: 0 }
          );
        }
        return undefined; // 'first' strategy with no results is undefined
      }

      if (strategy === "one" && results.length !== 1) {
        throw new NexusTargetingError(
          `Expected exactly one result for a call with strategy 'one', but received ${results.length}.`,
          "E_TARGET_UNEXPECTED_COUNT",
          { expected: 1, received: results.length }
        );
      }

      const [firstResult] = results;

      if (firstResult.status === "rejected") {
        // This is a critical change. We wrap the serialized remote error
        // in a specific, catchable error type for the client.
        // Note: PendingCallManager stores errors in 'reason' field, not 'value'
        const remoteError = firstResult.reason;
        throw new NexusRemoteError(
          `Remote call failed: ${remoteError?.message || "Unknown error"}`,
          "E_REMOTE_EXCEPTION",
          { remoteError }
        );
      }
      return firstResult.value;
    });
  }

  private executeDispatch(
    options: DispatchCallOptions,
    strategy: "one" | "first" | "all" | "stream"
  ): Promise<any> {
    return (async () => {
      // 1. Resolve target (now restored to handle descriptors for multicast).
      this.logger.debug("Resolving target...", options.target);
      const finalTarget = await this._resolveTarget(options.target);

      // If resolution fails (e.g., descriptor provided but no endpoint connects),
      // we abort the call.
      if (!finalTarget) {
        this.logger.warn(
          `Could not resolve target, call to [${options.path.join(
            "."
          )}] will not be sent.`,
          options.target
        );
        return this._getEmptyResultForStrategy(strategy);
      }

      this.logger.debug("Target resolved.", {
        original: options.target,
        resolved: finalTarget,
      });

      // 2. Build message.
      const message = this._buildMessage(options, finalTarget);
      this.logger.debug(`Built message #${message.id}`, message);

      // 3. Send message.
      const sentConnectionIds = this.deps.connectionManager.sendMessage(
        finalTarget,
        message
      );
      const sentCount = sentConnectionIds.length;
      this.logger.debug(
        `Message #${message.id} sent to ${sentCount} connection(s)`,
        sentConnectionIds
      );

      // Handle cases where no connections were found first.
      if (sentCount === 0) {
        // Case A: The call was targeted to a specific connectionId that
        // is now closed. This is a hard error.
        if ("connectionId" in finalTarget && finalTarget.connectionId) {
          throw new NexusDisconnectedError(
            `Call failed. The connection "${finalTarget.connectionId}" was closed or is no longer available.`,
            "E_CONN_CLOSED",
            { connectionId: finalTarget.connectionId, path: options.path }
          );
        }

        // Case B: For broadcasts ('all', 'stream'), finding 0 connections is a
        // valid, empty result. The 'first' strategy is also handled here,
        // as L4's `create` with `expects: 'first'` already ensures a
        // connection exists at creation time. If it drops later, it's covered
        // by Case A. If it's a multicast `createMulticast`, then an empty
        // result is expected.
        this.logger.debug(
          `Message #${message.id} found no matching connections for its target. Returning empty result for strategy '${strategy}'.`,
          finalTarget
        );
        return this._getEmptyResultForStrategy(strategy);
      }

      // If we've reached here, sentCount > 0.
      // The 'one' strategy check is simplified because L4's `create` already
      // guarantees a single connectionId was passed. If that single send
      // failed, it would be caught by `sentCount === 0`. If for some reason
      // (e.g. a groupName resolved to >1) we got multiple, we still check.
      if (strategy === "one" && sentCount !== 1) {
        throw new NexusTargetingError(
          `Expected to send to exactly one target for a call with strategy 'one', but sent to ${sentCount}.`,
          "E_TARGET_UNEXPECTED_COUNT",
          { expected: 1, received: sentCount, path: options.path }
        );
      }

      // 4. Register pending call.
      this.logger.debug(`Registering pending call for message #${message.id}`);
      const timeout = options.timeout ?? options.proxyOptions?.timeout ?? 5000;
      const isBroadcast =
        "matcher" in finalTarget || "groupName" in finalTarget;
      const pendingStrategy = strategy === "stream" ? "stream" : "all";

      const result = this.deps.pendingCallManager.register(message.id, {
        strategy: pendingStrategy,
        isBroadcast,
        sentConnectionIds,
        timeout,
      });

      // 5. Post-process results for non-stream strategies
      if (strategy === "first" || strategy === "one") {
        this.logger.debug(
          `Adapting result for message #${message.id} with strategy '${strategy}'`
        );
        return this._adaptResult(result as Promise<any[]>, strategy);
      }

      // For 'all' and 'stream' strategies, return the raw result from the manager.
      return result;
    })().catch((err) => {
      // This centralized catch handles both sync errors from the initial setup
      // and async errors from the IIFE. We rethrow to reject the promise.
      this.logger.error(
        `Unhandled error during dispatch to path [${options.path.join(".")}].`,
        err
      );
      return Promise.reject(err);
    });
  }
}
