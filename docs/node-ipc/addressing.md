# Node IPC Addressing

Node-ipc addressing maps Nexus daemon descriptors to filesystem Unix socket paths.

## Default Descriptor

The daemon descriptor is:

```ts
{
  context: "node-ipc-daemon";
  appId: string;
  instance?: string;
}
```

`instance` defaults to `default`.

Use instances when one app has more than one local daemon role:

```ts
usingNodeIpcDaemon({ appId: "example-app", instance: "indexer" });
usingNodeIpcDaemon({ appId: "example-app", instance: "sync" });
```

## Default Filesystem Paths

When `XDG_RUNTIME_DIR` is set, the default path is:

```text
$XDG_RUNTIME_DIR/nexus/<appId>/<instance>.sock
```

When `XDG_RUNTIME_DIR` is not set, the fallback is:

```text
/tmp/nexus-<uid>/<appId>/<instance>.sock
```

Examples:

```text
/run/user/1000/nexus/example-app/default.sock
/tmp/nexus-1000/example-app/default.sock
```

## Segment Validation

The default resolver rejects unsafe `appId` and `instance` segments.

Rejected examples:

- empty strings
- `.`
- `..`
- values containing `/`
- values containing `\`
- values that make the final socket path exceed the Unix socket path limit

This keeps descriptor input from becoming path traversal.

## Custom Resolver

Use a custom resolver when your application owns a specific socket layout.

```ts
usingNodeIpcClient({
  appId: "example-app",
  resolveAddress(descriptor) {
    if (descriptor.context !== "node-ipc-daemon") return null;
    if (descriptor.appId !== "example-app") return null;
    return { kind: "path", path: "/run/user/1000/example-app.sock" };
  },
});
```

Returning `null` means the descriptor is not resolvable. Nexus treats that as an address error instead of guessing another path.

Custom paths must be absolute filesystem paths and must fit the platform socket path limit.

## Runtime Directory Safety

Daemon startup creates adapter-owned directories with user-private permissions where possible.

The adapter checks the directories it owns before binding:

- symlink directories are rejected
- non-directories are rejected
- unsafe group/world-writable runtime roots are rejected
- normal system ancestors such as `/`, `/run`, `/run/user`, and `/tmp` are allowed when they have safe ownership semantics

The adapter should not silently chmod directories it does not own. If you use a custom path under an unsafe directory, fix the directory ownership and permissions explicitly in your application or installer.

## Existing Socket Paths

If the socket path already exists, daemon startup checks whether it belongs to a live daemon.

Outcomes:

- live socket: startup fails with `E_IPC_ADDRESS_IN_USE`
- stale socket file: the adapter removes it and starts listening
- regular file: startup fails
- symlink: startup fails
- cleanup error: startup fails with `E_IPC_STALE_SOCKET_CLEANUP_FAILED`

The adapter does not blindly unlink unknown filesystem entries.

## Abstract Socket Addresses

The public address type reserves an abstract socket form:

```ts
{ kind: "abstract", name: string }
```

Filesystem path sockets are the default supported path. Treat abstract namespace support as reserved unless the package docs and tests for your target version explicitly cover it.

## Related Pages

- Quick start: `docs/node-ipc/quick-start.md`
- Lifecycle and errors: `docs/node-ipc/lifecycle-and-errors.md`
