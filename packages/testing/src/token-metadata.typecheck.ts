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
);

const BackgroundOnlyPingToken = new Token<PingService, ChromeAdapterModel>(
  "mock:background-only-ping",
);

const UpstreamPingToken = new Token<PingService, UpstreamAdapterModel>(
  "mock:upstream-ping",
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
mock.clear(ChromePingToken);
void BackgroundOnlyPingToken;

void AnyPingToken;

const upstreamMock = createMockNexus<UpstreamAdapterModel>();
upstreamMock.service(
  UpstreamPingToken,
  { ping: () => "pong" },
  {
    contextMeta: { runtime: "upstream", workerId: "worker-1" },
    connectionMeta: {},
  },
);
upstreamMock.clear(UpstreamPingToken);
