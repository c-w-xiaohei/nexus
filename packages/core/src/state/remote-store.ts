import { createStore } from "zustand/vanilla";
import { Result } from "better-result";
import { Logger } from "@/logger";
import { NexusStoreDisconnectedError, NexusStoreProtocolError } from "./errors";
import {
  disposeSubscription,
  safeParsePayload,
  safeValidateState,
  SyncEnvelopeSchema,
  type SyncEnvelope,
} from "./protocol";
import type {
  RemoteActions,
  RemoteStore,
  RemoteStoreStatus,
  StoreData,
  StoreValidationSchemas,
} from "./contract";

type Failure = NexusStoreDisconnectedError | NexusStoreProtocolError;

/**
 * Keeps a synchronous Zustand mirror for local consumers. Core owns the action
 * proxies; this adapter only orders snapshots and releases subscription capabilities.
 * Returning from onSync acknowledges application, including local listener delivery.
 */
export function createRemoteStore<Store extends object>(
  validation?: StoreValidationSchemas<Store>,
) {
  const logger = new Logger("StateMirror");
  const mirror = createStore<{
    state: StoreData<Store> | null;
    status: RemoteStoreStatus;
  }>(() => ({ state: null, status: { type: "initializing" } }));
  const buffered: SyncEnvelope<StoreData<Store>, Store>[] = [];
  const cleanup = new Set<() => void>();
  const localUnsubscribers = new Set<() => void>();
  let initialState: StoreData<Store> | null = null;
  let actions = {} as RemoteActions<Store>;
  let failure: Failure | null = null;
  const isTerminal = () => {
    const { type } = mirror.getState().status;
    return type !== "ready" && type !== "initializing";
  };

  // ===== Lifecycle and ownership =====

  const addCleanup = (stop: () => void) => {
    if (isTerminal()) {
      try {
        stop();
      } catch {
        /* best effort */
      }
    } else cleanup.add(stop);
  };
  /** First terminal cause wins; explicit destroy can still remove local observers. */
  const finish = (
    error: Failure,
    reason?: "target-changed" | "target-replaced" | "destroyed",
    version?: number,
  ) => {
    if (isTerminal() && reason !== "destroyed") return;
    const { status } = mirror.getState();
    const lastKnownVersion =
      version ??
      (status.type === "ready"
        ? status.version
        : "lastKnownVersion" in status
          ? status.lastKnownVersion
          : null);
    failure = error;
    buffered.length = 0;
    let nextStatus: RemoteStoreStatus;
    if (reason === "destroyed") nextStatus = { type: "destroyed" };
    else if (reason) nextStatus = { type: "stale", lastKnownVersion, reason };
    else nextStatus = { type: "disconnected", lastKnownVersion, cause: error };
    mirror.setState({ status: nextStatus });
    for (const stop of cleanup) {
      cleanup.delete(stop);
      try {
        stop();
      } catch {
        /* Continue independent cleanup. */
      }
    }
  };
  const stale = () =>
    finish(
      new NexusStoreDisconnectedError("Store target changed."),
      "target-changed",
    );
  const safeReady = () => {
    if (failure) return Result.err(failure);
    if (mirror.getState().status.type === "ready") return Result.ok(undefined);
    return Result.err(
      new NexusStoreProtocolError(
        "Subscribe completed without an initial snapshot.",
      ),
    );
  };

  // ===== Callback validation and snapshot ordering =====

  const safeApplyEvent = (event: SyncEnvelope<StoreData<Store>, Store>) => {
    const { status } = mirror.getState();
    if (isTerminal()) return safeReady();
    if (
      status.type === "ready" &&
      status.storeInstanceId !== event.storeInstanceId
    ) {
      if (event.type !== "terminal") stale();
      return safeReady();
    }
    if (event.type === "terminal") {
      finish(
        new NexusStoreDisconnectedError(
          `Store became terminal (${event.reason}).`,
          { cause: event.error },
        ),
        event.reason === "target-changed" || event.reason === "target-replaced"
          ? event.reason
          : undefined,
        event.lastKnownVersion,
      );
      return safeReady();
    }
    if (status.type === "ready" && event.version <= status.version)
      return Result.ok(undefined);

    // State and status are visible atomically; normal Zustand registration order
    // controls notifications. A reentrant update supersedes the older notification.
    mirror.setState({
      state: event.state,
      status: {
        type: "ready",
        storeInstanceId: event.storeInstanceId,
        version: event.version,
      },
    });
    return safeReady();
  };

  /** Throw-style callback boundary: reject its RPC when the mirror cannot apply it. */
  const onSync = (input: unknown): void => {
    // Init carries ownership even after timeout. Reclaim it before rejecting ACK.
    const eventError = (cause: unknown) =>
      new NexusStoreProtocolError("State event failed.", { cause });
    const result = Result.gen(function* () {
      const isInit = yield* Result.try({
        try: () => {
          const isInit = !!(
            input &&
            typeof input === "object" &&
            (input as { type?: unknown }).type === "init"
          );
          if (isInit) addCleanup(() => disposeSubscription(input as object));
          return isInit;
        },
        catch: eventError,
      });
      if (isTerminal())
        return isInit && failure ? Result.err(failure) : Result.ok(undefined);
      const parsed = yield* safeParsePayload(
        SyncEnvelopeSchema,
        input,
        "Invalid state event.",
      );
      if (parsed.type !== "terminal")
        yield* safeValidateState(
          parsed.state,
          validation?.state,
          "Invalid snapshot state.",
        );
      const event = parsed as SyncEnvelope<StoreData<Store>, Store>;
      if (event.type !== "init" && initialState === null) {
        buffered.push(event);
        return Result.ok(undefined);
      }
      if (event.type !== "init") return safeApplyEvent(event);
      if (initialState !== null)
        return Result.err(
          new NexusStoreProtocolError("Duplicate initial snapshot."),
        );
      const baseline = yield* Result.try({
        try: () => ({ state: structuredClone(event.state) }),
        catch: eventError,
      });
      initialState = baseline.state;
      actions = event.actions;
      const pending = buffered.splice(0);
      // Separate callback requests can arrive before init. A matching terminal
      // wins; otherwise install the baseline before replaying buffered updates.
      const terminalEvent = pending.find(
        (item) =>
          item.type === "terminal" &&
          item.storeInstanceId === event.storeInstanceId,
      );
      yield* safeApplyEvent(terminalEvent ?? event);
      for (const item of pending)
        if (item.type !== "terminal") yield* safeApplyEvent(item);
      return safeReady();
    });
    if (result.isErr()) {
      finish(result.error);
      throw result.error;
    }
  };

  // ===== Public synchronous read handle =====

  const store: RemoteStore<Store> = {
    get actions() {
      return actions;
    },
    getState() {
      const state = mirror.getState().state;
      if (state === null)
        throw new NexusStoreDisconnectedError("Store is still initializing.");
      return state;
    },
    getInitialState() {
      if (initialState === null)
        throw new NexusStoreDisconnectedError("Store is still initializing.");
      return initialState;
    },
    getStatus: () => mirror.getState().status,
    subscribe(listener) {
      const stop = mirror.subscribe((next, previous) => {
        if (
          next !== mirror.getState() ||
          next.state === null ||
          next.status.type !== "ready" ||
          next.status === previous.status
        )
          return;
        try {
          listener(next.state, previous.state ?? next.state);
        } catch (error) {
          logger.error("State listener failed", error);
        }
      });
      localUnsubscribers.add(stop);
      return () => {
        localUnsubscribers.delete(stop);
        stop();
      };
    },
    subscribeStatus(listener) {
      if (mirror.getState().status.type === "destroyed") return () => undefined;
      const stop = mirror.subscribe((next, previous) => {
        if (next !== mirror.getState() || next.status === previous.status)
          return;
        try {
          listener();
        } catch (error) {
          logger.error("State status listener failed", error);
        }
      });
      localUnsubscribers.add(stop);
      return () => {
        localUnsubscribers.delete(stop);
        stop();
      };
    },
    destroy() {
      if (mirror.getState().status.type === "destroyed") return;
      finish(
        new NexusStoreDisconnectedError("Store is destroyed."),
        "destroyed",
      );
      for (const stop of localUnsubscribers) stop();
      localUnsubscribers.clear();
    },
    [Symbol.dispose]() {
      this.destroy();
    },
  };
  return {
    store,
    onSync,
    safeReady,
    addCleanup,
    disconnect: (message: string) =>
      finish(new NexusStoreDisconnectedError(message)),
    stale,
  };
}
