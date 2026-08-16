# Iframe Adapter

For iframe integrations, keep contracts shared and keep parent/child setup focused on iframe wiring. Full adapter docs should point to `docs/getting-started.md` for the shared contract pattern instead of redefining it repeatedly.

## Shared Contract Shape

Use a model-bound `TokenSpace<IframeAdapterModel>` or `Token<GreetingService, IframeAdapterModel>` with a `defaultTarget` when the parent repeatedly calls the same child frame. Keep shared Tokens target-free.

```ts
import { Token } from "@nexus-js/core";
import type { IframeChildConnectionTarget } from "@nexus-js/iframe";
import type { GreetingService } from "./service-contract";

export const childTarget = {
  context: "iframe-child",
  appId: "iframe-demo",
  frameId: "preview",
  origin: "https://child.example.com",
} satisfies IframeChildConnectionTarget;

// This shared contract has no default target and is usable by another model.
export const GreetingToken = new Token<GreetingService>("iframe-demo:greeting");
```

## Parent

Use exact child origins and keep the initial proxy example explicit.

```ts
import { usingIframeParent } from "@nexus-js/iframe";
import type { IframeAdapterModel } from "@nexus-js/iframe";
import type { NexusInstance } from "@nexus-js/core";
import { GreetingToken } from "./service-contract";

const iframe = document.querySelector<HTMLIFrameElement>("#preview");
if (!iframe) throw new Error("Preview iframe is required");

const iframeParentNexus: NexusInstance<IframeAdapterModel> = usingIframeParent({
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

const greeting = await iframeParentNexus.create(GreetingToken, {
  target: childTarget,
});
```

## Child

For class-style child services, bind the class to the child Nexus instance.

```ts
import { usingIframeChild } from "@nexus-js/iframe";
import type { IframeAdapterModel } from "@nexus-js/iframe";
import type { NexusInstance } from "@nexus-js/core";
import { GreetingToken, type GreetingService } from "./service-contract";

const childNexus: NexusInstance<IframeAdapterModel> = usingIframeChild({
  appId: "iframe-demo",
  frameId: "preview",
  parentOrigin: "https://parent.example.com",
  nonce: "session-nonce",
});

@childNexus.Expose(GreetingToken)
class GreetingServiceImpl implements GreetingService {
  async greet(name: string) {
    return `Hello, ${name}`;
  }
}
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
