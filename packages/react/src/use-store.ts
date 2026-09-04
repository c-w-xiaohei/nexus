import { useDebugValue, useMemo, useSyncExternalStore } from "react";

interface SubscribableStore<TState extends object> {
  getState(): TState;
  getInitialState?: () => TState;
  subscribe(listener: (state: TState) => void): () => void;
}

interface StoreWithInitialState<
  TState extends object,
> extends SubscribableStore<TState> {
  getInitialState(): TState;
}

type StoreSelector<TState extends object, TResult> = (state: TState) => TResult;

const identity = <TState extends object>(state: TState): TState => state;

function assertInitialStateSupport<TState extends object>(
  store: SubscribableStore<TState>,
): asserts store is StoreWithInitialState<TState> {
  if (typeof store.getInitialState !== "function") {
    throw new Error("useStore requires Core >=1.1.0");
  }
}

const createStoreSource = <TState extends object>(
  store: SubscribableStore<TState>,
) => {
  let state: TState | undefined;
  let initialState: TState | undefined;
  let dirty = true;
  let revision = 0;

  return {
    getState() {
      if (dirty || !state) {
        state = store.getState();
        dirty = false;
      }
      return state;
    },
    getInitialState() {
      if (!initialState) {
        assertInitialStateSupport(store);
        initialState = store.getInitialState();
      }
      return initialState;
    },
    getRevision() {
      return revision;
    },
    subscribe(onStoreChange: () => void) {
      const unsubscribe = store.subscribe(() => {
        dirty = true;
        revision += 1;
        onStoreChange();
      });

      // Close updates between rendering the snapshot and registration.
      dirty = true;
      revision += 1;
      onStoreChange();
      return unsubscribe;
    },
  };
};

const createSelectorAdapter = <TState extends object, TResult>(
  source: ReturnType<typeof createStoreSource<TState>>,
  selector: StoreSelector<TState, TResult>,
) => {
  let revision = -1;
  let snapshot: TResult | undefined;
  let serverState: TState | undefined;
  let serverSnapshot: TResult | undefined;

  return {
    subscribe: source.subscribe,
    getSnapshot() {
      const nextRevision = source.getRevision();
      if (revision !== nextRevision) {
        const nextState = source.getState();
        const nextSnapshot = selector(nextState);
        if (!Object.is(snapshot, nextSnapshot)) snapshot = nextSnapshot;
        revision = nextRevision;
      }
      return snapshot as TResult;
    },
    getServerSnapshot() {
      const nextState = source.getInitialState();
      if (serverState !== nextState) {
        serverSnapshot = selector(nextState);
        serverState = nextState;
      }
      return serverSnapshot as TResult;
    },
  };
};

const useStoreSource = <TState extends object>(
  store: SubscribableStore<TState> | null,
) => useMemo(() => (store ? createStoreSource(store) : null), [store]);

const useSelectedStore = <TState extends object, TResult>(
  source: ReturnType<typeof createStoreSource<TState>>,
  selector: StoreSelector<TState, TResult>,
) => {
  const adapter = useMemo(
    () => createSelectorAdapter(source, selector),
    [source, selector],
  );
  return useSyncExternalStore(
    adapter.subscribe,
    adapter.getSnapshot,
    adapter.getServerSnapshot,
  );
};

/**
 * Select state from a concrete Core >=1.1.0 Store handle.
 *
 * Throws `useStore requires Core >=1.1.0` when a runtime store does not
 * implement `getInitialState()`.
 */
export function useStore<TState extends object>(
  store: StoreWithInitialState<TState>,
): TState;
export function useStore<TState extends object, TResult>(
  store: StoreWithInitialState<TState>,
  selector: StoreSelector<TState, TResult>,
): TResult;
export function useStore<TState extends object>(
  store: StoreWithInitialState<TState>,
  selector?: StoreSelector<TState, unknown>,
): unknown {
  assertInitialStateSupport(store);
  const source = useStoreSource(store);
  const snapshot = useSelectedStore(source!, selector ?? identity);
  useDebugValue(snapshot);
  return snapshot;
}

export const useNullableStore = <TState extends object, TResult>(
  store: SubscribableStore<TState> | null,
  selector: StoreSelector<TState, TResult>,
  fallback: TResult,
): TResult => {
  const source = useStoreSource(store);
  const adapter = useMemo(() => {
    if (!store) {
      return {
        subscribe: () => () => undefined,
        getSnapshot: () => fallback,
        getServerSnapshot: () => fallback,
      };
    }
    return createSelectorAdapter(source!, selector);
  }, [fallback, selector, source, store]);
  const snapshot = useSyncExternalStore(
    adapter.subscribe,
    adapter.getSnapshot,
    adapter.getServerSnapshot,
  );
  useDebugValue(snapshot);
  return snapshot as TResult;
};
