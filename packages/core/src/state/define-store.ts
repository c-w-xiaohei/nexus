import { NexusUsageError } from "@/errors";
import { Token } from "@/api/token";
import { z } from "zod";
import type { CreateOptions } from "@/api/types/config";
import type { InlineTarget } from "@/api/types/config";
import type { EndpointMeta } from "@/types/identity";
import type {
  NexusStoreDefinition,
  NexusStoreServiceContract,
  NexusStoreValidationSchemas,
  StoreActionHelpers,
} from "./types";
import { createTargetSchema } from "./target-schema";

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
        }>((value) => typeof value === "object" && value !== null && typeof (value as { safeParse?: unknown }).safeParse === "function")
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
  TActions extends Record<string, (...args: any[]) => any>,
  U extends EndpointMeta = EndpointMeta,
  M extends string = string,
  D extends string = string,
> = Omit<
  DefineNexusStoreSchemaInput,
  "token" | "state" | "actions" | "defaultTarget" | "validation"
> & {
  token: Token<NexusStoreServiceContract<TState, TActions>>;
  state: () => TState;
  actions: (helpers: StoreActionHelpers<TState>) => TActions;
  defaultTarget?: CreateOptions<U, M, D>["target"];
  validation?: NexusStoreValidationSchemas<TState, TActions>;
};

const normalizeTokenDefaultTarget = <
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
>(
  token: Token<NexusStoreServiceContract<TState, TActions>>,
  defaultTarget: CreateOptions<any, any, any>["target"],
): Token<NexusStoreServiceContract<TState, TActions>> => {
  return new Token<NexusStoreServiceContract<TState, TActions>>(
    token.id,
    { defaultTarget: (defaultTarget ?? undefined) as InlineTarget<object> | undefined },
  );
};

export const defineNexusStore = <
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
  U extends EndpointMeta = EndpointMeta,
  M extends string = string,
  D extends string = string,
>(
  options: DefineNexusStoreOptions<TState, TActions, U, M, D>,
): NexusStoreDefinition<TState, TActions> => {
  const parsed = DefineNexusStoreSchema.safeParse(options);
  if (!parsed.success) {
    throw new NexusUsageError(
      "Nexus State: Invalid store definition options.",
      "E_USAGE_INVALID",
      { cause: parsed.error },
    );
  }

  const token = options.defaultTarget
    ? normalizeTokenDefaultTarget(options.token, options.defaultTarget)
    : options.token;

  return {
    token,
    state: options.state,
    actions: options.actions,
    sync: options.sync,
    validation: options.validation,
  };
};
