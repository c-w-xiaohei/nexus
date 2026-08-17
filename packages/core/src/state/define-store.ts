import { NexusUsageError } from "@/errors";
import { Token } from "@/api/token";
import type { TokenOptions } from "@/api/token";
import { z } from "zod";
import type { AdapterModel, ConnectionTargetOf } from "@/types/adapter-model";
import type {
  ActionFunction,
  NexusStoreDefinition,
  NexusStoreServiceContract,
  NexusStoreValidationSchemas,
  StoreTokenMetadata,
  StoreActionHelpers,
} from "./types";

export const DefineNexusStoreSchema = z.object({
  token: z.instanceof(Token),
  state: z.custom<() => object>((value) => typeof value === "function"),
  actions: z.custom<(helpers: unknown) => object>(
    (value) => typeof value === "function",
  ),
  defaultTarget: z.custom<object>().optional(),
  sync: z
    .object({
      mode: z.literal("snapshot").optional(),
    })
    .optional(),
  validation: z
    .object({
      state: z
        .custom<{
          safeParse: (value: unknown) => { success: boolean };
        }>(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            typeof (value as { safeParse?: unknown }).safeParse === "function",
        )
        .optional(),
      actionResults: z
        .record(
          z.string(),
          z.custom<{ safeParse: (value: unknown) => { success: boolean } }>(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              typeof (value as { safeParse?: unknown }).safeParse ===
                "function",
          ),
        )
        .optional(),
    })
    .optional(),
});

export type DefineNexusStoreSchemaInput = z.input<
  typeof DefineNexusStoreSchema
>;

export type DefineNexusStoreOptions<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  M extends AdapterModel = AdapterModel,
> = Omit<
  DefineNexusStoreSchemaInput,
  "token" | "state" | "actions" | "defaultTarget" | "validation"
> & {
  token:
    | Token<NexusStoreServiceContract<TState, TActions>, M>
    | Token<NexusStoreServiceContract<TState, TActions>>;
  state: () => TState;
  actions: (helpers: StoreActionHelpers<TState>) => TActions;
  defaultTarget?: ConnectionTargetOf<M>;
  validation?: NexusStoreValidationSchemas<TState, TActions>;
};

export type DefineNexusStoreOptionsWithToken<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  TToken extends Token<NexusStoreServiceContract<TState, TActions>, any>,
> = Omit<
  DefineNexusStoreOptions<TState, TActions, StoreTokenMetadata<TToken>>,
  "token"
> & {
  token: TToken;
};

const normalizeTokenDefaultTarget = <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  M extends AdapterModel,
>(
  token: Token<NexusStoreServiceContract<TState, TActions>, M>,
  defaultTarget: ConnectionTargetOf<M>,
): Token<NexusStoreServiceContract<TState, TActions>, M> => {
  return new Token<NexusStoreServiceContract<TState, TActions>, M>(token.id, {
    defaultTarget,
  } as TokenOptions<M>);
};

export function defineNexusStore<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  const TOptions extends DefineNexusStoreOptionsWithToken<
    TState,
    TActions,
    Token<NexusStoreServiceContract<TState, TActions>, any>
  > = DefineNexusStoreOptionsWithToken<
    TState,
    TActions,
    Token<NexusStoreServiceContract<TState, TActions>, any>
  >,
  TToken extends TOptions["token"] = TOptions["token"],
  M extends AdapterModel = StoreTokenMetadata<TToken>,
>(options: TOptions): NexusStoreDefinition<TState, TActions, M>;
export function defineNexusStore<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  TToken extends Token<NexusStoreServiceContract<TState, TActions>, any>,
>(
  options: DefineNexusStoreOptionsWithToken<TState, TActions, TToken>,
): NexusStoreDefinition<TState, TActions, StoreTokenMetadata<TToken>>;
export function defineNexusStore<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  M extends AdapterModel = AdapterModel,
>(
  options: DefineNexusStoreOptions<TState, TActions, M>,
): NexusStoreDefinition<TState, TActions, M>;
export function defineNexusStore<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  M extends AdapterModel = AdapterModel,
>(
  options: DefineNexusStoreOptions<TState, TActions, M>,
): NexusStoreDefinition<TState, TActions, M> {
  const parsed = DefineNexusStoreSchema.safeParse(options);
  if (!parsed.success) {
    throw new NexusUsageError(
      "Nexus State: Invalid store definition options.",
      "E_USAGE_INVALID",
      { cause: parsed.error },
    );
  }

  const token = options.defaultTarget
    ? normalizeTokenDefaultTarget<TState, TActions, M>(
        options.token as Token<NexusStoreServiceContract<TState, TActions>, M>,
        options.defaultTarget,
      )
    : options.token;

  return {
    token,
    state: options.state,
    actions: options.actions,
    sync: options.sync,
    validation: options.validation,
  };
}
