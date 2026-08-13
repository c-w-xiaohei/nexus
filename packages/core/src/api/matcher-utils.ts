import type { EndpointMeta } from "../types/identity.js";

type MatcherResolver<U extends EndpointMeta> = (
  name: string,
) => ((identity: U) => boolean) | undefined;

type MatcherLike<U extends EndpointMeta, M extends string> =
  | M
  | ((identity: U) => boolean);

export namespace MatcherCombinators {
  export const and = <U extends EndpointMeta, M extends string>(
    resolve: MatcherResolver<U>,
    ...matchers: MatcherLike<U, M>[]
  ): ((identity: U) => boolean) => {
    return (identity: U) => {
      for (const matcher of matchers) {
        const matcherFn =
          typeof matcher === "string" ? resolve(matcher) : matcher;
        if (!matcherFn || !matcherFn(identity)) {
          return false;
        }
      }

      return true;
    };
  };

  export const or = <U extends EndpointMeta, M extends string>(
    resolve: MatcherResolver<U>,
    ...matchers: MatcherLike<U, M>[]
  ): ((identity: U) => boolean) => {
    return (identity: U) => {
      for (const matcher of matchers) {
        const matcherFn =
          typeof matcher === "string" ? resolve(matcher) : matcher;
        if (matcherFn?.(identity)) {
          return true;
        }
      }

      return false;
    };
  };

  export const not = <U extends EndpointMeta, M extends string>(
    resolve: MatcherResolver<U>,
    matcher: MatcherLike<U, M>,
  ): ((identity: U) => boolean) => {
    return (identity: U) => {
      const matcherFn =
        typeof matcher === "string" ? resolve(matcher) : matcher;
      return !matcherFn?.(identity);
    };
  };
}
