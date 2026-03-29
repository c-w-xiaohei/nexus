# Nexus State Quick Start

This Nexus State guide gets a remote store running with the smallest useful setup.

## Before You Start

This Nexus State quick start assumes:

- you already have Nexus itself configured between two contexts
- one context will host the store
- another context will connect to it
- you are using `@nexus-js/core` already for cross-context transport

If you do not already have Nexus contexts communicating, start with `docs/getting-started.md` and come back here once the transport path exists.

## What To Install

Choose the smallest Nexus State surface you need:

- always required foundation: `@nexus-js/core`
- use for headless state APIs: `@nexus-js/core/state` (an entrypoint from `@nexus-js/core`)
- add for React hooks and provider: `@nexus-js/react`

In practice, React apps usually install `@nexus-js/core` and `@nexus-js/react`, while non-React integrations often only install `@nexus-js/core` and use the state entrypoint.

## What You Build

You will:

- define a store in `@nexus-js/core/state`
- host it in one Nexus context
- connect to it from another context
- read state, subscribe to updates, and invoke actions

## 1. Define A Store

```ts
import { Token } from "@nexus-js/core";
import { defineNexusStore } from "@nexus-js/core/state";

type CounterState = { count: number };

type CounterActions = {
  increment(by?: number): Promise<number>;
  reset(): Promise<void>;
};

const CounterStoreToken = new Token("example:counter-store");

export const counterStore = defineNexusStore<CounterState, CounterActions>({
  token: CounterStoreToken,
  state: () => ({ count: 0 }),
  actions: ({ getState, setState }) => ({
    async increment(by = 1) {
      setState({ count: getState().count + by });
      return getState().count;
    },
    async reset() {
      setState({ count: 0 });
    },
  }),
});
```

## 2. Host The Store

Register the Nexus State store like any other Nexus service.

```ts
import { nexus } from "@nexus-js/core";
import { provideNexusStore } from "@nexus-js/core/state";
import { counterStore } from "./counter-store";

nexus.configure({
  services: [provideNexusStore(counterStore)],
});
```

Nexus State does not introduce a parallel registry. A store is still hosted through ordinary Nexus service registration.

## 3. Connect From Another Context

```ts
import { nexus } from "@nexus-js/core";
import { connectNexusStore } from "@nexus-js/core/state";
import { counterStore } from "./counter-store";

const remoteCounter = await connectNexusStore(nexus, counterStore, {
  target: {
    descriptor: { context: "background" },
  },
});
```

At this point you have a `RemoteStore`, which is a local mirror handle for a remote authoritative store.

## 4. Read, Subscribe, And Dispatch

```ts
console.log(remoteCounter.getState().count);

const stop = remoteCounter.subscribe((state) => {
  console.log("count changed", state.count);
});

await remoteCounter.actions.increment(2);

stop();
remoteCounter.destroy();
```

## Headless Lifecycle And Cleanup Recipe

Use this pattern in non-React services, workers, or scripts:

```ts
const remote = await connectNexusStore(nexus, counterStore, options);

const unsubscribe = remote.subscribe((state) => {
  // Process remote updates.
  console.log(state);
});

try {
  await remote.actions.increment(1);
  const snapshot = remote.getState();
  console.log(snapshot.count);
} finally {
  // Always release both listener and handle.
  unsubscribe();
  remote.destroy();
}
```

If a connection closes and the handle becomes `disconnected`, create a new `RemoteStore` instance for a new attempt instead of reusing the old instance.

## 5. React Usage

If you only need the Nexus State headless runtime, you can stop after step 4.

If you are building a React app, wrap your tree with `NexusProvider` first.

```tsx
import {
  NexusProvider,
  useRemoteStore,
  useStoreSelector,
} from "@nexus-js/react";

function App() {
  return (
    <NexusProvider nexus={nexus}>
      <CounterView />
    </NexusProvider>
  );
}

function CounterView() {
  const remote = useRemoteStore(counterStore, {
    target: { descriptor: { context: "background" } },
  });

  const count = useStoreSelector(remote, (state) => state.count, {
    fallback: 0,
  });

  if (!remote.store || remote.status.type !== "ready") {
    return <span>Loading...</span>;
  }

  return (
    <button onClick={() => remote.store.actions.increment(1)}>{count}</button>
  );
}
```

## What To Read Next

- `docs/state/concepts.md` for the Nexus State mental model
- `docs/state/core-api.md` for the full Nexus State headless API
- `docs/state/react.md` for Nexus State React lifecycle and selector details
- `docs/state/lifecycle-and-errors.md` for Nexus State disconnect, stale, and action semantics

## When To Use The Safe API

Use throw-style APIs when you want the simplest happy-path call sites:

```ts
const remote = await connectNexusStore(nexus, counterStore, options);
```

Use safe-style APIs when you want explicit error composition:

```ts
import { safeConnectNexusStore } from "@nexus-js/core/state";

const result = await safeConnectNexusStore(nexus, counterStore, options);
```

If your app already uses `Result` / `ResultAsync`, the safe APIs fit naturally. If not, start with throw-style and move to safe-style where you need tighter control.
