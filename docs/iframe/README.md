# Iframe Adapter

`@nexus-js/iframe` connects a parent browser window and iframe children through Nexus RPC over `postMessage`.

Install it with core:

```bash
pnpm add @nexus-js/core @nexus-js/iframe
```

## Shared Contract

Put contracts and Tokens in shared code imported by both parent and child bundles.

```ts
import { TokenSpace } from "@nexus-js/core";
import type { IframePlatformMeta, IframeUserMeta } from "@nexus-js/iframe";

export interface GreetingService {
  greet(name: string): Promise<string>;
}

const appSpace = new TokenSpace<IframeUserMeta, IframePlatformMeta>({
  name: "iframe-demo",
});

const childServices = appSpace.tokenSpace("child-services", {
  defaultTarget: {
    descriptor: {
      context: "iframe-child",
      appId: "iframe-demo",
      frameId: "preview",
    },
  },
});

export const GreetingToken = childServices.token<GreetingService>("greeting");
```

## Parent Setup

Configure the parent with the iframe element and expected child origin before creating proxies.

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

The parent helper also registers descriptors named `child` for the first frame and `child:<frameId>` for additional frames. The explicit descriptor above is preferred in introductory code because it is easiest to debug.

## Child Setup

Configure the child with the expected parent origin. Expose services with explicit `configure({ services })` when you want to keep setup local and avoid process-global decorators.

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

## Security Notes

- Use exact origins for `origin` and `parentOrigin` whenever possible.
- `allowAnyOrigin: true` permits `"*"` origin matching and should only be used for intentionally public frames.
- Use `nonce` when a parent page may host multiple frame sessions or when an extra channel binding is useful.
- Origin and nonce checks are adapter gates. Use `policy.canConnect` and `policy.canCall` for application authorization.

## Lifecycle

Iframe reloads replace the child window and Nexus session. Raw proxies and refs are session-bound, so recreate proxies with `nexus.create(...)` and pass fresh refs after an iframe reload, reconnect, or session replacement.

## Related APIs

`@nexus-js/iframe` uses `@nexus-js/core/transport/virtual-port` internally. Application code should prefer `usingIframeParent(...)` and `usingIframeChild(...)`; use the virtual-port subpath only when implementing a transport adapter.
