---
"@nexus-js/websocket": patch
---

Accept binary ArrayBuffer views from WebSocket implementations such as Bun's ws
compatibility layer. Preserve the frame's exact byte range and apply payload and
queue limits before copying it into a Core packet.
