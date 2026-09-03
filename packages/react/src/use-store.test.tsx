import { renderHook } from "@testing-library/react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createNexusStore, defineNexusStore } from "@nexus-js/core/state";
import { Token } from "@nexus-js/core";
import { useNullableStore, useStore } from "./use-store.js";

interface TestStore<TState extends object> {
  getState(): TState;
  getInitialState(): TState;
  subscribe(listener: (state: TState) => void): () => void;
}

const createStore = <TState extends object>(initialState: TState) => {
  let state = initialState;
  const listeners = new Set<(state: TState) => void>();
  const subscribe = vi.fn((listener: (state: TState) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  return {
    getState: () => ({ ...state }),
    getInitialState: () => initialState,
    subscribe,
    setState(nextState: TState) {
      state = nextState;
      for (const listener of listeners) listener(state);
    },
  } satisfies TestStore<TState> & { setState(nextState: TState): void };
};

describe("useStore", () => {
  it("selects whole state and selected values from a structural store", () => {
    const store = createStore({ count: 0, label: "zero" });
    const whole = renderHook(() => useStore(store));
    const selected = renderHook(() => useStore(store, (state) => state.count));

    expect(whole.result.current).toEqual({ count: 0, label: "zero" });
    expect(selected.result.current).toBe(0);

    act(() => store.setState({ count: 1, label: "one" }));

    expect(whole.result.current).toEqual({ count: 1, label: "one" });
    expect(selected.result.current).toBe(1);
  });

  it("suppresses updates whose selected output is Object.is equal", () => {
    const store = createStore({ count: 0, label: "zero" });
    const selector = vi.fn((state: { count: number }) => state.count);
    renderHook(() => useStore(store, selector));
    selector.mockClear();

    act(() => store.setState({ count: 0, label: "changed" }));

    expect(selector).toHaveBeenCalledOnce();
  });

  it("keeps an inline object selector stable for a local Nexus Store handle", async () => {
    type LocalState = { nested: { value: number }; count: number };
    const { store } = createNexusStore(
      defineNexusStore<LocalState, Record<string, never>>({
        token: new Token("react:inline-selector"),
        state: () => ({ nested: { value: 1 }, count: 0 }),
        actions: () => ({}),
      }),
    );
    let renders = 0;
    const { result, rerender } = renderHook(() => {
      renders += 1;
      return useStore(store, (state) => state.nested);
    });

    expect(result.current).toEqual({ value: 1 });
    const rendersBeforeRerender = renders;
    rerender();

    expect(renders).toBe(rendersBeforeRerender + 1);
    expect(result.current).toEqual({ value: 1 });
  });

  it("reads authoritative state after reentrant notifications", () => {
    let state = { count: 0 };
    const listeners = new Set<(nextState: typeof state) => void>();
    const store: TestStore<typeof state> & {
      setState(nextState: typeof state): void;
    } = {
      getState: () => state,
      getInitialState: () => ({ count: 0 }),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setState(nextState) {
        state = nextState;
        for (const listener of listeners) listener(nextState);
      },
    };
    const reentrantListener = (nextState: typeof state) => {
      if (nextState.count === 1) store.setState({ count: 2 });
    };
    store.subscribe(reentrantListener);
    const { result } = renderHook(() =>
      useStore(store, (nextState) => nextState.count),
    );

    act(() => store.setState({ count: 1 }));

    expect(result.current).toBe(2);
  });

  it("closes the read-subscribe race", () => {
    const store = createStore({ count: 0 });
    const originalSubscribe = store.subscribe;
    store.subscribe = vi.fn((listener) => {
      const unsubscribe = originalSubscribe(listener);
      store.setState({ count: 1 });
      return unsubscribe;
    });

    const { result } = renderHook(() =>
      useStore(store, (state) => state.count),
    );

    expect(result.current).toBe(1);
  });

  it("uses initial state without subscribing during SSR", () => {
    const store = createStore({ count: 0 });
    store.setState({ count: 3 });
    const App = () => (
      <output>{useStore(store, (state) => state.count)}</output>
    );

    expect(renderToString(<App />)).toContain("0");
    expect(store.subscribe).not.toHaveBeenCalled();
  });

  it("preserves the Store receiver when reading initial state", () => {
    class ClassStore implements TestStore<{ count: number }> {
      private readonly initialState = { count: 2 };

      getState() {
        return this.initialState;
      }

      getInitialState() {
        return this.initialState;
      }

      subscribe() {
        return () => undefined;
      }
    }

    const store = new ClassStore();
    const App = () => (
      <output>{useStore(store, (state) => state.count)}</output>
    );

    expect(renderToString(<App />)).toContain("2");
  });

  it("rejects a Core 1.0-shaped store on the client", () => {
    const store = {
      getState: () => ({ count: 0 }),
      subscribe: () => () => undefined,
    };

    expect(() => renderHook(() => useStore(store as never))).toThrow(
      "useStore requires Core >=1.1.0",
    );
  });

  it("rejects a Core 1.0-shaped store during SSR", () => {
    const store = {
      getState: () => ({ count: 0 }),
      subscribe: () => () => undefined,
    };
    const App = () => (
      <output>
        {useStore(store as unknown as TestStore<{ count: number }>).count}
      </output>
    );

    expect(() => renderToString(<App />)).toThrow(
      "useStore requires Core >=1.1.0",
    );
  });

  it("uses only getInitialState during SSR and switches to live state on hydration", async () => {
    const store = createStore({ count: 0 });
    const getState = vi.fn<() => { count: number }>(() => {
      throw new Error("SSR must not read live state");
    });
    const subscribe = vi.fn<
      (listener: (state: { count: number }) => void) => () => boolean
    >(() => {
      throw new Error("SSR must not subscribe");
    });
    store.getState = getState;
    store.subscribe = subscribe;
    const App = () => (
      <output>{useStore(store, (state) => state.count)}</output>
    );
    const markup = renderToString(<App />);
    const container = document.createElement("div");
    container.innerHTML = markup;

    expect(markup).toContain("0");
    expect(getState).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();

    getState.mockReturnValue({ count: 1 });
    subscribe.mockImplementation((listener) => {
      void listener;
      return () => false;
    });
    await act(async () => {
      hydrateRoot(container, <App />);
    });

    expect(container.textContent).toBe("1");
    expect(subscribe).toHaveBeenCalled();
  });

  it("surfaces selector errors caused by later state updates", () => {
    const store = createStore({ count: 0 });
    const { result } = renderHook(() =>
      useStore(store, (state) => {
        if (state.count > 0) throw new Error("invalid count");
        return state.count;
      }),
    );

    expect(() => act(() => store.setState({ count: 1 }))).toThrow(
      "invalid count",
    );
    expect(result.current).toBe(0);
  });

  it("returns an object fallback unchanged", () => {
    const fallback = { fallback: 1, label: "pending" };
    const { result } = renderHook(() =>
      useNullableStore(null, () => fallback, fallback),
    );

    expect(result.current).toBe(fallback);
  });
});
