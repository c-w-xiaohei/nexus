import { Nexus, Token } from "@/index";
import type { StateCreator } from "zustand/vanilla";
import { expectTypeOf } from "vitest";
import type { CreateOptions } from "@/api/types/config";
import { z } from "zod";
import type { Result } from "better-result";
import {
  connectNexusStore,
  createNexusStore,
  safeConnectNexusStore,
  safeInvokeStoreAction,
  type SafeInvokeStoreActionError,
  type NexusStoreServiceContract,
  type RemoteStore,
  type ActionArgs,
  type ActionResult,
  type ConnectNexusStoreOptions,
  type NexusStoreDefinition,
  type RemoteActions,
} from "./index.js";

interface CounterState {
  count: number;
}

type CounterActions = {
  increment(by: number): number;
};

type ChromeMeta = { runtime: "background" };
type ChromeConnection = { platform: "chrome" };
type ChromeModel = {
  contextMeta: ChromeMeta;
  connectionMeta: ChromeConnection;
  connectionTarget: { context: "background" };
};

const token = new Token<
  NexusStoreServiceContract<CounterState, CounterActions>,
  ChromeModel
>("state:chrome-counter", { defaultTarget: { context: "background" } });

const definition = { token };

const validatedDefinition = {
  token,
  validation: { state: z.object({ count: z.number() }) },
} satisfies NexusStoreDefinition<CounterState, CounterActions, ChromeModel>;
expectTypeOf(validatedDefinition.token).toEqualTypeOf<typeof token>();
expectTypeOf<RemoteActions<CounterActions>>().toEqualTypeOf<{
  increment(by: number): Promise<number>;
}>();
expectTypeOf<
  RemoteStore<CounterState, CounterActions>["actions"]
>().toEqualTypeOf<RemoteActions<CounterActions>>();
type AsyncActions = {
  increment(by: number, label?: string): Promise<{ value: number }>;
  reset(): void;
};
expectTypeOf<ActionArgs<AsyncActions, "increment">>().toEqualTypeOf<
  [number, label?: string]
>();
expectTypeOf<ActionResult<AsyncActions, "increment">>().toEqualTypeOf<{
  value: number;
}>();
expectTypeOf<RemoteActions<AsyncActions>["reset"]>().toEqualTypeOf<
  () => Promise<void>
>();
expectTypeOf<ConnectNexusStoreOptions<ChromeModel>>().toEqualTypeOf<
  Pick<CreateOptions<ChromeModel>, "target" | "where" | "timeout">
>();

const creator: StateCreator<CounterState & CounterActions> = (set, get) => ({
  count: 0,
  increment(by: number) {
    set({ count: get().count + by });
    return get().count;
  },
});

const chromeNexus = new Nexus<ChromeModel>();
const localBinding = createNexusStore(definition, creator, {
  snapshot: ({ count }) => ({ count }),
  expose: ["increment"],
});
const local = localBinding.store;
const remotePromise = connectNexusStore(chromeNexus, definition);
const safeRemotePromise = safeConnectNexusStore(chromeNexus, definition);
expectTypeOf(remotePromise).toEqualTypeOf<
  Promise<RemoteStore<CounterState, CounterActions>>
>();

const portableDefinition = {
  token: new Token<NexusStoreServiceContract<CounterState, CounterActions>>(
    "state:portable-counter",
  ),
};
const portableRemote = connectNexusStore(chromeNexus, portableDefinition);
expectTypeOf(portableRemote).toEqualTypeOf<
  Promise<RemoteStore<CounterState, CounterActions>>
>();
if (false) {
  const remote = {} as RemoteStore<CounterState, AsyncActions>;
  expectTypeOf(safeInvokeStoreAction(remote, "increment", [1])).toEqualTypeOf<
    Promise<Result<{ value: number }, SafeInvokeStoreActionError>>
  >();
  expectTypeOf(safeInvokeStoreAction(remote, "reset", [])).toEqualTypeOf<
    Promise<Result<void, SafeInvokeStoreActionError>>
  >();
  // @ts-expect-error Each action retains its own argument tuple.
  safeInvokeStoreAction(remote, "increment", ["one"]);

  const invalidDefinition = {
    token,
    // @ts-expect-error A plain definition must retain the Token's state contract.
    validation: { state: z.object({ count: z.string() }) },
  } satisfies NexusStoreDefinition<CounterState, CounterActions, ChromeModel>;
  void invalidDefinition;
}

const assertRemote = (remote: RemoteStore<CounterState, CounterActions>) => {
  remote.getState();
  remote.getInitialState();
  remote.subscribeStatus(() => undefined);
  remote[Symbol.dispose]();
};

local.getInitialState();
localBinding.destroy();
void remotePromise.then(assertRemote);
void safeRemotePromise.then((result) => {
  if (result.isOk()) assertRemote(result.value);
});
