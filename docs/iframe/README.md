# Iframe Documentation

`@nexus-js/iframe` connects a parent browser window and iframe children through Nexus RPC over `postMessage`. Use it for browser pages that own one or more frames and need typed service calls across that boundary.

This section covers adapter-specific setup. For the shared Nexus programming model, read `docs/getting-started.md` first.

## Package Routing

- Foundation runtime: `@nexus-js/core`
- Browser iframe adapter: `@nexus-js/iframe`

Install both in parent and child bundles:

```bash
pnpm add @nexus-js/core @nexus-js/iframe
```

## When To Use It

Use the iframe adapter when your application has:

- a parent browser window that owns the iframe elements
- one or more iframe children loaded in browser windows
- service calls that should route over `postMessage`
- exact parent and child origins known at configuration time

Do not use it for workers, Chrome extension context routing, local Node process IPC, or browser frames that must survive reloads without recreating proxies.

## Shared Contracts

Put service contracts and Tokens in shared code imported by both parent and child bundles. The general pattern is covered in `docs/getting-started.md`; adapter docs should not redefine the full contract in every example.

When repeated iframe calls target the same child, a `TokenSpace` default target can keep the route close to the Token:

```ts
import { TokenSpace } from "@nexus-js/core";
import type { IframePlatformMeta, IframeUserMeta } from "@nexus-js/iframe";
import type { GreetingService } from "./service-contract";

const appSpace = new TokenSpace<IframeUserMeta, IframePlatformMeta>({
  name: "iframe-demo",
});

const childServices = appSpace.tokenSpace("child-services", {
  defaultTarget: {
    descriptor: {
      context: "iframe-child",
      appId: "iframe-demo",
      frameId: "preview",
      origin: "https://child.example.com",
    },
  },
});

export const GreetingToken = childServices.token<GreetingService>("greeting");
```

Introductory examples should still pass explicit `target` options to `nexus.create(...)` because the resolved route is easiest to inspect and debug.

## Parent Setup

Configure the parent with each iframe element and its exact expected child origin before creating proxies.

```ts
import { nexus } from "@nexus-js/core";
import { usingIframeParent } from "@nexus-js/iframe";
import { GreetingToken } from "./shared";

const iframe = document.querySelector<HTMLIFrameElement>("#preview");
if (!iframe) throw new Error("Missing #preview iframe");

usingIframeParent({
  appId: "iframe-demo",
  frames: [
    {
      frameId: "preview",
      iframe,
      origin: "https://child.example.com",
      nonce: "session-nonce",
    },
  ],
});

const greeting = await nexus.create(GreetingToken, {
  target: {
    descriptor: {
      context: "iframe-child",
      appId: "iframe-demo",
      frameId: "preview",
      origin: "https://child.example.com",
    },
  },
});

await greeting.greet("parent");
```

The parent helper also registers descriptors named `child` for the first frame and `child:<frameId>` for additional frames. Named descriptors are useful after setup is working, but explicit descriptors are clearer in first examples.

## Child Setup

Configure the child with the exact expected parent origin. Use `configure: false` when composing the adapter config with local services, policy, or custom Nexus instances; in that mode the helper returns config instead of configuring the shared `nexus` instance.

```ts
import { nexus } from "@nexus-js/core";
import { usingIframeChild } from "@nexus-js/iframe";
import { GreetingToken } from "./shared";

nexus.configure({
  ...usingIframeChild({
    appId: "iframe-demo",
    frameId: "preview",
    parentOrigin: "https://parent.example.com",
    nonce: "session-nonce",
    configure: false,
  }),
  services: [
    {
      token: GreetingToken,
      implementation: {
        async greet(name) {
          return `hello ${name}`;
        },
      },
    },
  ],
});
```

Without `configure: false`, `usingIframeChild(...)` and `usingIframeParent(...)` configure the shared `nexus` instance directly and return that instance. Do not spread a helper result unless `configure: false` is set.

## What The Adapter Provides

- parent and child setup helpers
- parent frame registration by stable `frameId`
- iframe `postMessage` endpoint wiring
- virtual-port routing over `postMessage`
- iframe descriptors and common matchers
- source window, exact origin, app id, channel, and optional nonce gates
- iframe platform metadata for policy decisions

## What Core Still Owns

The adapter does not replace core Nexus behavior.

Core still owns:

- Tokens and service contracts
- service exposure
- proxy creation
- target resolution
- logical connection handshake
- `policy.canConnect` and `policy.canCall`
- resource reference lifecycle
- session-bound proxy semantics

## Security Notes

- Use exact origins for parent `frames[].origin` and child `parentOrigin` whenever possible.
- `origin` and `parentOrigin` must match the browser `MessageEvent.origin` exactly, including scheme, host, and port.
- `allowAnyOrigin: true` permits wildcard origin matching and should only be used for intentionally public frames.
- Use `nonce` when a parent page may host multiple frame sessions or when an extra channel binding is useful.
- Source, origin, app id, channel, and nonce checks are adapter transport gates.
- Application authorization still belongs in core `policy.canConnect` and `policy.canCall`; do not treat adapter gates as a replacement for app-level policy.

## Lifecycle

The browser `postMessage` bus does not guarantee a native disconnect signal. The iframe adapter uses the core virtual-port heartbeat to detect unresponsive links; its defaults come from core (5000ms interval / 3 misses unless core exposes different values). Override `heartbeat` only for tests or environments that need faster or slower disconnect detection.

Iframe reloads replace the child window and Nexus session. Raw `nexus.create(...)` proxies and refs are session-bound, so recreate proxies and pass fresh refs after an iframe reload, reconnect, or session replacement.

If a parent swaps the iframe element, register the new element in parent setup before creating new proxies. Existing raw proxies do not silently retarget to the replacement session.

## Related Pages

- Product docs landing: `docs/README.md`
- Setup walkthrough and shared contracts: `docs/getting-started.md`
- Package map: `docs/packages.md`
- Platform selection: `docs/platforms.md`
- Shared authorization policy: `docs/auth-and-policy.md`
- Virtual port transport internals: `@nexus-js/core/transport/virtual-port`
