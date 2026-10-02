---
"@nexus-js/core": minor
"@nexus-js/chrome": minor
"@nexus-js/iframe": minor
"@nexus-js/node-ipc": minor
"@nexus-js/websocket": minor
---

Core: support copied `ArrayBuffer`, `Uint8Array`, Node `Buffer`, and `Blob` RPC values with per-hop bounded chunking and negotiated binary packets. Export shared transport limits and validation from `@nexus-js/core/transport/config`.

Keep transfer settlement and byte-budget release under one owner. Stop pending DATA pumps after cancellation or disconnect, release inbound bytes on synchronous dispatch failures, and clean up callbacks nested in Maps and Sets after failed or orphaned handoffs.

Chrome: apply shared frame, message, and buffer limits to extension ports and relayed calls. Configure limits under `transport` on the endpoint or context helper.

Iframe: support binary packets and transferable internal frames with the shared limits. Breaking migration: move the former top-level `binaryPackets` option under `transport.binaryPackets`; the old location now fails validation.

Node IPC: carry bounded binary RPC values over real Unix sockets and enforce the shared transport limits. Configure limits under `transport`.

WebSocket: carry bounded binary RPC values and enforce shared transport limits. Breaking migration: replace top-level `maxPayloadBytes` with `transport.maxFrameBytes`; the old location now fails validation.
