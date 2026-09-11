import { Nexus } from "@/index";
import type { CreateOptions } from "@/api/types/config";
import { expectTypeOf } from "vitest";
import { z } from "zod";
import type { StateCreator } from "zustand/vanilla";
import {
  connectNexusStore,
  createNexusStore,
  createStoreToken,
  safeConnectNexusStore,
  safeInvokeStoreAction,
  type ConnectNexusStoreOptions,
  type RemoteActions,
  type RemoteStore,
  type StoreData,
} from "./index.js";

interface CounterStore {
  count: number;
  increment(by: number): number;
}

interface AsyncStore {
  count: number;
  increment(by: number, label?: string): Promise<{ value: number }>;
  reset(): void;
}

type ChromeMeta = { runtime: "background" };
type ChromeConnection = { platform: "chrome" };
type ChromeModel = {
  contextMeta: ChromeMeta;
  connectionMeta: ChromeConnection;
  connectionTarget: { context: "background" };
};

const token = createStoreToken<CounterStore, ChromeModel>(
  "state:chrome-counter",
  {
    defaultTarget: { context: "background" },
    validation: { state: z.object({ count: z.number() }) },
  },
);
expectTypeOf(token.validation).toEqualTypeOf<
  | {
      state?: z.ZodType<{ count: number }>;
      actionResults?: { increment?: z.ZodType<number> };
    }
  | undefined
>();
expectTypeOf<StoreData<CounterStore>>().toEqualTypeOf<{ count: number }>();
expectTypeOf<RemoteActions<CounterStore>>().toEqualTypeOf<{
  increment(by: number): Promise<number>;
}>();
expectTypeOf<RemoteStore<CounterStore>["actions"]>().toEqualTypeOf<
  RemoteActions<CounterStore>
>();
expectTypeOf<RemoteActions<AsyncStore>["reset"]>().toEqualTypeOf<
  () => Promise<void>
>();
expectTypeOf<ConnectNexusStoreOptions<ChromeModel>>().toEqualTypeOf<
  Pick<CreateOptions<ChromeModel>, "target" | "where" | "timeout">
>();

const creator: StateCreator<CounterStore> = (set, get) => ({
  count: 0,
  increment(by: number) {
    set({ count: get().count + by });
    return get().count;
  },
});

const chromeNexus = new Nexus<ChromeModel>();
const localBinding = createNexusStore(token, creator, {
  snapshot: ({ count }) => ({ count }),
  expose: ["increment"],
});
const remotePromise = connectNexusStore(chromeNexus, token);
const safeRemotePromise = safeConnectNexusStore(chromeNexus, token);
expectTypeOf(remotePromise).toEqualTypeOf<Promise<RemoteStore<CounterStore>>>();

const portableToken = createStoreToken<CounterStore>("state:portable-counter");
const portableRemote = connectNexusStore(chromeNexus, portableToken);
expectTypeOf(portableRemote).toEqualTypeOf<
  Promise<RemoteStore<CounterStore>>
>();
if (false) {
  createStoreToken<CounterStore>("state:invalid-validation", {
    validation: {
      // @ts-expect-error State validation accepts only data fields, not methods.
      state: z.object({ count: z.string() }),
      actionResults: {
        // @ts-expect-error Action validation derives the method return type.
        increment: z.string(),
      },
    },
  });
  createNexusStore(token, creator, {
    // @ts-expect-error Snapshots must include every Store data field.
    snapshot: () => ({}),
    expose: ["increment"],
  });
  createNexusStore(token, creator, {
    snapshot: ({ count }) => ({ count }),
    // @ts-expect-error Exposed action keys must be Store methods.
    expose: ["count"],
  });
  const remote = {} as RemoteStore<AsyncStore>;
  const increment = safeInvokeStoreAction(remote, "increment", [1]);
  const reset = safeInvokeStoreAction(remote, "reset", []);
  void increment;
  void reset;
  // @ts-expect-error Action arguments derive from the Store method.
  safeInvokeStoreAction(remote, "increment", ["one"]);
}

const assertRemote = (remote: RemoteStore<CounterStore>) => {
  remote.getState();
  remote.getInitialState();
  remote.subscribeStatus(() => undefined);
  remote[Symbol.dispose]();
};

localBinding.store.getInitialState();
localBinding.destroy();
void remotePromise.then(assertRemote);
void safeRemotePromise.then((result) => {
  if (result.isOk()) assertRemote(result.value);
});
