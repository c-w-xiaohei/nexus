# @nexus-js/websocket

## 0.1.0-alpha.0

### Minor Changes

- d643bff: Add the WebSocket adapter for controlled browser, WebView, and Node clients.
  The browser-safe client dials with native WebSocket options, while the Node-only
  server endpoint synchronously adopts already-open `ws` sockets and leaves HTTP,
  TLS, Upgrade, authentication, Origin, and ping/pong ownership to the host.

### Patch Changes

- Updated dependencies [faa79fa]
  - @nexus-js/core@2.0.0-alpha.0
