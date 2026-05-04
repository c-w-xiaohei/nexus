# Nexus State Documentation

Nexus State is the synchronized remote-state subsystem for Nexus. It provides a headless runtime through the `@nexus-js/core/state` entrypoint and React bindings in `@nexus-js/react`.

Use this section for Nexus State-specific setup, runtime semantics, and API details.

Host stores with the ordinary provider path, for example `nexus.provide(provideNexusStore(store))`. Store default targeting comes from the store token's `defaultCreate.target`; Nexus State does not add a separate default target field.

## Start Here

- New to Nexus State: `docs/state/quick-start.md`
- Mental model and lifecycle semantics: `docs/state/concepts.md`
- Headless API reference: `docs/state/core-api.md`
- React integration guide: `docs/state/react.md`
- Lifecycle and error behavior: `docs/state/lifecycle-and-errors.md`
- Testing guidance: `docs/state/testing.md`
- Common questions: `docs/state/faq.md`
- State relay across adjacent Nexus graphs: `docs/relay.md`

## Package Routing

- Headless runtime entrypoint: `@nexus-js/core/state` (from `@nexus-js/core`)
- React bindings: `@nexus-js/react`
- Foundation framework: `@nexus-js/core`
- Relay entrypoint for bridge contexts: `@nexus-js/core/relay`

If you are looking for product-level Nexus docs, go to `docs/README.md`.
