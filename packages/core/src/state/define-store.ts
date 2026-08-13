import { NexusUsageError } from "../errors/index.js";
import { Token } from "../api/token.js";
import { z } from "zod";
import type { CreateOptions } from "../api/types/config.js";
import type { InlineTarget } from "../api/types/config.js";
import type { EndpointMeta } from "../types/identity.js";
import type {
  ActionFunction,
  NexusStoreDefinition,
  NexusStoreServiceContract,
  NexusStoreValidationSchemas,
  StoreTokenMetadata,
  StoreActionHelpers,
} from "./types.js";
import { createTargetSchema } from "./target-schema.js";

export const TargetSchema = createTargetSchema(
  "defaultTarget requires at least one of descriptor or matcher",
);

export const DefineNexusStoreSchema = z.object({
  token: z.instanceof(Token),
  state: z.custom<() => object>((value) => typeof value === "function"),
  actions: z.custom<(helpers: unknown) => object>(
    (value) => typeof value === "function",
  ),
  defaultTarget: TargetSchema.optional(),
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
  U extends EndpointMeta = EndpointMeta,
  M extends string = string,
  D extends string = string,
> = Omit<
  DefineNexusStoreSchemaInput,
  "token" | "state" | "actions" | "defaultTarget" | "validation"
> & {
  token: Token<NexusStoreServiceContract<TState, TActions>, U>;
  state: () => TState;
  actions: (helpers: StoreActionHelpers<TState>) => TActions;
  defaultTarget?: CreateOptions<U, M, D>["target"];
  validation?: NexusStoreValidationSchemas<TState, TActions>;
};

export type DefineNexusStoreOptionsWithToken<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  TToken extends Token<NexusStoreServiceContract<TState, TActions>, any>,
  M extends string = string,
  D extends string = string,
> = Omit<
  DefineNexusStoreOptions<TState, TActions, StoreTokenMetadata<TToken>, M, D>,
  "token"
> & {
  token: TToken;
};

const normalizeTokenDefaultTarget = <
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  U extends EndpointMeta,
>(
  token: Token<NexusStoreServiceContract<TState, TActions>, U>,
  defaultTarget: CreateOptions<any, any, any>["target"],
): Token<NexusStoreServiceContract<TState, TActions>, U> => {
  return new Token<NexusStoreServiceContract<TState, TActions>, U>(token.id, {
    defaultTarget: (defaultTarget ?? undefined) as InlineTarget<U> | undefined,
  });
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
  U extends EndpointMeta = StoreTokenMetadata<TToken>,
>(options: TOptions): NexusStoreDefinition<TState, TActions, U>;
export function defineNexusStore<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  TToken extends Token<NexusStoreServiceContract<TState, TActions>, any>,
  M extends string = string,
  D extends string = string,
>(
  options: DefineNexusStoreOptionsWithToken<TState, TActions, TToken, M, D>,
): NexusStoreDefinition<TState, TActions, StoreTokenMetadata<TToken>>;
export function defineNexusStore<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  U extends EndpointMeta = EndpointMeta,
  M extends string = string,
  D extends string = string,
>(
  options: DefineNexusStoreOptions<TState, TActions, U, M, D>,
): NexusStoreDefinition<TState, TActions, U>;
export function defineNexusStore<
  TState extends object,
  TActions extends Record<string, ActionFunction>,
  U extends EndpointMeta = EndpointMeta,
  M extends string = string,
  D extends string = string,
>(
  options: DefineNexusStoreOptions<TState, TActions, U, M, D>,
): NexusStoreDefinition<TState, TActions, U> {
  const parsed = DefineNexusStoreSchema.safeParse(options);
  if (!parsed.success) {
    throw new NexusUsageError(
      "Nexus State: Invalid store definition options.",
      "E_USAGE_INVALID",
      { cause: parsed.error },
    );
  }

  const token = options.defaultTarget
    ? normalizeTokenDefaultTarget<TState, TActions, U>(
        options.token,
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
