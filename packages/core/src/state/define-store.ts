import { NexusUsageError } from "@/errors";
import { Token } from "@/api/token";
import { z } from "zod";
import type { CreateOptions } from "@/api/types/config";
import type { UserMetadata } from "@/types/identity";
import type {
  NexusStoreDefinition,
  NexusStoreServiceContract,
  StoreActionHelpers,
} from "./types";
import { createTargetCriteriaSchema } from "./target-schema";

export const TargetCriteriaSchema = createTargetCriteriaSchema(
  "defaultTarget requires at least one of descriptor or matcher",
);

export const DefineNexusStoreSchema = z.object({
  token: z.instanceof(Token),
  state: z.custom<() => object>((value) => typeof value === "function"),
  actions: z.custom<(helpers: unknown) => object>(
    (value) => typeof value === "function",
  ),
  defaultTarget: TargetCriteriaSchema.optional(),
  sync: z
    .object({
      mode: z.literal("snapshot").optional(),
    })
    .optional(),
});

export type DefineNexusStoreSchemaInput = z.input<
  typeof DefineNexusStoreSchema
>;

export type DefineNexusStoreOptions<
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
  U extends UserMetadata = UserMetadata,
  M extends string = string,
  D extends string = string,
> = Omit<
  DefineNexusStoreSchemaInput,
  "token" | "state" | "actions" | "defaultTarget"
> & {
  token: Token<NexusStoreServiceContract<TState, TActions>>;
  state: () => TState;
  actions: (helpers: StoreActionHelpers<TState>) => TActions;
  defaultTarget?: CreateOptions<U, M, D>["target"];
};

const normalizeTokenDefaultTarget = <
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
>(
  token: Token<NexusStoreServiceContract<TState, TActions>>,
  defaultTarget: CreateOptions<any, any, any>["target"],
): Token<NexusStoreServiceContract<TState, TActions>> => {
  const nextDefaultTarget = {
    ...(token.defaultTarget ?? {}),
    ...defaultTarget,
  };

  return new Token<NexusStoreServiceContract<TState, TActions>>(
    token.id,
    nextDefaultTarget,
  );
};

export const defineNexusStore = <
  TState extends object,
  TActions extends Record<string, (...args: any[]) => any>,
  U extends UserMetadata = UserMetadata,
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
  };
};
