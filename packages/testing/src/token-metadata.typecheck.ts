import { Token, type AdapterModel } from "@nexus-js/core";
import { createMockNexus } from "./index.js";

interface PingService {
  readonly ping: () => string;
}

type ChromeContextMeta =
  | { readonly runtime: "background" }
  | { readonly runtime: "content-script"; readonly tabId: number };

interface ChromeConnectionMeta {
  readonly platform: "chrome";
}

interface ChromeAdapterModel extends AdapterModel {
  contextMeta: ChromeContextMeta;
  connectionMeta: ChromeConnectionMeta;
  connectionTarget: Partial<ChromeContextMeta>;
}

type UpstreamContextMeta = {
  readonly runtime: "upstream";
  readonly workerId: string;
};
interface UpstreamAdapterModel extends AdapterModel {
  contextMeta: UpstreamContextMeta;
  connectionMeta: object;
  connectionTarget: Partial<UpstreamContextMeta>;
}

const ChromePingToken = new Token<PingService, ChromeAdapterModel>(
  "mock:chrome-ping",
  {
    defaultTarget: {
      runtime: "background",
    },
  },
);

const BackgroundOnlyPingToken = new Token<PingService, ChromeAdapterModel>(
  "mock:background-only-ping",
  {
    defaultTarget: {
      runtime: "background",
    },
  },
);

const UpstreamPingToken = new Token<PingService, UpstreamAdapterModel>(
  "mock:upstream-ping",
  {
    defaultTarget: {
      runtime: "upstream",
      workerId: "worker-1",
    },
  },
);

const AnyPingToken = new Token<PingService, any>("mock:any-ping");

const mock = createMockNexus<ChromeAdapterModel>();

mock.service(
  ChromePingToken,
  { ping: () => "pong" },
  {
    contextMeta: { runtime: "background" },
    connectionMeta: { platform: "chrome" },
  },
);
mock.failCreate(ChromePingToken, new Error("boom"));
mock.clear(ChromePingToken);

void mock.nexus.create(ChromePingToken);
void mock.nexus.safeCreate(ChromePingToken);

void createMockNexus<UpstreamAdapterModel>().nexus.create(UpstreamPingToken);

void mock.nexus.create(BackgroundOnlyPingToken);

void AnyPingToken;

void createMockNexus<UpstreamAdapterModel>().nexus.safeCreate(
  UpstreamPingToken,
);

void mock.nexus.safeCreate(BackgroundOnlyPingToken);

void mock.nexus.create(ChromePingToken, {
  target: { runtime: "upstream", workerId: "worker-1" },
});

const upstreamMock = createMockNexus<UpstreamAdapterModel>();
upstreamMock.service(
  UpstreamPingToken,
  { ping: () => "pong" },
  {
    contextMeta: { runtime: "upstream", workerId: "worker-1" },
    connectionMeta: {},
  },
);
upstreamMock.failCreate(UpstreamPingToken, new Error("boom"));
upstreamMock.clear(UpstreamPingToken);
