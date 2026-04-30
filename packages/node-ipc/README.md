# @nexus-js/node-ipc

`@nexus-js/node-ipc` is the Linux-first Nexus adapter for local Node processes. It connects one daemon process and one or more client processes over filesystem Unix domain sockets while preserving Nexus target resolution, authorization policy, and session-bound proxy semantics.

## Addressing

Nexus descriptors identify business targets. Socket addresses are adapter transport details.

Default daemon descriptors use:

```text
$XDG_RUNTIME_DIR/nexus/<appId>/<instance>.sock
```

If `XDG_RUNTIME_DIR` is not set, the fallback is:

```text
/tmp/nexus-<uid>/<appId>/<instance>.sock
```

`instance` defaults to `default`. For example, `{ context: "node-ipc-daemon", appId: "my-cli" }` resolves to `$XDG_RUNTIME_DIR/nexus/my-cli/default.sock` when `XDG_RUNTIME_DIR` is present.

Use `resolveAddress` for custom addressing. Returning `null` means the descriptor cannot be resolved and is reported as `E_IPC_ADDRESS_INVALID`; the adapter does not silently guess another path.

The default resolver rejects unsafe path segments and socket paths longer than the Unix `sun_path` limit. Runtime directories are created with user-private permissions where possible. Existing socket files are treated carefully: a live socket produces `E_IPC_ADDRESS_IN_USE`; a stale socket is removed only after connect failure indicates it is safe to recover. If stale cleanup fails, the adapter reports `E_IPC_STALE_SOCKET_CLEANUP_FAILED`.

## Authentication And Authorization

The adapter supports shared-secret pre-auth before a socket is handed to Nexus core. A failed pre-auth is `E_IPC_AUTH_FAILED`; malformed auth/framing protocol is `E_IPC_PROTOCOL_ERROR`.

After adapter pre-auth, core policy remains the authority:

- `policy.canConnect(context)` decides whether a peer may complete the Nexus handshake. Denial is `E_AUTH_CONNECT_DENIED`.
- `policy.canCall(context)` decides whether a peer may invoke a service path. Denial is returned to the caller as `E_AUTH_CALL_DENIED`.

`UserMetadata` is self-declared logical identity. `PlatformMetadata` carries adapter facts such as socket address and auth method. Current node-ipc platform metadata does not claim peer `pid`, `uid`, or `gid` unless true peer credential support is implemented; local process ids in user metadata are diagnostic self-declarations, not OS-verified peer credentials.

## Framing And Serializer Reality

Unix sockets are byte streams, so node-ipc frames Nexus L1 packets as:

```text
[uint32 byteLength][ArrayBuffer packet bytes]
```

The frame header only restores message boundaries. Nexus message semantics stay in core serializers.

The current core `BinarySerializer` is not MessagePack. It is the compact JSON packet produced by `JsonSerializer`, encoded as a UTF-8 `ArrayBuffer`. This is compatible with node-ipc framing but should not be described as a true MessagePack protocol. MessagePack libraries such as `msgpackr` and `@msgpack/msgpack` are benchmark candidates for a future codec decision.

## Session-Bound Behavior

Node IPC does not make old proxies auto-reconnect. Proxies, refs, callbacks, and pending calls are bound to the Nexus logical connection that created them. If a daemon restarts, the socket disconnects, auth changes, or a session is otherwise lost, old proxies should fail. Create a new connection and call `nexus.create()` again to obtain a fresh proxy.

## Error Codes

Adapter errors:

- `E_IPC_ADDRESS_INVALID`: descriptor or custom resolver result cannot produce a valid socket address.
- `E_IPC_ADDRESS_IN_USE`: another live daemon owns the socket.
- `E_IPC_PATH_TOO_LONG`: filesystem socket path exceeds the platform limit.
- `E_IPC_CONNECT_FAILED`: underlying socket connection failed.
- `E_IPC_AUTH_FAILED`: shared-secret pre-auth failed.
- `E_IPC_PROTOCOL_ERROR`: framing or pre-auth protocol is malformed.
- `E_IPC_STALE_SOCKET_CLEANUP_FAILED`: stale socket recovery could not remove the socket file.

Core authorization errors relevant to node-ipc:

- `E_AUTH_CONNECT_DENIED`: `policy.canConnect` denied the handshake.
- `E_AUTH_CALL_DENIED`: `policy.canCall` denied a service call.

## Public Types

The package exports `NodeIpcError`, `NodeIpcErrorCode`, `NodeIpcAddress`, `NodeIpcAddressResolver`, `NodeIpcSocketAddress`, `NodeIpcUserMeta`, `NodeIpcDaemonMeta`, `NodeIpcClientMeta`, `NodeIpcPlatformMeta`, and the factory option types. Use these types when writing custom resolvers, policies, and error handling.
