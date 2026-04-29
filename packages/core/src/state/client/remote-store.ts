import {
  NexusStoreActionError,
  NexusStoreDisconnectedError,
  NexusStoreProtocolError,
} from "../errors";
import {
  Result,
  ResultAsync,
  err,
  errAsync,
  ok,
  type Result as R,
} from "neverthrow";
import {
  DispatchResultEnvelopeSchema,
  SnapshotEnvelopeSchema,
  SubscribeResultSchema,
} from "../protocol";
import type {
  ActionArgs,
  ActionResult,
  NexusStoreValidationSchemas,
  NexusStoreServiceContract,
  RemoteStore,
  RemoteActions,
  RemoteStoreStatus,
} from "../types";
import { createMirrorStore, type MirrorStore } from "./mirror-store";
import { MARK_REMOTE_STORE_STALE_SYMBOL } from "../stale-marker";

type ActionFunction = (...args: any[]) => any;

interface VersionWaiter {
  readonly isSatisfied: (version: number) => boolean;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RemoteStoreEntityOptions {
  readonly actionCommitTimeoutMs?: number;
}

const DEFAULT_ACTION_COMMIT_TIMEOUT_MS = 30000;

const createDisconnectedError = (
  message: string,
  cause?: unknown,
): NexusStoreDisconnectedError =>
  new NexusStoreDisconnectedError(message, cause ? { cause } : undefined);

const hasDisconnectErrorCode = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === "E_CONN_CLOSED" || code === "E_STORE_DISCONNECTED";
};

const isStructuredDisconnectError = (error: unknown): boolean => {
  if (error instanceof NexusStoreDisconnectedError) {
    return true;
  }

  return hasDisconnectErrorCode(error);
};

const isObjectLike = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

export class RemoteStoreEntity<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
> implements RemoteStore<TState, TActions> {
  [MARK_REMOTE_STORE_STALE_SYMBOL](): void {
    this.markStaleByTargetChange();
  }

  private readonly mirror: MirrorStore<TState>;
  private readonly actionProxy: RemoteActions<TActions>;
  private readonly validation?: NexusStoreValidationSchemas<TState, TActions>;
  private readonly actionCommitTimeoutMs: number;
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
  private readonly transportCleanupCallbacks = new Set<() => void>();

  constructor(
    private readonly service: NexusStoreServiceContract<TState, TActions>,
    initialState: TState,
    validation?: NexusStoreValidationSchemas<TState, TActions>,
    options: RemoteStoreEntityOptions = {},
  ) {
    this.validation = validation;
    this.actionCommitTimeoutMs =
      options.actionCommitTimeoutMs ?? DEFAULT_ACTION_COMMIT_TIMEOUT_MS;
    this.mirror = createMirrorStore({ initialState });

    this.actionProxy = new Proxy(
      {},
      {
        get: (_target, propertyKey) => {
          if (typeof propertyKey !== "string") {
            return undefined;
          }

          return (...args: unknown[]) =>
            this.invokeActionOrThrow(
              propertyKey as keyof TActions & string,
              args as any,
            );
        },
      },
    ) as RemoteActions<TActions>;
  }

  public get actions(): RemoteActions<TActions> {
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

    this.runTransportCleanup();

    this.mirror.destroy();
  }

  public setDisconnectSubscriptionCleanup(cleanup: () => void): void {
    this.transportCleanupCallbacks.add(cleanup);
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

    this.runTransportCleanup();
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
  ): ResultAsync<ActionResult<TActions, K>, Error> {
    return this.safeInvokeActionResult(action, args);
  }

  // ===== Action =====

  private async invokeActionOrThrow<K extends keyof TActions & string>(
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
            Result.fromThrowable(
              () => {
                const dispatch = this.service.dispatch;
                return dispatch(action, args);
              },
              (error) => error,
            )().match(
              (promise) => promise,
              (error) => Promise.reject(error),
            ),
            (error) => error,
          )
    )
      .andThen((dispatchResult) => {
        const parsed = Result.fromThrowable(
          () => this.safeParseDispatchResult<K>(action, dispatchResult),
          (error) => error,
        )();

        if (parsed.isErr()) {
          return errAsync(parsed.error);
        }

        if (parsed.value.isErr()) {
          return errAsync(parsed.value.error);
        }

        return ResultAsync.fromPromise(
          Promise.resolve(parsed.value.value),
          (error) => error,
        );
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

    this.runTransportCleanup();
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

    this.runTransportCleanup();
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
      let waiter!: VersionWaiter;
      const timer = setTimeout(() => {
        this.versionWaiters.delete(waiter);
        const timeoutError = new NexusStoreProtocolError(
          `Committed snapshot not observed within ${this.actionCommitTimeoutMs}ms after dispatch acknowledgement.`,
        );
        this.transitionToProtocolError(timeoutError);
        reject(timeoutError);
      }, this.actionCommitTimeoutMs);

      waiter = {
        isSatisfied,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      };

      this.versionWaiters.add(waiter);
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
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  }

  private rejectAllVersionWaiters(error: Error): void {
    for (const waiter of Array.from(this.versionWaiters)) {
      this.versionWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private runTransportCleanup(): void {
    for (const cleanup of Array.from(this.transportCleanupCallbacks)) {
      this.transportCleanupCallbacks.delete(cleanup);
      try {
        cleanup();
      } catch {
        // best-effort cleanup only
      }
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
    const parsedResult = Result.fromThrowable(
      () => SnapshotEnvelopeSchema.safeParse(event),
      (error) => error,
    )();
    if (parsedResult.isErr()) {
      return err(
        new NexusStoreProtocolError("Invalid snapshot envelope.", {
          cause: parsedResult.error,
        }),
      );
    }

    const parsed = parsedResult.value;
    if (!parsed.success) {
      return err(
        new NexusStoreProtocolError("Invalid snapshot envelope.", {
          cause: parsed.error,
        }),
      );
    }

    const validatedState = this.safeValidateState(
      parsed.data.state,
      "Invalid snapshot state payload.",
    );
    if (validatedState.isErr()) {
      return err(validatedState.error);
    }

    return ok({
      type: "snapshot",
      storeInstanceId: parsed.data.storeInstanceId,
      version: parsed.data.version,
      state: validatedState.value,
    });
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
    const parsedResult = Result.fromThrowable(
      () => SubscribeResultSchema.safeParse(baseline),
      (error) => error,
    )();
    if (parsedResult.isErr()) {
      return err(
        new NexusStoreProtocolError("Invalid subscribe baseline envelope.", {
          cause: parsedResult.error,
        }),
      );
    }

    const parsed = parsedResult.value;
    if (!parsed.success) {
      return err(
        new NexusStoreProtocolError("Invalid subscribe baseline envelope.", {
          cause: parsed.error,
        }),
      );
    }

    const validatedState = this.safeValidateState(
      parsed.data.state,
      "Invalid subscribe baseline state payload.",
    );
    if (validatedState.isErr()) {
      return err(validatedState.error);
    }

    return ok({
      storeInstanceId: parsed.data.storeInstanceId,
      subscriptionId: parsed.data.subscriptionId,
      version: parsed.data.version,
      state: validatedState.value,
    });
  }

  private safeParseDispatchResult<K extends keyof TActions & string>(
    action: K,
    dispatchResult: unknown,
  ): R<
    {
      type: "dispatch-result";
      committedVersion: number;
      result: ActionResult<TActions, K>;
    },
    NexusStoreProtocolError
  > {
    const parsedDispatchResultResult = Result.fromThrowable(
      () => DispatchResultEnvelopeSchema.safeParse(dispatchResult),
      (error) => error,
    )();
    if (parsedDispatchResultResult.isErr()) {
      return err(
        new NexusStoreProtocolError("Invalid dispatch result envelope.", {
          cause: parsedDispatchResultResult.error,
        }),
      );
    }

    const parsedDispatchResult = parsedDispatchResultResult.value;
    if (!parsedDispatchResult.success) {
      return err(
        new NexusStoreProtocolError("Invalid dispatch result envelope.", {
          cause: parsedDispatchResult.error,
        }),
      );
    }

    const validatedResult = this.safeValidateActionResult(
      action,
      parsedDispatchResult.data.result,
    );
    if (validatedResult.isErr()) {
      return err(validatedResult.error);
    }

    return ok({
      type: "dispatch-result",
      committedVersion: parsedDispatchResult.data.committedVersion,
      result: validatedResult.value,
    });
  }

  private safeValidateState(
    state: unknown,
    message: string,
  ): Result<TState, NexusStoreProtocolError> {
    const stateSchema = this.validation?.state;
    if (stateSchema) {
      const parsed = stateSchema.safeParse(state);
      if (!parsed.success) {
        return err(
          new NexusStoreProtocolError(message, { cause: parsed.error }),
        );
      }

      return ok(parsed.data);
    }

    if (!isObjectLike(state)) {
      return err(
        new NexusStoreProtocolError(message, {
          cause: new TypeError("State payload must be a non-null object."),
        }),
      );
    }

    return ok(state as TState);
  }

  private safeValidateActionResult<K extends keyof TActions & string>(
    action: K,
    result: unknown,
  ): Result<ActionResult<TActions, K>, NexusStoreProtocolError> {
    const actionSchema = this.validation?.actionResults?.[action];
    if (!actionSchema) {
      return ok(result as ActionResult<TActions, K>);
    }

    const parsed = actionSchema.safeParse(result);
    if (!parsed.success) {
      return err(
        new NexusStoreProtocolError(
          `Invalid dispatch result payload for action "${action}".`,
          { cause: parsed.error },
        ),
      );
    }

    return ok(parsed.data as ActionResult<TActions, K>);
  }

  private normalizeActionInvocationError(error: unknown): Error {
    if (isStructuredDisconnectError(error)) {
      if (
        this.status.type === "stale" &&
        this.terminalActionError instanceof NexusStoreDisconnectedError
      ) {
        return this.terminalActionError;
      }

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
