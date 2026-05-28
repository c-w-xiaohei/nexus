import { ResultAsync, errAsync, type ResultAsync as RA } from "neverthrow";
import type {
  Asyncified,
  CreateOptions,
  EndpointMeta,
  Token,
} from "@nexus-js/core";
import { useNexus } from "./use-nexus";

type TokenEndpoint<TToken> = TToken extends Token<any, infer U>
  ? U
  : EndpointMeta;

type TokenService<TToken> = TToken extends Token<infer T, any> ? T : never;

const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export interface UseNexusServiceResult<TService extends object> {
  create(): Promise<Asyncified<TService>>;
  safeCreate(): RA<Asyncified<TService>, Error>;
  call<TResult>(
    run: (service: Asyncified<TService>) => TResult | Promise<TResult>,
  ): Promise<Awaited<TResult>>;
  safeCall<TResult>(
    run: (service: Asyncified<TService>) => TResult | Promise<TResult>,
  ): RA<Awaited<TResult>, Error>;
}

export const useNexusService = <
  TToken extends Token<object, any>,
  RegisteredMatchers extends string = string,
  RegisteredDescriptors extends string = string,
>(
  token: TToken,
  options?: CreateOptions<
    TokenEndpoint<TToken>,
    RegisteredMatchers,
    RegisteredDescriptors
  >,
): UseNexusServiceResult<TokenService<TToken>> => {
  const nexus = useNexus();

  const create = (): Promise<Asyncified<TokenService<TToken>>> =>
    nexus.create(token as never, options as never) as Promise<
      Asyncified<TokenService<TToken>>
    >;

  const safeCreate = (): RA<Asyncified<TokenService<TToken>>, Error> =>
    nexus.safeCreate(token as never, options as never) as RA<
      Asyncified<TokenService<TToken>>,
      Error
    >;

  const call = async <TResult,>(
    run: (service: Asyncified<TokenService<TToken>>) => TResult | Promise<TResult>,
  ): Promise<Awaited<TResult>> => {
    const service = await create();
    return await run(service);
  };

  const safeCall = <TResult,>(
    run: (service: Asyncified<TokenService<TToken>>) => TResult | Promise<TResult>,
  ): RA<Awaited<TResult>, Error> =>
    safeCreate().andThen((service) => {
      try {
        return ResultAsync.fromPromise(
          Promise.resolve(run(service)),
          normalizeError,
        );
      } catch (error) {
        return errAsync(normalizeError(error));
      }
    });

  return {
    create,
    safeCreate,
    call,
    safeCall,
  };
};
