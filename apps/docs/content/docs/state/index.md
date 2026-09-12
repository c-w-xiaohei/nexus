---
title: Nexus State Documentation
description: Overview and navigation for the Nexus State subsystem.
---

Nexus State is the synchronized remote-state subsystem for Nexus. It provides a headless runtime through the `@nexus-js/core/state` entrypoint and React bindings in `@nexus-js/react`.

Use this section for Nexus State-specific setup, runtime semantics, and API details.

Create a StoreToken with `createStoreToken<Store>(id, options?)`, then create stores with `const { provider, store } = createNexusStore(token, nativeCreator, options)` and register `provider` through the ordinary provider path, for example `nexus.configure({ providers: [provider] })`. The returned `store` is the original native Zustand API. For an already-created store, use `bindNexusStore(token, store, options)` instead. The required options explicitly project shared data with `snapshot` and allow remote action keys with `expose`; `publishWindowMs` defaults to 200 and `maxPendingSnapshots` to 32. Store default targeting comes from the store token's `defaultTarget`; Nexus State does not add a separate default target field.

For general application-level unit tests with an injectable mock `NexusInstance`, also read [Testing](/nexus/docs/testing/).

## Start Here

- New to Nexus State: [Quick start](/nexus/docs/state/quick-start/)
- Mental model and lifecycle semantics: [Concepts](/nexus/docs/state/concepts/)
- Headless API reference: [Core API](/nexus/docs/state/core-api/)
- React integration guide: [React](/nexus/docs/state/react/)
- Lifecycle and error behavior: [Lifecycle and errors](/nexus/docs/state/lifecycle-and-errors/)
- Testing guidance: [Testing](/nexus/docs/state/testing/)
- Common questions: [FAQ](/nexus/docs/state/faq/)
- State relay across adjacent Nexus graphs: [Relay](/nexus/docs/relay/)

## Package Routing

- Headless runtime entrypoint: `@nexus-js/core/state` (from `@nexus-js/core`)
- React bindings: `@nexus-js/react`
- Foundation framework: `@nexus-js/core`
- Relay entrypoint for bridge contexts: `@nexus-js/core/relay`
- Application unit testing utilities: `@nexus-js/testing`

If you are looking for product-level Nexus docs, go to [Nexus Documentation](/nexus/docs/).
