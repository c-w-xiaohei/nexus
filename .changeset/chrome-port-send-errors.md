---
"@nexus-js/chrome": patch
---

Propagate synchronous Chrome port send failures to the connection error
boundary instead of reporting the message as sent.
