---
title: Runtime Compatibility
description: Runtime and platform requirements for the Node IPC adapter.
---

`@nexus-js/node-ipc` uses filesystem Unix sockets through `node:net`, with
`node:path`, `node:os`, and `node:fs/promises` for address and socket management.

| Environment             | Usage boundary                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| Node on Linux           | Primary runtime and documented test path.                                                                |
| Other Unix-like systems | Require compatible filesystem Unix sockets; verify the daemon/client workflow on your target platform.   |
| Bun                     | Repository CI does not verify Bun compatibility.                                                         |
| Browser bundles         | Not supported; use a browser adapter instead.                                                            |
| Electron                | Use for a local Unix socket daemon/client workflow, not as a replacement for Electron main/renderer IPC. |

The transport uses neither `child_process.fork()` nor `Bun.spawn({ ipc })`
channels, and does not pass socket handles. Their serialization differences do
not apply to this adapter.

The public address type reserves an abstract socket form; the documented and
tested path uses filesystem sockets. See [Addressing](/nexus/docs/node-ipc/addressing/).
