# @nexus-js/websocket

## 0.1.0-alpha.3

### Minor Changes

- a652eea: Core: support copied `ArrayBuffer`, `Uint8Array`, Node `Buffer`, and `Blob` RPC values with per-hop bounded chunking and negotiated binary packets. Export shared transport limits and validation from `@nexus-js/core/transport/config`.

  Keep transfer settlement and byte-budget release under one owner. Stop pending DATA pumps after cancellation or disconnect, release inbound bytes on synchronous dispatch failures, and clean up callbacks nested in Maps and Sets after failed or orphaned handoffs.

  Chrome: apply shared frame, message, and buffer limits to extension ports and relayed calls. Configure limits under `transport` on the endpoint or context helper.

  Iframe: support binary packets and transferable internal frames with the shared limits. Breaking migration: move the former top-level `binaryPackets` option under `transport.binaryPackets`; the old location now fails validation.

  Node IPC: carry bounded binary RPC values over real Unix sockets and enforce the shared transport limits. Configure limits under `transport`.

  WebSocket: carry bounded binary RPC values and enforce shared transport limits. Breaking migration: replace top-level `maxPayloadBytes` with `transport.maxFrameBytes`; the old location now fails validation.

### Patch Changes

- Updated dependencies [612016a]
- Updated dependencies [a652eea]
  - @nexus-js/core@2.0.0-alpha.2

## 0.1.0-alpha.2

### Patch Changes

- Updated dependencies [4524114]
- Updated dependencies [153b466]
- Updated dependencies [153b466]
  - @nexus-js/core@2.0.0-alpha.1

## 0.1.0-alpha.1

### Patch Changes

- e7557b4: Accept binary ArrayBuffer views from WebSocket implementations such as Bun's ws
  compatibility layer. Preserve the frame's exact byte range and apply payload and
  queue limits before copying it into a Core packet.

## 0.1.0-alpha.0

### Minor Changes

- d643bff: Add the WebSocket adapter for controlled browser, WebView, and Node clients.
  The browser-safe client dials with native WebSocket options, while the Node-only
  server endpoint synchronously adopts already-open `ws` sockets and leaves HTTP,
  TLS, Upgrade, authentication, Origin, and ping/pong ownership to the host.

### Patch Changes

- Updated dependencies [faa79fa]
  - @nexus-js/core@2.0.0-alpha.0
