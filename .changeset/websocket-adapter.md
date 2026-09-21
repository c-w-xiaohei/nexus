---
"@nexus-js/websocket": minor
---

Add the WebSocket adapter for controlled browser, WebView, and Node clients.
The browser-safe client dials with native WebSocket options, while the Node-only
server endpoint synchronously adopts already-open `ws` sockets and leaves HTTP,
TLS, Upgrade, authentication, Origin, and ping/pong ownership to the host.
