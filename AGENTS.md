# AGENTS.md

Guidance for agentic coding agents working in this repository.

## Project Overview

Nexus is a type-safe, default-safe cross-context communication framework for JavaScript runtimes.
It exposes a unified `nexus` API for service exposure, typed remote proxies, connection routing,
remote resource references, state synchronization, and platform adapters such as Chrome extension
contexts.

This is a pnpm/Turbo monorepo. Current packages are `@nexus-js/core`, `@nexus-js/chrome`,
`@nexus-js/react`, and `@nexus-js/node-ipc`.

No Cursor rules (`.cursor/rules/`, `.cursorrules`) or Copilot instructions
(`.github/copilot-instructions.md`) are present at the time this file was written.

## Repository Map

- `packages/core` - core runtime, RPC engine, connection management, transport abstractions, and Nexus State.
- `packages/chrome` - Chrome extension adapter and `using...` context helpers.
- `packages/react` - React bindings for Nexus State.
- `packages/node-ipc` - Node IPC adapter for daemon/client runtimes.
- `docs` - public documentation.
- `.doc` - internal proposals, plans, and mandatory style guidance.
- `.agents/skills` - project-level agent skills, including `use-nexus` for external usage style.

## Collaboration Defaults

- Treat `AGENTS.md` as the source of truth for agent guidance. `CLAUDE.md` is only a compatibility symlink.
- Keep changes scoped to the request and prefer editing existing files over creating new files.
- Do not commit or push unless the user explicitly asks for it.
- If GitHub issues, pull requests, or branch names are relevant to the task, inspect them with `gh` before coding instead of guessing context from titles.
- For unfamiliar or high-risk CLI usage, check `--help` first. Fixed project commands such as `pnpm test` do not need repeated help checks.

## Design Principles

- Do not add a new abstraction, module, or configuration unless it solves a verified problem.
- Prefer low cognitive overhead over theoretically perfect encapsulation; make the obvious use case obvious.
- Reduce boilerplate while preserving complete behavior, testability, and maintainability.
- For architecture, public API, or cross-package changes, be able to state why the change is needed, whether a simpler option exists, and whether the result lowers cognitive load.

## Package Manager

- Use `pnpm`, not npm or yarn.
- Root package manager is `pnpm@10.5.2`.
- Run commands from the repository root unless a package-specific command explicitly needs another directory.

## Build, Lint, Test

Install dependencies:

```bash
pnpm install -w
```

Build, lint, type-check, and test all packages:

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

Format TypeScript and Markdown:

```bash
pnpm format
```

Run package tests:

```bash
pnpm --filter @nexus-js/core test
pnpm --filter @nexus-js/chrome test
pnpm --filter @nexus-js/react test
```

Run a single test file:

```bash
pnpm --filter @nexus-js/core test -- src/path/to/file.test.ts
pnpm --filter @nexus-js/chrome test -- src/path/to/file.test.ts
pnpm --filter @nexus-js/react test -- src/path/to/file.test.ts
```

Run one test by name:

```bash
pnpm --filter @nexus-js/core test -- -t "test name"
```

Run package type-checks or builds:

```bash
pnpm --filter @nexus-js/core typecheck
pnpm --filter @nexus-js/chrome build
pnpm --filter @nexus-js/react build
```

Development watch mode:

```bash
pnpm dev
```

## Verification Expectations

- Run the narrowest relevant test first when changing behavior.
- Run `pnpm typecheck` before claiming type-level or public API work is complete.
- Run `pnpm build` when exports, package boundaries, Vite config, or declarations may be affected.
- Run `pnpm lint` when changing TypeScript source or ESLint environment assumptions.
- For docs-only changes, run `pnpm exec prettier --check <files>` on edited Markdown.

## TypeScript And Formatting

- TypeScript is strict; root `tsconfig.json` enables `strict`, `isolatedModules`, `noUnusedLocals`, and `noUnusedParameters`.
- Use ESM syntax. Packages are `type: "module"`.
- Prefer explicit exported types for public APIs.
- Use `import type` for type-only imports.
- Keep imports direct and stable; avoid unnecessary internal barrels when a local module import is clearer.
- Formatting is controlled by Prettier. Do not hand-format against Prettier output.
- Keep source and docs ASCII unless nearby content already uses non-ASCII or the content requires it.

## Comments And Design Notes

- Add JSDoc for public APIs when behavior, lifecycle, error modes, or type-level contracts are not obvious from the signature.
- Use design comments for protocol, connection lifecycle, serialization, state synchronization, authorization, and cross-runtime behavior when future maintainers would otherwise need to reconstruct intent from code.
- Comments should explain intent, invariants, and tradeoffs; avoid restating what the code already says.
- When implementation follows an issue, proposal, or reference document, cite that source near the relevant code path if it materially affects the design.

## Naming Conventions

- Use `PascalCase` for classes, types, interfaces, namespaces, and tokens such as `PingToken`.
- Use `camelCase` for functions, methods, variables, and object properties.
- Use `SCREAMING_SNAKE_CASE` only for true global-style constants.
- Name safe APIs with a `safe` prefix when they return `Result` or `ResultAsync`.
- Name throw-style public wrappers without `safe`, for example `create` or `configure`.
- Keep token IDs stable and namespaced. Prefer `TokenSpace` for structured token IDs.

## Mandatory Internal Style

- Read `.doc/style.md` before non-trivial implementation work.
- Internal recoverable errors in `core` and adapters must use `Result` / `ResultAsync` with railway-oriented composition.
- Do not use implicit throws for expected business/control-flow failures inside core/adapters.
- Public APIs may expose both throw-style and safe-style interfaces.
- Use the shared `fn` helper from `packages/core/src/utils/fn.ts` for schema-backed business logic functions when appropriate.
- Prefer discriminated unions over optional-field variants.
- Never expose internal mutable `Map` or `Set` instances on public interfaces; expose methods or `ReadonlyMap` getters.

## Module Organization

- Use **Namespace + Functions** for data-transparent or stateless layers, such as serializers and transport helpers.
- Use **Closure Factory** for opaque capability bundles with hidden mutable state and no system-level identity.
- Use **Class** for entities with system-level identity, lifecycle orchestration, state machines, or circular dependencies requiring `this`.
- When a closure factory returns an object with methods, do not add equivalent namespace-level wrapper functions like `(runtime, ...args)`.
- Keep pure calculation helpers at module scope when they do not need instance state.

## Error Handling

- Use `neverthrow` `Result` and `ResultAsync` for recoverable internal paths.
- Preserve structured error codes and context when wrapping errors.
- Treat authorization denial, targeting misses, disconnects, and validation failures as expected control flow where applicable.
- Throw only at public throw-style boundaries, constructor/configuration misuse boundaries, or truly unrecoverable cases.
- Tests should assert error codes for expected failures, not only error messages.

## Nexus Public Usage Style

- Put service contracts and `Token`s in shared code imported by all participating contexts.
- Prefer `TokenSpace.defaultCreate.target` for hierarchical token IDs and inherited create defaults.
- Import existing service types instead of redefining service shapes inline.
- Configure every runtime context before creating proxies or other demand operations. Register static class/providers before the bootstrap snapshot, or use live `provide(...)` after `ready`.
- Prefer adapter helpers like `usingBackgroundScript()` and `usingContentScript()` for standard runtime setup.
- Use `nexus.configure(...)` for runtime bootstrap configuration: custom endpoints, multi-instance tests, policy, matchers, descriptors, and low-level composition.
- Use `@xxNexus.Expose(...)` for class services, where `xxNexus` is the configured owner instance. Use `xxNexus.provide(...)` for object services, State stores, Relay providers, runtime-created dependencies, and live provider registration.
- Use `nexus.create(Token)` when a Token `defaultCreate.target` or unique `connectTo` fallback intentionally supplies the target; use explicit targets plus `expects` in introductory debugging or complex topology examples.
- Raw `nexus.create(...)` proxies and refs are session-bound. Recreate them after disconnect, daemon restart, or session replacement.
- See `.agents/skills/use-nexus/references/usage-style.md` for detailed external usage style.

## React Code

- Follow existing React patterns in `packages/react`.
- Do not add `useMemo` or `useCallback` by default unless existing code or a measured issue calls for it.
- Keep hooks typed and package exports stable.
- Verify React changes with `pnpm --filter @nexus-js/react test` and `pnpm --filter @nexus-js/react typecheck`.

## Testing Style

- Tests use Vitest.
- Prefer focused unit tests for pure helpers and integration tests for cross-layer behavior.
- For transport/connection behavior, include real integration coverage when mocks would miss ordering, lifecycle, or serialization issues.
- Avoid arbitrary sleeps in async tests when a deterministic signal can be awaited.
- Keep tests close to the package they exercise.

## Documentation And Git

- Public docs live in `docs/`; internal proposals and style notes live in `.doc/`.
- Keep adapter docs focused on adapter-specific setup; do not redefine shared service contracts in every adapter guide.
- Prefer minimal, type-correct examples with explicit targets first, then explain defaults or shortcuts.
- Keep documentation changes minimal and preserve the surrounding terminology, tone, and structure.
- If changing external usage guidance, update `.agents/skills/use-nexus` when relevant.
- Add a changeset when a change affects published package behavior, public APIs, or documented user-facing capabilities.
- Use `patch` for bug fixes, internal implementation changes, docs/tests, and non-breaking dependency metadata updates.
- Use `minor` for new public APIs, new subpath exports, optional capabilities, backward-compatible behavior, and first-party packages following compatible `core` capabilities.
- Use `major` only when users must change code, a public contract is removed or changed, a supported runtime/install combination is truly dropped, or wire protocol/interoperability becomes incompatible.
- Do not treat `peerDependencies` range edits as major by themselves; bump major only when the supported compatibility matrix is actually narrowed.
- Do not let a `core` minor automatically force downstream majors; version adapters and React bindings by their own public API and real compatibility impact.
- PR titles should follow `<type>(<scope>): <description>` when a conventional-commit style title fits the change.
- PR descriptions should include `Why`, `What`, `How verified`, and `Risks`; link related issues, proposals, or docs when available.
- After pushing or opening a PR, use `gh pr checks`, `gh run list`, or `gh run watch` when asked to follow CI status.
- Use concise review comment labels when helpful: `issue`, `suggestion`, `question`, `blocked`, `decision`, or `note`.
- Do not edit `dist/` outputs directly.
- Keep changes scoped to the task. Do not revert unrelated user changes.
- `CLAUDE.md` is a compatibility symlink to this file; update `AGENTS.md` as the source of truth.
