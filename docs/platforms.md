# Platforms And Adapters

Nexus supplies connection and service semantics over contexts that already exist. An adapter supplies the endpoint channel, adapter-owned metadata, exact target types, and context factories. The application or host platform owns context startup and target discovery.

## Adapter Strategy

- `@nexus-js/core` contains the transport-agnostic runtime and public API.
- `@nexus-js/chrome` configures Chrome extension contexts and exports Chrome target constructors and `where` predicates.
- `@nexus-js/iframe` configures parent and child windows over `postMessage`.
- `@nexus-js/node-ipc` configures local daemon/client communication over Unix sockets.
- Other runtimes implement `IEndpoint<M>` and provide an `AdapterModel`.

An adapter context factory constructs local `ContextMeta`, installs the endpoint driver, and may supply an endpoint `defaultTarget`. It does not discover providers, inject contexts, or own application-level multicast orchestration.

## Chrome Extension

Install `@nexus-js/core` and `@nexus-js/chrome`, then use `usingBackgroundScript()`, `usingContentScript()`, `usingPopup()`, or the other exported context helpers.

The public Chrome target constructors are:

```ts
import { chromeTarget } from "@nexus-js/chrome";

const tabId = 42;
const documentId = "document-1";

const exactBackground = chromeTarget.background();
const exactContent = chromeTarget.contentDocument({
  tabId,
  documentId,
});
```

An exact target can reuse a ready connection or ask the adapter to connect that endpoint:

```ts
import { Nexus } from "@nexus-js/core";
import { chromeTarget } from "@nexus-js/chrome";
import type { ChromeAdapterModel } from "@nexus-js/chrome";
import { CaptureToken } from "./shared-contracts";

const backgroundNexus = new Nexus<ChromeAdapterModel>();
const tabId = 42;
const documentId = "document-1";

const capture = await backgroundNexus.create(CaptureToken, {
  target: chromeTarget.contentDocument({ tabId, documentId }),
  where: (contextMeta, connectionMeta) =>
    contextMeta.context === "content-script" &&
    contextMeta.isVisible === true &&
    connectionMeta.observed.documentId === documentId,
});
```

For a creation-time snapshot of currently available providers, use `selectMulticast`:

```ts
const captures = await backgroundNexus.selectMulticast(CaptureToken, {
  where: (contextMeta, _connectionMeta) =>
    contextMeta.context === "content-script" && contextMeta.isVisible === true,
});
```

`createMulticast` instead takes a non-empty `targets` array of exact Chrome targets, acquires every target, and fails the whole operation if one target fails. Both operations support `expects: "all"` (default) or `expects: "stream"`; calls settle as `{ status, value }` or `{ status, reason }` without connection IDs or `from` metadata. Connection IDs are not acquisition inputs, selection keys, or routing targets. `selectMulticast` never connects, has no `wait`, and an empty provider snapshot is valid. Acquisition `timeout`/`signal` cover `create` and `createMulticast`; `callTimeout` covers later proxy calls. Unknown option keys and incompatible provider-catalog protocols are structured errors.

Breaking from an `expects: "stream"` async iteration cancels Nexus's local
pending wait and timeout. It does not cancel methods already executing remotely.

The background context does not automatically find an active tab or inject a content script. Application code performs that workflow and passes the resulting tab/frame/document target to Nexus. A content script helper supplies `chromeTarget.background()` as endpoint `defaultTarget`, so `nexus.create(Token)` is valid when the Token has no default.

Chrome's `tabId`, `frameId`, and `documentId` are target-side platform addressing inputs, not content endpoint identity. Observed sender facts belong to Chrome's `ChromeConnectionMeta`. Private selected-route implementation state is not a public metadata contract.

## Iframe

Use `usingIframeParent({ appId, frames })` in the parent and `usingIframeChild({ appId, frameId, parentOrigin })` in the child. Register each frame with a stable `frameId` and exact expected origin. The child helper supplies a parent endpoint `defaultTarget` unless an explicit one is configured.

Public iframe targets are `IframeConnectionTarget` variants. Use an exact `IframeChildConnectionTarget` or `IframeParentConnectionTarget` when Nexus may need to open a connection. Use `selectMulticast({ where })` to bind a current snapshot of ready frame providers. The application owns the list of frames and any discovery of eligible frames.

The adapter validates source window, origin, app id, channel, and optional nonce before core policy. Iframe reload replaces the session; old proxies and refs must be recreated.

## Node IPC

Use `usingNodeIpcDaemon({ appId, instance })` and `usingNodeIpcClient({ appId, defaultTarget })`. The client target is `NodeIpcConnectionTarget`:

```ts
const daemon = {
  context: "node-ipc-daemon" as const,
  appId: "example-app",
  instance: "default",
};

usingNodeIpcClient({ appId: "example-app", defaultTarget: daemon });
```

The adapter maps that exact target to a Unix socket address. Socket paths and pre-auth results are connection metadata or transport implementation details, not peer-declared endpoint identity. A daemon restart invalidates old sessions and proxies.

## Worker And Custom Runtime

Implement the public `IEndpoint<M>` seam for a custom transport:

```ts
import { Nexus } from "@nexus-js/core";
import type { AdapterModel, IEndpoint } from "@nexus-js/core";

interface WorkerModel extends AdapterModel {
  contextMeta: { context: "worker" | "host" };
  connectionMeta: { readonly transport: "worker-port" };
  connectionTarget: { context: "worker"; workerId: string };
}

const workerNexus = new Nexus<WorkerModel>();
const endpoint: IEndpoint<WorkerModel> = createWorkerEndpoint();

workerNexus.configure({
  endpoint: {
    implementation: endpoint,
    meta: { context: "host" },
  },
});
```

The driver accepts ports, connects exact targets, matches ready targets, and closes platform resources. It does not implement Token discovery, proxy lifecycle, retry, replay, or business policy.

## Multiple Graphs

Use separate named `Nexus<M>` instances when one JavaScript context owns multiple transport graphs. Relay can forward an explicitly selected service or State provider between adjacent graphs; it does not merge connection graphs or provide transparent multi-hop routing.

## Testing Boundary

Use `createMockNexus()` for application code at the `NexusInstance` seam. Use core integration tests or adapter/browser tests for real transport, connection lifecycle, authorization, reload, restart, and multicast behavior.

## Related Guides

- [Getting started](getting-started.md)
- [Identity and connection metadata](identity-and-metadata.md)
- [Authorization and policy](auth-and-policy.md)
- [Iframe adapter](iframe/README.md)
- [Node IPC adapter](node-ipc/README.md)
- [Testing](testing/README.md)
