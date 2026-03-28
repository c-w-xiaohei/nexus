import {
  NexusStoreActionError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
} from "../errors";
import { ResultAsync, err, errAsync, ok, type Result } from "neverthrow";
import {
  DispatchResultEnvelopeSchema,
  SnapshotEnvelopeSchema,
  SubscribeResultSchema,
} from "../protocol";
import type {
  ActionArgs,
  ActionResult,
  NexusStoreServiceContract,
  RemoteStore,
  RemoteStoreStatus,
} from "../types";
import { createMirrorStore, type MirrorStore } from "./mirror-store";
import { MARK_REMOTE_STORE_STALE_SYMBOL } from "../stale-marker";

type ActionFunction = (...args: any[]) => any;

interface VersionWaiter {
  readonly isSatisfied: (version: number) => boolean;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

const createDisconnectedError = (
  message: string,
  cause?: unknown,
): NexusStoreDisconnectedError =>
  new NexusStoreDisconnectedError(message, cause ? { cause } : undefined);

const isDisconnectLikeError = (error: unknown): boolean => {
  if (error instanceof NexusStoreDisconnectedError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const signature = `${error.name}:${error.message}`.toLowerCase();
  return signature.includes("disconnect") || signature.includes("connection");
};

export class RemoteStoreEntity<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
> implements RemoteStore<TState, TActions> {
  [MARK_REMOTE_STORE_STALE_SYMBOL](): void {
    this.markStaleByTargetChange();
  }

  private readonly mirror: MirrorStore<TState>;
  private readonly actionProxy: TActions;
  private status: RemoteStoreStatus = { type: "initializing" };
  private readonly pendingEvents: Array<{
    type: "snapshot";
    storeInstanceId: string;
    version: number;
    state: TState;
  }> = [];
  private readonly versionWaiters = new Set<VersionWaiter>();
  private subscriptionId: string | null = null;
  private storeInstanceId: string | null = null;
  private version: number | null = null;
  private terminalActionError:
    | NexusStoreProtocolError
    | NexusStoreDisconnectedError
    | null = null;
  private unsubscribeRequested = false;
  private handshakeCompleted = false;
  private terminal = false;
  private cleanupDisconnectSubscription: (() => void) | null = null;

  constructor(
    private readonly service: NexusStoreServiceContract<TState, TActions>,
    initialState: TState,
  ) {
    this.mirror = createMirrorStore({ initialState });

    this.actionProxy = new Proxy(
      {},
      {
        get: (_target, propertyKey) => {
          if (typeof propertyKey !== "string") {
            return undefined;
          }

          return (...args: unknown[]) =>
            this.invokeAction(
              propertyKey as keyof TActions & string,
              args as any,
            );
        },
      },
    ) as TActions;
  }

  public get actions(): TActions {
    return this.actionProxy;
  }

  public getState(): TState {
    return this.mirror.getSnapshot();
  }

  public subscribe(listener: (state: TState) => void): () => void {
    return this.mirror.subscribe(listener);
  }

  public getStatus(): RemoteStoreStatus {
    return this.status;
  }

  public getTerminalError():
    | NexusStoreProtocolError
    | NexusStoreDisconnectedError
    | null {
    return this.terminalActionError;
  }

  public destroy(): void {
    if (this.status.type === "destroyed") {
      return;
    }

    this.status = { type: "destroyed" };
    this.terminal = true;
    this.terminalActionError = createDisconnectedError(
      "Remote store is destroyed.",
    );
    this.rejectAllVersionWaiters(this.terminalActionError);

    if (!this.unsubscribeRequested && this.subscriptionId) {
      this.unsubscribeRequested = true;
      void this.service.unsubscribe(this.subscriptionId).catch(() => undefined);
    }

    if (this.cleanupDisconnectSubscription) {
      this.cleanupDisconnectSubscription();
      this.cleanupDisconnectSubscription = null;
    }

    this.mirror.destroy();
  }

  public setDisconnectSubscriptionCleanup(cleanup: () => void): void {
    if (this.cleanupDisconnectSubscription) {
      this.cleanupDisconnectSubscription();
    }

    this.cleanupDisconnectSubscription = cleanup;
  }

  public onTransportDisconnect(message: string): void {
    const disconnected = createDisconnectedError(message);
    this.transitionToDisconnected(disconnected);
  }

  public markStaleByTargetChange(): void {
    if (this.terminal || this.status.type === "destroyed") {
      return;
    }

    this.status = {
      type: "stale",
      lastKnownVersion: this.version,
      reason: "target-changed",
    };
    this.terminal = true;
    const staleError = createDisconnectedError(
      "Remote store target changed and this handle is now stale.",
    );
    this.terminalActionError = staleError;
    this.rejectAllVersionWaiters(staleError);
    this.tryUnsubscribeBestEffort();

    if (this.cleanupDisconnectSubscription) {
      this.cleanupDisconnectSubscription();
      this.cleanupDisconnectSubscription = null;
    }
  }

  public onSync(event: unknown): void {
    if (this.terminal) {
      return;
    }

    const parsed = this.safeParseSnapshot(event);
    if (parsed.isErr()) {
      this.transitionToProtocolError(parsed.error);
      return;
    }

    const snapshot = parsed.value;

    if (!this.handshakeCompleted) {
      this.pendingEvents.push(snapshot);
      return;
    }

    this.applyIncomingSnapshot(snapshot, "event");
  }

  public completeHandshake(baseline: unknown): void {
    if (this.terminal) {
      return;
    }

    const parsed = this.safeParseBaseline(baseline);
    if (parsed.isErr()) {
      this.transitionToProtocolError(parsed.error);
      return;
    }

    const data = parsed.value;

    this.subscriptionId = data.subscriptionId;
    this.handshakeCompleted = true;
    this.applyIncomingSnapshot(
      {
        type: "snapshot",
        storeInstanceId: data.storeInstanceId,
        version: data.version,
        state: data.state,
      },
      "baseline",
    );

    for (const event of this.pendingEvents.splice(0)) {
      this.applyIncomingSnapshot(event, "event");
    }
  }

  public safeInvokeAction<K extends keyof TActions & string>(
    action: K,
    args: ActionArgs<TActions, K>,
  ): Promise<ActionResult<TActions, K>> {
    return this.invokeAction(action, args);
  }

  // ===== Action =====

  private async invokeAction<K extends keyof TActions & string>(
    action: K,
    args: ActionArgs<TActions, K>,
  ): Promise<ActionResult<TActions, K>> {
    return this.safeInvokeActionResult(action, args).match(
      (value) => value,
      (error) => {
        throw error;
      },
    );
  }

  private safeInvokeActionResult<K extends keyof TActions & string>(
    action: K,
    args: ActionArgs<TActions, K>,
  ): ResultAsync<ActionResult<TActions, K>, Error> {
    const readiness = this.safeEnsureActionReady();

    return (
      readiness.isErr()
        ? errAsync(readiness.error)
        : ResultAsync.fromPromise(
            this.service.dispatch(action, args),
            (error) => error,
          )
    )
      .andThen((dispatchResult) => {
        const parsed = this.safeParseDispatchResult<K>(dispatchResult);
        if (parsed.isErr()) {
          return errAsync(parsed.error);
        }

        return ResultAsync.fromSafePromise(Promise.resolve(parsed.value));
      })
      .andThen((payload) =>
        ResultAsync.fromPromise(
          this.waitForVersion(
            (version) => version >= payload.committedVersion,
          ).then(() => payload.result),
          (error) => error,
        ),
      )
      .mapErr((error) => this.normalizeActionInvocationError(error));
  }

  private safeEnsureActionReady(): Result<void, Error> {
    if (this.status.type === "ready") {
      if (this.terminalActionError) {
        return err(this.terminalActionError);
      }
      return ok(undefined);
    }

    if (this.status.type === "disconnected") {
      return err(
        this.terminalActionError ??
          createDisconnectedError("Remote store is disconnected."),
      );
    }

    if (this.status.type === "stale") {
      return err(
        createDisconnectedError("Remote store is stale and no longer usable."),
      );
    }

    if (this.status.type === "destroyed") {
      return err(createDisconnectedError("Remote store is destroyed."));
    }

    return err(createDisconnectedError("Remote store is still initializing."));
  }

  // ===== Snapshot State Machine =====

  private applyIncomingSnapshot(
    event: {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: TState;
    },
    source: "baseline" | "event",
  ): void {
    if (this.terminal) {
      return;
    }

    if (
      this.storeInstanceId &&
      this.storeInstanceId !== event.storeInstanceId
    ) {
      this.markStaleByTargetChange();
      return;
    }

    const previousVersion = this.version;
    const nextVersion = event.version;

    if (previousVersion !== null && nextVersion < previousVersion) {
      if (source === "baseline") {
        return;
      }

      this.transitionToProtocolError(
        new NexusStoreProtocolError(
          `Snapshot version regressed from ${previousVersion} to ${nextVersion}.`,
        ),
      );
      return;
    }

    if (previousVersion !== null && nextVersion === previousVersion) {
      return;
    }

    this.storeInstanceId = event.storeInstanceId;
    this.version = nextVersion;
    this.status = {
      type: "ready",
      storeInstanceId: event.storeInstanceId,
      version: nextVersion,
    };

    this.mirror.applySnapshot(event.state);
    this.resolveVersionWaiters();
  }

  private transitionToProtocolError(error: NexusStoreProtocolError): void {
    if (this.terminal) {
      return;
    }

    this.status = {
      type: "disconnected",
      lastKnownVersion: this.version,
      cause: error,
    };
    this.terminal = true;
    this.terminalActionError = error;
    this.rejectAllVersionWaiters(error);
    this.tryUnsubscribeBestEffort();

    if (this.cleanupDisconnectSubscription) {
      this.cleanupDisconnectSubscription();
      this.cleanupDisconnectSubscription = null;
    }
  }

  private transitionToDisconnected(error: NexusStoreDisconnectedError): void {
    if (this.terminal) {
      return;
    }

    this.status = {
      type: "disconnected",
      lastKnownVersion: this.version,
      cause: error,
    };
    this.terminal = true;
    this.terminalActionError = error;
    this.rejectAllVersionWaiters(error);
    this.tryUnsubscribeBestEffort();

    if (this.cleanupDisconnectSubscription) {
      this.cleanupDisconnectSubscription();
      this.cleanupDisconnectSubscription = null;
    }
  }

  // ===== Version Waiters =====

  private waitForVersion(
    isSatisfied: (version: number) => boolean,
  ): Promise<void> {
    const currentVersion = this.version;
    if (currentVersion !== null && isSatisfied(currentVersion)) {
      return Promise.resolve();
    }

    const gate = this.safeEnsureActionReady();
    if (gate.isErr()) {
      return Promise.reject(gate.error);
    }

    return new Promise<void>((resolve, reject) => {
      this.versionWaiters.add({ isSatisfied, resolve, reject });
    });
  }

  private resolveVersionWaiters(): void {
    const currentVersion = this.version;
    if (currentVersion === null) {
      return;
    }

    for (const waiter of Array.from(this.versionWaiters)) {
      if (waiter.isSatisfied(currentVersion)) {
        this.versionWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  private rejectAllVersionWaiters(error: Error): void {
    for (const waiter of Array.from(this.versionWaiters)) {
      this.versionWaiters.delete(waiter);
      waiter.reject(error);
    }
  }

  private tryUnsubscribeBestEffort(): void {
    if (!this.subscriptionId || this.unsubscribeRequested) {
      return;
    }

    this.unsubscribeRequested = true;
    void this.service.unsubscribe(this.subscriptionId).catch(() => undefined);
  }

  private safeParseSnapshot(event: unknown): Result<
    {
      type: "snapshot";
      storeInstanceId: string;
      version: number;
      state: TState;
    },
    NexusStoreProtocolError
  > {
    const parsed = SnapshotEnvelopeSchema.safeParse(event);
    if (!parsed.success) {
      return err(
        new NexusStoreProtocolError("Invalid snapshot envelope.", {
          cause: parsed.error,
        }),
      );
    }

    return ok(
      parsed.data as {
        type: "snapshot";
        storeInstanceId: string;
        version: number;
        state: TState;
      },
    );
  }

  private safeParseBaseline(baseline: unknown): Result<
    {
      storeInstanceId: string;
      subscriptionId: string;
      version: number;
      state: TState;
    },
    NexusStoreProtocolError
  > {
    const parsed = SubscribeResultSchema.safeParse(baseline);
    if (!parsed.success) {
      return err(
        new NexusStoreProtocolError("Invalid subscribe baseline envelope.", {
          cause: parsed.error,
        }),
      );
    }

    return ok(
      parsed.data as {
        storeInstanceId: string;
        subscriptionId: string;
        version: number;
        state: TState;
      },
    );
  }

  private safeParseDispatchResult<K extends keyof TActions & string>(
    dispatchResult: unknown,
  ): Result<
    {
      type: "dispatch-result";
      committedVersion: number;
      result: ActionResult<TActions, K>;
    },
    NexusStoreProtocolError
  > {
    const parsedDispatchResult =
      DispatchResultEnvelopeSchema.safeParse(dispatchResult);
    if (!parsedDispatchResult.success) {
      return err(
        new NexusStoreProtocolError("Invalid dispatch result envelope.", {
          cause: parsedDispatchResult.error,
        }),
      );
    }

    return ok(
      parsedDispatchResult.data as {
        type: "dispatch-result";
        committedVersion: number;
        result: ActionResult<TActions, K>;
      },
    );
  }

  private normalizeActionInvocationError(error: unknown): Error {
    if (isDisconnectLikeError(error)) {
      const disconnected = createDisconnectedError(
        "Store action disconnected before commit acknowledgement (unknown commit).",
        error,
      );
      this.transitionToDisconnected(disconnected);
      return disconnected;
    }

    if (error instanceof NexusStoreProtocolError) {
      this.transitionToProtocolError(error);
      return error;
    }

    return new NexusStoreActionError("Store action failed.", { cause: error });
  }
}
