import { expectTypeOf } from "vitest";
import {
  type AdapterModel,
  type Asyncified,
  Nexus,
  Token,
  type NexusInstance,
  type RefWrapper,
  serviceProvider,
} from "@/index";

interface PingService {
  ping(): string;
}

interface OwnedProcessor {
  process(): string;
}

interface ResourceService {
  processor: RefWrapper<OwnedProcessor>;
  getProcessor(): Promise<RefWrapper<OwnedProcessor>>;
  getOptionalProcessor(): Promise<RefWrapper<OwnedProcessor> | null>;
  getPlainObject(): Promise<{ value: string }>;
}

interface ReservedMemberService {
  nested: {
    then(): string;
    catch(): string;
    finally(): string;
    value: string;
  };
}

interface NestedCallableService {
  nested: {
    invoke(value: string): string;
  };
}

declare const reservedService: Asyncified<ReservedMemberService>;
expectTypeOf(reservedService.nested.then).toEqualTypeOf<
  PromiseLike<ReservedMemberService["nested"]>["then"]
>();
expectTypeOf(reservedService.nested.catch).toEqualTypeOf<
  import("@/api/types").RemoteValue<ReservedMemberService["nested"]>["catch"]
>();
expectTypeOf(reservedService.nested.finally).toEqualTypeOf<
  import("@/api/types").RemoteValue<ReservedMemberService["nested"]>["finally"]
>();

declare const nestedCallable: Asyncified<NestedCallableService>;
expectTypeOf(nestedCallable.nested.invoke).toEqualTypeOf<
  (value: string) => import("@/api/types").RemoteValue<string>
>();

const ResourceToken = new Token<ResourceService>("test:resource");
declare const resourceNexus: NexusInstance;
const resourceConnection = await resourceNexus.connect();
const resourceService = resourceConnection.get(ResourceToken);
const processor = await resourceService.getProcessor();
expectTypeOf(processor).toMatchTypeOf<
  Asyncified<OwnedProcessor> & Disposable
>();
processor[Symbol.dispose]();

const propertyProcessor = await resourceService.processor;
expectTypeOf(propertyProcessor).toMatchTypeOf<
  Asyncified<OwnedProcessor> & Disposable
>();
propertyProcessor[Symbol.dispose]();

const optionalProcessor = await resourceService.getOptionalProcessor();
if (optionalProcessor !== null) {
  expectTypeOf(optionalProcessor).toMatchTypeOf<
    Asyncified<OwnedProcessor> & Disposable
  >();
  optionalProcessor[Symbol.dispose]();
}

const plainObject = await resourceService.getPlainObject();
// @ts-expect-error ordinary object returns are not disposable resources.
plainObject[Symbol.dispose]();
// @ts-expect-error service roots are not disposable resources.
resourceService[Symbol.dispose]();

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

const ModelBoundPingToken = new Token<PingService, ChromeModel>(
  "test:model-bound-ping",
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

const ChromePingToken = new Token<PingService, ChromeModel>("test:chrome-ping");

const BackgroundOnlyPingToken = new Token<PingService, ChromeModel>(
  "test:background-only-ping",
);

const rejectBackgroundOnlyAsChromeToken: Token<PingService, ChromeModel> =
  BackgroundOnlyPingToken;
void rejectBackgroundOnlyAsChromeToken;

const UpstreamPingToken = new Token<PingService, UpstreamModel>(
  "test:upstream-ping",
);

const AnyPingToken = new Token<PingService, any>("test:any-ping");

const chromeNexus = new Nexus<ChromeModel>();

expectTypeOf(chromeNexus).toMatchTypeOf<NexusInstance<ChromeModel>>();

void chromeNexus
  .connect({ target: { context: "background" } })
  .then((connection) => connection.get(PlainPingToken));
void chromeNexus
  .connect({ target: { context: "background" } })
  .then((connection) => connection.get(ChromePingToken));
void chromeNexus
  .safeConnect({ target: { context: "background" } })
  .then((result) => {
    if (result.isOk()) result.value.get(ChromePingToken);
  });

void chromeNexus
  .connect({ target: { context: "background" } })
  .then((connection) => {
    // @ts-expect-error model-bound tokens cannot cross adapter models.
    connection.get(UpstreamPingToken);
  });

void chromeNexus
  .connect({ target: { context: "background" } })
  .then((connection) => connection.get(BackgroundOnlyPingToken));

void AnyPingToken;

void chromeNexus
  .safeConnect({ target: { context: "background" } })
  .then((result) => {
    if (result.isOk()) {
      // @ts-expect-error model-bound tokens cannot cross adapter models.
      result.value.get(UpstreamPingToken);
    }
  });

void chromeNexus
  .safeConnect({ target: { context: "background" } })
  .then((result) => {
    if (result.isOk()) result.value.get(BackgroundOnlyPingToken);
  });

chromeNexus.provide(ChromePingToken, { ping: () => "pong" });
chromeNexus.safeProvide(ChromePingToken, { ping: () => "pong" });
chromeNexus.provide({
  token: ChromePingToken,
  service: { ping: () => "pong" },
});
chromeNexus.safeProvide([
  { token: ChromePingToken, service: { ping: () => "pong" } },
]);
// @ts-expect-error a token registration requires its implementation.
chromeNexus.provide(ChromePingToken);
// @ts-expect-error safe registration also requires its implementation.
chromeNexus.safeProvide(ChromePingToken);
// @ts-expect-error implementations must satisfy the token's contract.
chromeNexus.provide(ChromePingToken, { ping: () => 123 });
chromeNexus.provide(
  // @ts-expect-error descriptors do not accept a separate implementation.
  { token: ChromePingToken, service: { ping: () => "pong" } },
  {},
);
// @ts-expect-error model-bound provider tokens cannot cross adapters.
chromeNexus.safeProvide(UpstreamPingToken, { ping: () => "pong" });

const publicNexus: NexusInstance<ChromeModel> = chromeNexus;
publicNexus.provide(
  ChromePingToken,
  { ping: () => "pong" },
  {
    policy: {
      canCall: (context) => context.remoteIdentity.runtime === "background",
    },
  },
);
publicNexus.safeProvide({
  token: ChromePingToken,
  service: { ping: () => "pong" },
});
// @ts-expect-error the interface and class both require a token implementation.
publicNexus.provide(ChromePingToken);
// @ts-expect-error the interface also preserves adapter model constraints.
publicNexus.safeProvide(UpstreamPingToken, { ping: () => "pong" });

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
