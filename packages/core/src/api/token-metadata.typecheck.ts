import { expectTypeOf } from "vitest";
import {
  type AdapterModel,
  type Allified,
  Nexus,
  type Streamified,
  Token,
  type NexusInstance,
  serviceProvider,
} from "@/index";

interface PingService {
  ping(): string;
}

declare const allSettlement: Awaited<
  ReturnType<Allified<PingService>["ping"]>
>[number];
// @ts-expect-error multicast settlements intentionally do not expose recipient IDs.
void allSettlement.from;

declare const streamSettlement: Awaited<
  ReturnType<Streamified<PingService>["ping"]>
> extends AsyncIterable<infer T>
  ? T
  : never;
// @ts-expect-error multicast settlements intentionally do not expose recipient IDs.
void streamSettlement.from;

type ChromeContextMeta =
  | { runtime: "background" }
  | { runtime: "content-script"; tabId: number };

interface ChromeConnectionMeta {
  platform: "chrome";
}

type ChromeModel = {
  contextMeta: ChromeContextMeta;
  connectionMeta: ChromeConnectionMeta;
  connectionTarget:
    | { context: "background" }
    | { context: "content"; tabId: number };
};

const chromeModelContract: AdapterModel = {} as ChromeModel;
void chromeModelContract;

type UpstreamContextMeta = { runtime: "upstream"; workerId: string };

const PlainPingToken = new Token<PingService>("test:plain-ping");

const chromeNexusForUndefinedConnected = new Nexus<ChromeModel>();
chromeNexusForUndefinedConnected.create(PlainPingToken, {
  // @ts-expect-error removed connected mode is rejected at the Nexus API.
  connected: { context: "background" },
});

chromeNexusForUndefinedConnected.create(PlainPingToken, {
  // @ts-expect-error create does not use multicast response strategies.
  expects: "all",
});

chromeNexusForUndefinedConnected.safeCreate(PlainPingToken, {
  // @ts-expect-error create does not use multicast response strategies.
  expects: "stream",
});

const anyConnected: any = { context: "background" };
chromeNexusForUndefinedConnected.create(PlainPingToken, {
  // @ts-expect-error any-valued connected keys are rejected too.
  connected: anyConnected,
});

// @ts-expect-error multicast options, including targets, are required.
void chromeNexusForUndefinedConnected.createMulticast(PlainPingToken);
// @ts-expect-error safe multicast options, including targets, are required.
void chromeNexusForUndefinedConnected.safeCreateMulticast(PlainPingToken);

const ModelBoundPingToken = new Token<PingService, ChromeModel>(
  "test:model-bound-ping",
  { defaultTarget: { context: "background" } },
);

type UpstreamModel = {
  contextMeta: UpstreamContextMeta;
  connectionMeta: ChromeConnectionMeta;
  connectionTarget: { context: "upstream" };
};

// @ts-expect-error a model-bound default target cannot cross adapter models.
const rejectModelBoundToken: Token<PingService, UpstreamModel> =
  ModelBoundPingToken;
void rejectModelBoundToken;

const ChromePingToken = new Token<PingService, ChromeModel>(
  "test:chrome-ping",
  {
    defaultTarget: {
      context: "background",
    },
  },
);

const BackgroundOnlyPingToken = new Token<PingService, ChromeModel>(
  "test:background-only-ping",
  {
    defaultTarget: {
      context: "background",
    },
  },
);

const rejectBackgroundOnlyAsChromeToken: Token<PingService, ChromeModel> =
  BackgroundOnlyPingToken;
void rejectBackgroundOnlyAsChromeToken;

const UpstreamPingToken = new Token<PingService, UpstreamModel>(
  "test:upstream-ping",
  {
    defaultTarget: {
      context: "upstream",
    },
  },
);

const AnyPingToken = new Token<PingService, any>("test:any-ping");

const chromeNexus = new Nexus<ChromeModel>();

expectTypeOf(chromeNexus).toMatchTypeOf<NexusInstance<ChromeModel>>();

void chromeNexus.create(PlainPingToken);
void chromeNexus.create(ChromePingToken);
void chromeNexus.safeCreate(ChromePingToken);

// @ts-expect-error create reads token.defaultTarget and must reject tokens from unrelated runtimes.
void chromeNexus.create(UpstreamPingToken);

void chromeNexus.create(BackgroundOnlyPingToken);

void AnyPingToken;

// @ts-expect-error safeCreate reads token.defaultTarget and must reject tokens from unrelated runtimes.
void chromeNexus.safeCreate(UpstreamPingToken);

void chromeNexus.safeCreate(BackgroundOnlyPingToken);

chromeNexus.provide(ChromePingToken, { ping: () => "pong" });
chromeNexus.safeProvide(ChromePingToken, { ping: () => "pong" });

class PingProvider implements PingService {
  ping(): string {
    return "pong";
  }
}

chromeNexus.Expose(ChromePingToken)(PingProvider, {
  kind: "class",
  name: "PingProvider",
  addInitializer: () => undefined,
  metadata: {},
});

serviceProvider<PingService, ChromeModel>(
  ChromePingToken,
  { ping: () => "pong" },
  {
    policy: {
      canCall: (context) => context.remoteIdentity.runtime === "background",
    },
  },
);
