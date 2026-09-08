---
"@nexus-js/core": patch
---

Use classes as the implementation and instance type for L3 resource, payload,
and pending-call managers. Remove duplicate runtime interfaces and unused generic
parameters, share iterator methods, and consolidate pending settlement without
changing protocol conversion tables or public service-acquisition behavior.

Separate synchronous invocation scope from request/reply orchestration, and
simplify proxy metadata to one weak path index with optional shared resource
lifetime state.

Stop automatically logging and observing ordinary proxy call rejections. Callers
must await or catch those Promises; ignored failures now follow the runtime's
normal unhandled-rejection behavior. Keep resource assignment and release as
best-effort operations with framework logging, without changing Asyncified types
or assignment support.

Observe State and Relay background notification failures at their fanout owners
instead of relying on the proxy to handle rejected callback Promises.
