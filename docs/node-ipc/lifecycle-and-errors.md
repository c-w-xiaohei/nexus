# Node IPC Lifecycle And Errors

This page covers daemon startup, stale sockets, disconnect behavior, and error codes.

## Daemon Startup

Daemon startup does this work:

1. resolve the daemon descriptor to a socket path
2. validate path safety and length
3. check runtime directory safety
4. check whether the socket path already exists
5. recover stale socket files when safe
6. start listening

Startup fails instead of guessing when any safety check is ambiguous.

## Live Daemon Conflict

If another process already owns the socket and accepts connections, startup fails with:

```text
E_IPC_ADDRESS_IN_USE
```

This protects a live daemon from being stolen by a second daemon using the same `appId` and `instance`.

## Stale Socket Recovery

Unix socket files can remain after a process crashes.

If the adapter finds a socket file but cannot connect to it, it treats the file as stale and removes it before listening.

Only socket files are eligible for stale cleanup. Regular files and symlinks are not removed.

Cleanup failure is reported as:

```text
E_IPC_STALE_SOCKET_CLEANUP_FAILED
```

## Connection Lifecycle

After a physical socket connects, Nexus core performs its logical handshake.

The connection becomes usable only after:

1. adapter-level pre-auth succeeds, if configured
2. core handshake messages are exchanged
3. `policy.canConnect` allows the connection, if configured

Handshake timeout protects against peers that accept a socket but never complete Nexus handshake.

## Daemon Restart

When the daemon closes or restarts, existing client proxies are no longer valid.

Raw Nexus handles are session-bound:

- old `nexus.create()` proxies should fail
- old remote refs should be considered invalid
- new work should create a new proxy after reconnecting

This is intentional. Nexus does not silently mutate old raw proxies to point at a new daemon session.

## Error Codes

Node-ipc adapter errors:

| Code                                | Meaning                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| `E_IPC_ADDRESS_INVALID`             | Descriptor or resolver result cannot produce a valid socket address. |
| `E_IPC_ADDRESS_IN_USE`              | Another live daemon owns the socket.                                 |
| `E_IPC_PATH_TOO_LONG`               | Filesystem socket path exceeds the platform limit.                   |
| `E_IPC_CONNECT_FAILED`              | Underlying socket connection failed.                                 |
| `E_IPC_AUTH_FAILED`                 | Shared-secret pre-auth failed or timed out.                          |
| `E_IPC_PROTOCOL_ERROR`              | Framing or pre-auth protocol was malformed.                          |
| `E_IPC_STALE_SOCKET_CLEANUP_FAILED` | Stale socket recovery could not safely remove the socket file.       |

Core authorization errors commonly seen with node-ipc:

| Code                    | Meaning                                     |
| ----------------------- | ------------------------------------------- |
| `E_AUTH_CONNECT_DENIED` | `policy.canConnect` rejected the handshake. |
| `E_AUTH_CALL_DENIED`    | `policy.canCall` rejected a service call.   |

## Debug Checklist

For startup failures:

1. Print the resolved socket path.
2. Check whether another daemon is running with the same `appId` and `instance`.
3. Check directory ownership and permissions.
4. Check whether a regular file or symlink exists at the socket path.
5. Check whether the path exceeds the Unix socket path length limit.

For call failures:

1. Check whether adapter pre-auth succeeded.
2. Check `policy.canConnect`.
3. Check `policy.canCall`.
4. Check whether the proxy was created before a daemon restart.
5. Recreate the proxy after reconnecting.

## Related Pages

- Addressing: `docs/node-ipc/addressing.md`
- Authentication: `docs/node-ipc/auth.md`
- Shared core policy: `docs/auth-and-policy.md`
