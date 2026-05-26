import { expectTypeOf } from "vitest";
import { Nexus, Token, type NexusInstance, serviceProvider } from "@/index";

interface PingService {
  ping(): string;
}

type ChromeEndpointMeta =
  | { runtime: "background" }
  | { runtime: "content-script"; tabId: number };

interface ChromePlatformMeta {
  platform: "chrome";
}

type UpstreamEndpointMeta = { runtime: "upstream"; workerId: string };

const PlainPingToken = new Token<PingService>("test:plain-ping");

const ChromePingToken = new Token<PingService, ChromeEndpointMeta>(
  "test:chrome-ping",
  {
    defaultTarget: {
      descriptor: { runtime: "background" },
    },
  },
);

const BackgroundOnlyPingToken = new Token<
  PingService,
  Extract<ChromeEndpointMeta, { runtime: "background" }>
>("test:background-only-ping", {
  defaultTarget: {
    matcher: (identity) => identity.runtime === "background",
  },
});

// @ts-expect-error narrower token metadata is not assignable to the full runtime metadata token type.
const rejectBackgroundOnlyAsChromeToken: Token<
  PingService,
  ChromeEndpointMeta
> = BackgroundOnlyPingToken;
void rejectBackgroundOnlyAsChromeToken;

const UpstreamPingToken = new Token<PingService, UpstreamEndpointMeta>(
  "test:upstream-ping",
  {
    defaultTarget: {
      descriptor: { runtime: "upstream", workerId: "worker-1" },
    },
  },
);

const AnyPingToken = new Token<PingService, any>("test:any-ping");

const chromeNexus = new Nexus<ChromeEndpointMeta, ChromePlatformMeta>();

expectTypeOf(chromeNexus).toMatchTypeOf<
  NexusInstance<ChromeEndpointMeta, ChromePlatformMeta>
>();

void chromeNexus.create(PlainPingToken);
void chromeNexus.create(ChromePingToken);
void chromeNexus.safeCreate(ChromePingToken);

// @ts-expect-error create reads token.defaultTarget and must reject tokens from unrelated runtimes.
void chromeNexus.create(UpstreamPingToken);

// @ts-expect-error create must reject narrower token metadata because matchers receive any runtime identity.
void chromeNexus.create(BackgroundOnlyPingToken);

void AnyPingToken;

// @ts-expect-error safeCreate reads token.defaultTarget and must reject tokens from unrelated runtimes.
void chromeNexus.safeCreate(UpstreamPingToken);

// @ts-expect-error safeCreate must reject narrower token metadata because matchers receive any runtime identity.
void chromeNexus.safeCreate(BackgroundOnlyPingToken);

void chromeNexus.createMulticast(ChromePingToken);
void chromeNexus.createMulticast(ChromePingToken, {
  target: { descriptor: { runtime: "background" } },
  expects: "all",
});
void chromeNexus.safeCreateMulticast(ChromePingToken);
void chromeNexus.safeCreateMulticast(ChromePingToken, {
  target: { descriptor: { runtime: "background" } },
  expects: "stream",
});

// @ts-expect-error createMulticast is runtime-targeted and must reject unrelated token metadata.
void chromeNexus.createMulticast(UpstreamPingToken);

// @ts-expect-error createMulticast must reject narrower token metadata because matchers receive any runtime identity.
void chromeNexus.createMulticast(BackgroundOnlyPingToken);

// @ts-expect-error safeCreateMulticast is runtime-targeted and must reject unrelated token metadata.
void chromeNexus.safeCreateMulticast(UpstreamPingToken);

// @ts-expect-error safeCreateMulticast must reject narrower token metadata because matchers receive any runtime identity.
void chromeNexus.safeCreateMulticast(BackgroundOnlyPingToken);

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

serviceProvider<PingService, ChromeEndpointMeta, ChromePlatformMeta>(
  ChromePingToken,
  { ping: () => "pong" },
  {
    policy: {
      canCall: (context) => context.remoteIdentity.runtime === "background",
    },
  },
);
