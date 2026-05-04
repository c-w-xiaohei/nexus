# Node IPC Authentication

Node-ipc has an adapter-specific shared-secret pre-auth step. Core authorization policy is documented separately in `docs/auth-and-policy.md` because it applies to all adapters.

## What Shared-Secret Pre-Auth Does

Shared-secret pre-auth runs before the socket is handed to Nexus core.

The client sends an auth message. The daemon validates the token. If the token is correct, both sides continue into the Nexus handshake.

Protocol shape:

```json
{ "type": "nexus-ipc-auth", "version": 1, "token": "..." }
```

Success response:

```json
{ "type": "nexus-ipc-auth-ok" }
```

The implementation treats the auth exchange as newline-delimited JSON and buffers split socket chunks until a newline arrives.

## Configure Tokens

Daemon:

```ts
usingNodeIpcDaemon({
  appId: "example-app",
  authToken: process.env.NEXUS_IPC_TOKEN,
});
```

Client:

```ts
usingNodeIpcClient({
  appId: "example-app",
  connectTo: [
    {
      descriptor: { context: "node-ipc-daemon", appId: "example-app" },
    },
  ],
  authToken: process.env.NEXUS_IPC_TOKEN,
});
```

Empty tokens are invalid. If the daemon requires a token and the client sends the wrong token, connection fails with `E_IPC_AUTH_FAILED`.

## Timeouts And Limits

The auth exchange has a timeout so silent peers do not hang forever.

The auth line also has a maximum size. Oversized or malformed auth input fails instead of buffering indefinitely.

Common failures:

- wrong token: `E_IPC_AUTH_FAILED`
- no auth message before timeout: `E_IPC_AUTH_FAILED`
- malformed JSON or wrong protocol shape: `E_IPC_PROTOCOL_ERROR`
- oversized auth line: `E_IPC_PROTOCOL_ERROR`

## Platform Metadata

After pre-auth, node-ipc provides platform metadata to Nexus core:

```ts
{
  socket: { kind: "path", path: "..." },
  authenticated: true,
  authMethod: "shared-secret"
}
```

If no shared secret is configured, `authenticated` is `false` and `authMethod` is `"none"`.

This metadata is the bridge from adapter pre-auth into core policy.

## Combine With Core Policy

Use core `canConnect` to require successful pre-auth:

For policy composition, ask the helper for a pure config object with `configure: false`, then pass that object to `nexus.configure(...)`. This is a low-level bootstrap composition path; the standard path remains calling `usingNodeIpcDaemon(...)` directly and publishing providers with `@nexus.Expose(...)` or `nexus.provide(...)`.

```ts
nexus.configure({
  ...usingNodeIpcDaemon({
    appId: "example-app",
    authToken: process.env.NEXUS_IPC_TOKEN,
    configure: false,
  }),
  policy: {
    canConnect({ platform }) {
      return platform.authenticated === true;
    },
  },
});
```

Use core `canCall` to authorize service operations after the connection exists.

```ts
nexus.configure({
  ...usingNodeIpcDaemon({
    appId: "example-app",
    authToken: process.env.NEXUS_IPC_TOKEN,
    configure: false,
  }),
  policy: {
    canCall({ serviceName, operation }) {
      return serviceName === "example:admin" && operation === "APPLY";
    },
  },
});
```

For `canConnect`, `canCall`, service-level policy, and metadata trust boundaries, read `docs/auth-and-policy.md`.

## What Pre-Auth Does Not Prove

Shared-secret pre-auth proves only that the peer knows the configured token.

It does not prove:

- the peer process executable
- OS user id
- OS group id
- process id authenticity
- user intent

Do not use self-declared `pid` or `groups` as a security boundary unless your application authenticates those claims separately.

## Related Pages

- Shared core policy: `docs/auth-and-policy.md`
- Metadata concepts: `docs/node-ipc/concepts.md`
- Lifecycle and errors: `docs/node-ipc/lifecycle-and-errors.md`
