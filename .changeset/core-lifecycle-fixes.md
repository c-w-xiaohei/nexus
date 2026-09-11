---
"@nexus-js/core": patch
---

Fix early-message ordering, timeout settlement, late authorization, and reentrant
connection cleanup. Reclaim callback, stream, and resource capabilities when
dispatch or reply delivery fails, including failed and late State subscriptions.
Preserve caller authorization and isolate slow State subscribers without closing
other services on their shared connection.
