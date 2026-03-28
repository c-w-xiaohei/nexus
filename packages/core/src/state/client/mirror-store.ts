import { Logger } from "@/logger";

type Reconcile<TState extends object> = (
  previous: TState,
  next: TState,
) => TState;

const stateLogger = new Logger("L4-StateMirrorStore");

export type MirrorStoreListenerErrorHandler<TState extends object> = (params: {
  readonly listener: (state: TState) => void;
  readonly state: TState;
  readonly error: unknown;
}) => void;

const defaultListenerErrorHandler = <TState extends object>({
  listener,
  state,
  error,
}: {
  readonly listener: (state: TState) => void;
  readonly state: TState;
  readonly error: unknown;
}): void => {
  stateLogger.error("RemoteStore listener failed.", {
    listenerName: listener.name || "anonymous",
    state,
    error,
  });
};

export interface MirrorStore<TState extends object> {
  getSnapshot(): TState;
  applySnapshot(next: TState): void;
  subscribe(listener: (state: TState) => void): () => void;
  destroy(): void;
}

export interface CreateMirrorStoreOptions<TState extends object> {
  initialState: TState;
  reconcile?: Reconcile<TState>;
  onListenerError?: MirrorStoreListenerErrorHandler<TState>;
}

export const createMirrorStore = <TState extends object>(
  options: CreateMirrorStoreOptions<TState>,
): MirrorStore<TState> => {
  let snapshot = options.initialState;
  const listeners = new Set<(state: TState) => void>();
  const reconcile =
    options.reconcile ?? ((_previous: TState, next: TState) => next);
  const onListenerError =
    options.onListenerError ?? defaultListenerErrorHandler;

  const getSnapshot = (): TState => snapshot;

  const applySnapshot = (next: TState): void => {
    snapshot = reconcile(snapshot, next);

    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        onListenerError({ listener, state: snapshot, error });
      }
    }
  };

  const subscribe = (listener: (state: TState) => void): (() => void) => {
    listeners.add(listener);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) {
        return;
      }

      unsubscribed = true;
      listeners.delete(listener);
    };
  };

  const destroy = (): void => {
    listeners.clear();
  };

  return {
    getSnapshot,
    applySnapshot,
    subscribe,
    destroy,
  };
};
