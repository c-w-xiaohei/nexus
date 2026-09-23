# Connections And Proxies

Connect from configured consumer contexts, then get proxies from the session.

Read `references/identity-and-metadata.md` when exact targets, `where`, or
identity observation depend on `ContextMeta`; policy may also inspect
adapter-provided `ConnectionMeta`.

```ts
import { chromeTarget, usingContentScript } from "@nexus-js/chrome";
import { SettingsToken } from "./shared";

const chromeNexus = usingContentScript();

const connection = await chromeNexus.connect({
  target: chromeTarget.background(),
});
const settings = connection.get(SettingsToken);

await settings.saveSettings({ theme: "dark" });
```

## Connection Acquisition

`connect({ target, where, timeout, signal })` reuses or opens one exact target.
Without a target, it never dials and waits for exactly one existing matching
session. `where(contextMeta, connectionMeta)` constrains an established peer; it
does not discover or connect one. Active acquisition defaults to 30 seconds;
pass a positive finite `timeout` to bound any acquisition, or `signal` to stop
only this caller's wait.

Use `conn.get(Token)` for a throwing synchronous catalog check, or
`conn.safeGet(Token)` for a Result. Neither dials, waits for publication, or
creates a remote business object.

## Exact Targets And Where

Use adapter targets for one exact endpoint and `connectMulticast` for a fixed
connection collection.

```ts
import { usingBackgroundScript } from "@nexus-js/chrome";
import { CaptureToken } from "./shared";

const backgroundNexus = usingBackgroundScript();
const tabId = 7;
const documentId = "doc-7";
const byTarget = await backgroundNexus.connect({
  target: chromeTarget.contentDocument({ tabId, documentId }),
});
const current = await backgroundNexus.connectMulticast({
  where: (contextMeta, _connectionMeta) =>
    contextMeta.context === "content-script" && contextMeta.isVisible === true,
});

const capture = byTarget.get(CaptureToken);
```

`target` and `targets` acquire exact endpoints and bind their sessions. A
targetless `connectMulticast` snapshots ready connections and never asks the
adapter to connect. `where(contextMeta, connectionMeta)` filters remote identity
and local adapter facts.

For strict multi-target acquisition, provide explicit targets:

```ts
const selected = await backgroundNexus.connectMulticast({
  targets: [tabId, 8].map((tabId) =>
    chromeTarget.contentFrame({ tabId, frameId: 0 }),
  ),
  where: (contextMeta, _connectionMeta) =>
    contextMeta.context === "content-script",
});

const resources = selected.get(CaptureToken);
```

With targets, `connectMulticast` strictly acquires every target under one shared
deadline and fails if any target cannot be acquired. Without targets, it takes one
ready-connection snapshot; zero connections is valid. The collection preserves
member order and identity. Later connections do not join it, and disconnected
members are not removed or replaced.

## Collections, Calls, And Timeouts

`collection.get(Token, { callTimeout: 5_000 })` returns an equal-length readonly list of
`{ connection, result }`. Every successful result is an ordinary proxy; every
failed acquisition remains associated with its connection. It neither filters
failures nor returns a whole-collection proxy.

The runtime call timeout defaults to 5 seconds. Configure it at bootstrap with
`nexus.configure({ callTimeout })`; a `get`/`safeGet` override belongs only to the
returned handle and is inherited by refs returned from its calls. `safeCall`
consumes one call and preserves a concrete call error as a Result. Combine calls
with ordinary `Promise.all`, `allSettled`, `any`, or `race`; Nexus does not add
collection aggregators.

Do not pre-connect every target before `connectMulticast({ targets })`; it owns
that acquisition. Use one consistent exact address for a workflow: Chrome frame
and document targets can create distinct sessions even for the same document.
`where` applies only to acquisition; ongoing authorization belongs to policy.

## Session-Bound Handles

Proxy method calls and property reads are lazy. They send only when consumed with
`await`, `then`, or a native Promise helper, and repeat observations share one
result. Ignored calls, including remote callback results ignored by an event API,
do not execute. Remote property assignment is unsupported; make writes explicit
service methods. Release only drops a remote reference; it does not invoke
application cleanup. See https://c-w-xiaohei.github.io/nexus/docs/concepts/.

Raw core handles are lifecycle-scoped.

- `conn.get(...)` returns a proxy bound to the resolved remote session.
- `nexus.ref(...)` creates capabilities that remain tied to the original connection scope after crossing the transport boundary.
- Existing raw proxies do not silently retarget after reconnect, daemon restart, iframe reload, or identity handoff.
- Reconnect, get fresh proxies, and pass fresh refs after session replacement.
- Ordinary proxies do not provide lifecycle status or subscriptions. Retain their source `Connection` to observe the session.

Use `nexus.onConnect(listener)` or `nexus.onConnect(where, listener)` to observe
each existing and future ready session once. Use
`connection.subscribeIdentity(listener)` for immediate full peer metadata and
all subsequent validated updates. Neither listener reconnects or replaces a
session.
