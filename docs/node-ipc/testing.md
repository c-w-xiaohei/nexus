# Testing Node IPC Integrations

The node-ipc package includes unit tests and real Unix socket integration tests.

Run the package tests with:

```bash
pnpm --filter @nexus-js/node-ipc test
```

## Unit Tests With Mock Nexus

Use `@nexus-js/testing` for application unit tests that only need to prove how code calls Nexus services.

```ts
const mock = createMockNexus();
mock.service(EchoToken, echoService);

const echo = await mock.nexus.create(EchoToken, {
  target: {
    descriptor: { context: "node-ipc-daemon", appId: "example-app" },
  },
});
```

This does not test node-ipc adapter behavior. It does not open sockets, resolve socket paths, frame packets, run shared-secret auth, detect stale sockets, or prove daemon restart semantics.

## Test Areas

The package test suite covers:

- binary frame half-packet and sticky-packet behavior
- address resolution and path validation
- Unix socket port read/write/disconnect behavior
- stale socket recovery and live daemon protection
- package factory configuration
- shared-secret auth protocol robustness
- real daemon/client RPC
- core `canConnect` and `canCall` integration
- daemon close and recreate behavior
- built package smoke import

## Integration Test Shape

Prefer real socket integration tests for adapter behavior.

A good node-ipc integration test should:

1. create a temporary socket root with `mkdtemp`
2. start a daemon with `usingNodeIpcDaemon`
3. start a client with `usingNodeIpcClient`
4. expose a real service through Nexus core
5. call that service through `nexus.create()`
6. close both runtimes and remove the temporary root

This catches adapter/core integration problems that mocked endpoints cannot catch. Keep real socket integration tests for adapter/core integration problems that `createMockNexus()` intentionally cannot catch.

## Avoiding Flaky Socket Tests

Do not rely on arbitrary sleeps when a deterministic signal is available.

Prefer:

- waiting for the socket file to exist
- waiting for a promise from `listen`
- waiting for a callback to be called
- using short explicit adapter timeouts for timeout tests

Use temporary paths under `os.tmpdir()` and clean them after each test.

## Testing Auth Failures

Auth tests should prove both behavior and cleanup.

For shared-secret pre-auth, cover:

- correct token succeeds
- wrong token fails
- malformed auth message fails
- split socket chunks are buffered correctly
- silent peer times out
- oversized auth line fails
- socket is destroyed after failed client auth

For core policy, cover:

- `canConnect` allow and deny
- `canCall` allow and deny
- denied `canCall` does not invoke the service implementation

## Testing Daemon Restart

Daemon restart tests should assert session-bound behavior:

1. create a proxy and call successfully
2. close the daemon
3. verify the old proxy fails
4. start a new daemon
5. create a fresh proxy
6. verify the fresh proxy succeeds

## Bun Follow-Up

If Bun support becomes a release requirement, add a Bun smoke test outside the default Vitest path or as a CI matrix job.

The minimum useful Bun smoke test is:

- import the built package under Bun
- start a daemon/client pair with filesystem Unix sockets
- make one real Nexus RPC call
- close both sides cleanly

## Related Pages

- Quick start: `docs/node-ipc/quick-start.md`
- Lifecycle and errors: `docs/node-ipc/lifecycle-and-errors.md`
- Runtime compatibility: `docs/node-ipc/runtime-compatibility.md`
