import { Token } from "@nexus-js/core";
import { createMockNexus } from "./index";

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

const ChromePingToken = new Token<PingService, ChromeEndpointMeta>(
  "mock:chrome-ping",
  {
    defaultTarget: {
      descriptor: { runtime: "background" },
    },
  },
);

const BackgroundOnlyPingToken = new Token<
  PingService,
  Extract<ChromeEndpointMeta, { runtime: "background" }>
>("mock:background-only-ping", {
  defaultTarget: {
    matcher: (identity) => identity.runtime === "background",
  },
});

const UpstreamPingToken = new Token<PingService, UpstreamEndpointMeta>(
  "mock:upstream-ping",
  {
    defaultTarget: {
      descriptor: { runtime: "upstream", workerId: "worker-1" },
    },
  },
);

const AnyPingToken = new Token<PingService, any>("mock:any-ping");

const mock = createMockNexus<ChromeEndpointMeta, ChromePlatformMeta>();

mock.service(ChromePingToken, { ping: () => "pong" });
mock.failCreate(ChromePingToken, new Error("boom"));
mock.clear(ChromePingToken);

void mock.nexus.create(ChromePingToken);
void mock.nexus.safeCreate(ChromePingToken);

// @ts-expect-error mock create mirrors real NexusInstance.create metadata safety.
void mock.nexus.create(UpstreamPingToken);

// @ts-expect-error mock create rejects narrower token metadata because matchers receive any runtime identity.
void mock.nexus.create(BackgroundOnlyPingToken);

void AnyPingToken;

// @ts-expect-error mock safeCreate mirrors real NexusInstance.safeCreate metadata safety.
void mock.nexus.safeCreate(UpstreamPingToken);

// @ts-expect-error mock safeCreate rejects narrower token metadata because matchers receive any runtime identity.
void mock.nexus.safeCreate(BackgroundOnlyPingToken);

mock.service(UpstreamPingToken, { ping: () => "pong" });
mock.failCreate(UpstreamPingToken, new Error("boom"));
mock.clear(UpstreamPingToken);
