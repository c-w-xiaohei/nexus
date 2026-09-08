# Layer 3: Service Runtime

`Engine` owns runtime composition and connection lifecycle. Layer 2 owns
connection matching, dialing and routing; Layer 3 only dispatches to sessions
bound when a proxy is created.

```mermaid
graph TD
    NexusAPI -->|bound IDs, strategy, timeout| Engine
    Engine -->|creates| ProxyFactory
    ProxyFactory -->|operation + binding| CallProcessor
    CallProcessor -->|register before send| PendingCallManager
    CallProcessor -->|sanitize per recipient| PayloadProcessor
    CallProcessor -->|exact session send| ConnectionManager
    ConnectionManager -->|incoming message| Engine
    Engine --> MessageHandler
    MessageHandler -->|RES / ERR| PendingCallManager
    MessageHandler -->|authorize, resolve, invoke| ResourceManager
    MessageHandler -->|encode reply / revive response| PayloadProcessor
    PayloadProcessor -->|conversion tables| Protocol
    PayloadProcessor -->|local capabilities| ResourceManager
    PayloadProcessor -->|remote facades| ProxyFactory
```

## Dispatch And Ownership

- `ProxyFactory.dispatch` is the Result-to-Promise-rejection boundary, not another
  safe API. GET/APPLY return failures to the caller without automatic logging.
  SET has no caller-visible completion Promise, so its trap observes and logs
  asynchronous failure; the synchronous released-resource guard stays in place.
  RELEASE is also best-effort with send-failure logging, not a remote cleanup ACK.

- `CallBinding` pairs one connection with `one`, or a fixed connection list with
  `all` / `stream`. Timeout is explicit. `staleTarget.where` only observes
  selection invalidation; it does not reroute calls.
- Check bound sessions before allocating pending state or capabilities. Register
  pending before sending because an in-process transport can reply synchronously.
- Sanitize and send separately for each recipient. A failed handoff releases only
  that recipient's outgoing capabilities; earlier accepted capabilities remain.
- Collect calls settle with `Result`. Streams preserve target order. Normal
  completion keeps queued results readable; cancellation releases both queued
  and ordering-buffered capabilities, never already delivered results.

## Incoming Requests

- `MessageHandler` owns the single RES/ERR reply for requests. Responses and
  RELEASE notifications are never answered with ERR. Failed RES handoffs release
  the newly encoded capabilities.
- The private `prepareReply` flow authorizes before reading property paths and rechecks
  resource ownership after asynchronous authorization. The authorized policy
  snapshot, including `undefined`, accompanies returned capabilities.
- APPLY keeps `invokeStart -> revive -> Reflect.apply -> finally invokeEnd`
  synchronous, then awaits the returned value. GET transports the property value
  without awaiting it. State and Relay depend on this distinction.
- `invoke` owns that synchronous scope; `prepareReply` only selects the operation
  and encodes its result. `safeReply` keeps execution errors separate from the
  single reply handoff, so send failures never cause reply loops.
- The resource host determines service attribution; a remote resource ID must
  not be resolved against the caller's unrelated local resource registry.

## Payload And Lifetime

All L3 runtime components are per-Engine classes; the class is also the instance
type, without a parallel `Runtime` interface or factory return object. Only
authorization and service creation retain model-dependent types. Dependency
signatures reuse existing methods rather than redefining transport contracts.
`ProxyFactory` shares its traps. One weak index associates both callable targets
and facades with a binding/path. Resource facades additionally share a release
state, which doubles as the finalizer anchor and does not point back to a facade.
Service facades have no resource lifecycle state. Pending streams implement the
iterator protocol directly.

`protocol.ts` retains independent sanitizer and reviver tables. Payload traversal
and capability rollback belong to `PayloadProcessor`; wire conversion semantics
are not part of request dispatch. Late responses release only resource identities
not already registered locally. Proxy release remains idempotent, while discarding
a facade unregisters its finalizer without releasing the shared resource identity.
