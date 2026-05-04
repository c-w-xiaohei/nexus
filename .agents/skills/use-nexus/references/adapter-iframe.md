# Iframe Adapter

For iframe integrations, keep contracts shared and keep parent/child setup focused on iframe wiring. Full adapter docs should point to `docs/getting-started.md` for the shared contract pattern instead of redefining it repeatedly.

## Shared Contract Shape

Use a Token default target when the parent repeatedly calls the same child frame.

```ts
import { TokenSpace } from "@nexus-js/core";
import type { IframePlatformMeta, IframeUserMeta } from "@nexus-js/iframe";
import type { GreetingService } from "./service-contract";

const appSpace = new TokenSpace<IframeUserMeta, IframePlatformMeta>({
  name: "iframe-demo",
});

const childServices = appSpace.tokenSpace("child-services", {
  defaultCreate: {
    target: {
      descriptor: {
        context: "iframe-child",
        appId: "iframe-demo",
        frameId: "preview",
        origin: "https://child.example.com",
      },
    },
  },
});

export const GreetingToken = childServices.token<GreetingService>("greeting");
```

## Parent

Use exact child origins and keep the initial proxy example explicit.

```ts
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
```

## Child

For class-style child services, bind the class to the child Nexus instance.

```ts
const childNexus = usingIframeChild({
  appId: "iframe-demo",
  frameId: "preview",
  parentOrigin: "https://parent.example.com",
  nonce: "session-nonce",
});

@childNexus.Expose(GreetingToken)
class GreetingServiceImpl implements GreetingService {}
```

For function/object style, use `childNexus.provide(GreetingToken, greetingService)`.

Without `configure: false`, `usingIframeParent(...)` and `usingIframeChild(...)` configure the shared `nexus` instance directly and return that instance, not a config object.

## Origin And Session Gates

Use exact origins for parent `frames[].origin` and child `parentOrigin`; they must match the browser origin exactly, including scheme, host, and port.

Add `nonce` when a frame session needs extra binding. Avoid `allowAnyOrigin: true` except for intentionally public frames.

Adapter source, origin, app id, channel, and nonce checks are transport gates. App-level authorization still belongs in core `policy.canConnect` and `policy.canCall`.

## Heartbeat And Reconnect

The browser `postMessage` bus has no native disconnect guarantee. Iframe helpers rely on the core virtual-port heartbeat to detect unresponsive links.

Use the default heartbeat for application code unless tests or runtime constraints need faster or slower disconnect detection.

Iframe reloads and iframe element replacement create a new child session. Recreate proxies and pass fresh refs after reload, reconnect, or session replacement.
