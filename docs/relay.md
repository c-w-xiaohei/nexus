# Nexus Relay

Nexus Relay exposes a provider in one Nexus graph that forwards selected service or State operations into an adjacent graph.

Relay is explicit. It is not transparent multi-hop routing, raw envelope forwarding, or a target tunnel.

## When To Use Relay

Use Relay when one runtime owns more than one configured `Nexus<M>` instance and downstream callers should access a selected upstream provider through the middle runtime. If two contexts can connect directly in one graph, use normal `create()` or `connectNexusStore()` instead.

## Service Relay

The following is a wiring fragment, not a complete bootstrap. Assume
`chromeNexus`, `iframeParentNexus`, and `iframeChildNexus` have already been
configured by their respective Chrome and iframe adapter setup.

```ts
import { Nexus, Token } from "@nexus-js/core";
import { chromeTarget, type ChromeAdapterModel } from "@nexus-js/chrome";
import { relayService } from "@nexus-js/core/relay";
import type { IframeAdapterModel } from "@nexus-js/iframe";

interface UserProfileService {
  update(input: { name: string }): Promise<void>;
}

const UpstreamUserProfileToken = new Token<
  UserProfileService,
  ChromeAdapterModel
>("example:user-profile");
const DownstreamUserProfileToken = new Token<
  UserProfileService,
  IframeAdapterModel
>("example:user-profile");

declare const chromeNexus: Nexus<ChromeAdapterModel>;
declare const iframeParentNexus: Nexus<IframeAdapterModel>;
declare const iframeChildNexus: Nexus<IframeAdapterModel>;

iframeParentNexus.provide(
  relayService(DownstreamUserProfileToken, {
    forwardThrough: chromeNexus,
    forwardTarget: chromeTarget.background(),
  }),
);

// The upstream graph exposes the same service id under its own model-bound Token.
chromeNexus.provide(UpstreamUserProfileToken, {
  async update(input) {
    console.log(input.name);
  },
});
```

The downstream caller uses an exact target in its own graph:

```ts
const profile = await iframeChildNexus.create(DownstreamUserProfileToken, {
  target: {
    context: "iframe-parent",
    appId: "portal",
    instance: "default",
    origin: "https://parent.example.com",
  },
});

await profile.update({ name: "Ada" });
```

The shared Token's `defaultTarget` is graph-local. Relay never derives `forwardTarget` from downstream defaults; configure the upstream `forwardThrough` and `forwardTarget` explicitly.

By default, `relayService()` forwards serializable method calls and rejects `SET`, callbacks, refs, remote resources, and other capability-bearing payloads. Model capability forwarding as an explicit service contract instead of relying on transparent tunneling.

## State Relay

Use `relayNexusStore()` when downstream callers should connect to an upstream authoritative State store:

The following is a wiring fragment using the same already-configured Nexus
instances from the service example above. It does not create new runtimes.

```ts
import { Nexus, Token } from "@nexus-js/core";
import {
  connectNexusStore,
  createNexusStore,
  defineNexusStore,
  type NexusStoreServiceContract,
} from "@nexus-js/core/state";
import { relayNexusStore } from "@nexus-js/core/relay";
import { chromeTarget } from "@nexus-js/chrome";
import type { ChromeAdapterModel } from "@nexus-js/chrome";
import type { IframeAdapterModel } from "@nexus-js/iframe";

declare const chromeNexus: Nexus<ChromeAdapterModel>;
declare const iframeParentNexus: Nexus<IframeAdapterModel>;
declare const iframeChildNexus: Nexus<IframeAdapterModel>;

type SessionState = { name: string };
type SessionActions = { rename(name: string): Promise<void> };
type SessionService = NexusStoreServiceContract<SessionState, SessionActions>;

const UpstreamSessionStoreToken = new Token<SessionService, ChromeAdapterModel>(
  "example:session-store",
);
const DownstreamSessionStoreToken = new Token<
  SessionService,
  IframeAdapterModel
>("example:session-store");
const upstreamSessionStore = defineNexusStore<
  SessionState,
  SessionActions,
  ChromeAdapterModel
>({
  token: UpstreamSessionStoreToken,
  state: () => ({ name: "Ada" }),
  actions: ({ setState }) => ({
    async rename(name) {
      setState({ name });
    },
  }),
});
const downstreamSessionStore = defineNexusStore<
  SessionState,
  SessionActions,
  IframeAdapterModel
>({
  token: DownstreamSessionStoreToken,
  state: () => ({ name: "Ada" }),
  actions: ({ setState }) => ({
    async rename(name) {
      setState({ name });
    },
  }),
});
const { provider: sessionProvider } = createNexusStore(upstreamSessionStore);
chromeNexus.provide(sessionProvider);

iframeParentNexus.provide(
  relayNexusStore<
    SessionState,
    SessionActions,
    IframeAdapterModel,
    ChromeAdapterModel
  >(downstreamSessionStore, {
    forwardThrough: chromeNexus,
    forwardTarget: chromeTarget.background(),
  }),
);
```

Downstream State code connects to the relay provider using an exact iframe target or a Token/endpoint `defaultTarget`:

```ts
const store = await connectNexusStore(
  iframeChildNexus,
  downstreamSessionStore,
  {
    target: {
      context: "iframe-parent",
      appId: "portal",
      instance: "default",
      origin: "https://parent.example.com",
    },
  },
);
```

The relay projects the upstream authoritative store. It has its own downstream session and versions, waits for the upstream baseline, and terminalizes downstream subscribers when the upstream session is disconnected or replaced. Create fresh handles after replacement.

## Policy Context

Relay policy receives direct-caller `ContextMeta` and `ConnectionMeta` from the downstream graph. Use connection facts for adapter-observed security decisions and peer identity for product-level authorization at its documented trust level.

## What Relay Does Not Do

- merge connection graphs
- discover providers globally
- forward raw Nexus messages
- provide transparent multi-hop routing
- tunnel refs, callbacks, or resources implicitly
- heal old downstream service or State handles after upstream replacement

## Related Pages

- [Core concepts](concepts.md)
- [Platforms and bridge contexts](platforms.md)
- [Authorization and policy](auth-and-policy.md)
- [Nexus State](state/README.md)
