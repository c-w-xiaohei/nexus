import {
  NexusTargetingError,
  NexusUsageError,
  Token,
  type Asyncified,
  type CreateOptions,
  type EndpointMeta,
  type MatcherTarget,
  type NexusConfig,
  type NexusInstance,
  type PlatformMeta,
  type Target,
} from "@nexus-js/core";
import { err, errAsync, ok, okAsync, type Result } from "neverthrow";
import { NexusMockError } from "./errors";

type GetMatchers<T> = T extends { matchers: infer M }
  ? keyof M & string
  : never;
type GetDescriptors<T> = T extends { descriptors: infer D }
  ? keyof D & string
  : never;

interface RegisteredService {
  readonly token: Token<object, any>;
  readonly service: object;
}

export interface MockNexusCreateCall<
  U extends EndpointMeta = EndpointMeta,
  M extends string = string,
  D extends string = string,
> {
  readonly tokenId: string;
  readonly token: Token<object, any>;
  readonly options: CreateOptions<U, M, D>;
}

export interface MockNexusConfigureCall<
  U extends EndpointMeta = EndpointMeta,
  P extends PlatformMeta = PlatformMeta,
> {
  readonly config: NexusConfig<U, P>;
}

export interface MockNexusReleaseCall {
  readonly proxy: object;
}

export interface MockNexusUpdateIdentityCall<
  U extends EndpointMeta = EndpointMeta,
> {
  readonly updates: Partial<U>;
}

export interface MockNexus<
  U extends EndpointMeta = EndpointMeta,
  P extends PlatformMeta = PlatformMeta,
  RegisteredMatchers extends string = never,
  RegisteredDescriptors extends string = never,
> {
  readonly nexus: NexusInstance<
    U,
    P,
    RegisteredMatchers,
    RegisteredDescriptors
  >;
  service<T extends object>(token: Token<T>, implementation: T): void;
  failCreate<T extends object>(token: Token<T>, error: Error): void;
  clear<T extends object>(token?: Token<T>): void;
  readonly calls: {
    create<T extends object>(
      token?: Token<T>,
    ): readonly MockNexusCreateCall<
      U,
      RegisteredMatchers,
      RegisteredDescriptors
    >[];
    configure(): readonly MockNexusConfigureCall<U, P>[];
    release(): readonly MockNexusReleaseCall[];
    updateIdentity(): readonly MockNexusUpdateIdentityCall<U>[];
  };
}

const REF_WRAPPER_SYMBOL = Symbol.for("nexus.ref.wrapper");

const isTargetEmpty = <
  U extends EndpointMeta,
  M extends string,
  D extends string,
>(
  target: Target<U, M, D> | null | undefined,
): boolean =>
  !target || Object.values(target).every((value) => value === undefined);

const unsupportedOperationError = () =>
  new NexusMockError(
    "Mock Nexus does not support multicast operations.",
    "E_MOCK_UNSUPPORTED_OPERATION",
  );

const serviceNotFoundError = (tokenId: string) =>
  new NexusMockError(
    `No mock service is registered for token '${tokenId}'.`,
    "E_MOCK_SERVICE_NOT_FOUND",
    { tokenId },
  );

const invalidCreateOptionsError = () =>
  new NexusUsageError("Mock Nexus create options must be an object.");

const invalidCreateExpectsError = () =>
  new NexusUsageError("Mock Nexus create expects must be 'one' or 'first'.");

const invalidCreateTimeoutError = () =>
  new NexusUsageError("Mock Nexus create timeout must be a number.");

const invalidTokenError = () =>
  new NexusUsageError("Mock Nexus create token must be a Nexus Token.");

const invalidConfigError = () =>
  new NexusUsageError("Mock Nexus configure options must be an object.");

const invalidIdentityUpdatesError = () =>
  new NexusUsageError("Mock Nexus identity updates must be an object.");

const isPlainRuntimeObject = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isToken = <T extends object>(token: unknown): token is Token<T> =>
  token instanceof Token;

const resolveNamedTarget = <U extends EndpointMeta>(
  target: Target<U, string, string>,
  namedDescriptors: ReadonlyMap<string, Partial<U>>,
  namedMatchers: ReadonlyMap<string, (identity: U) => boolean>,
): Error | null => {
  const { descriptor, matcher } = target;

  if (typeof descriptor === "string" && !namedDescriptors.has(descriptor)) {
    return new NexusUsageError(
      `Nexus: Descriptor with name "${descriptor}" not found in mock create target.`,
    );
  }

  if (typeof matcher === "string" && !namedMatchers.has(matcher)) {
    return new NexusUsageError(
      `Nexus: Matcher with name "${matcher}" not found in mock create target.`,
    );
  }

  return null;
};

const resolveTarget = <
  U extends EndpointMeta,
  M extends string,
  D extends string,
>(
  tokenId: string,
  target: Target<U, M, D> | null | undefined,
  tokenDefaultTarget: Target<U, M, D> | undefined,
  connectTo: readonly Target<U, string, string>[] | undefined,
): Error | null => {
  let finalTarget = target;
  if (isTargetEmpty(finalTarget) && tokenDefaultTarget) {
    finalTarget = tokenDefaultTarget;
  }
  if (isTargetEmpty(finalTarget) && connectTo?.length === 1) {
    finalTarget = connectTo[0] as Target<U, M, D>;
  }
  if (!isTargetEmpty(finalTarget)) return null;
  if (connectTo && connectTo.length > 1) {
    return new NexusTargetingError(
      "Mock Nexus cannot resolve an empty target because endpoint.connectTo has multiple entries.",
      "E_TARGET_UNEXPECTED_COUNT",
      { tokenId, count: connectTo.length },
    );
  }
  return new NexusTargetingError(
    "Mock Nexus cannot resolve an empty target without a token default target or endpoint.connectTo fallback.",
    "E_TARGET_NO_MATCH",
    { tokenId },
  );
};

const getCreateTarget = <
  U extends EndpointMeta,
  M extends string,
  D extends string,
>(
  target: Target<U, M, D> | null | undefined,
  tokenDefaultTarget: Target<U, M, D> | undefined,
  connectTo: readonly Target<U, string, string>[] | undefined,
): Target<U, M, D> | undefined => {
  if (!isTargetEmpty(target)) return target ?? undefined;
  if (!isTargetEmpty(tokenDefaultTarget)) return tokenDefaultTarget;
  if (connectTo?.length === 1) return connectTo[0] as Target<U, M, D>;
  return undefined;
};

const createAsyncProxy = <T extends object>(implementation: T): Asyncified<T> =>
  new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") return undefined;
        if (property === "toString") return () => "[object NexusMockProxy]";
        if (property === "valueOf") return () => implementation;
        if (property === "inspect" || property === "nodeType") return undefined;
        if (typeof property === "symbol") {
          return (implementation as Record<PropertyKey, unknown>)[property];
        }

        const value = (implementation as Record<PropertyKey, unknown>)[
          property
        ];
        if (typeof value === "function") {
          return (...args: unknown[]) =>
            Promise.resolve().then(() => value.apply(implementation, args));
        }
        return Promise.resolve(value);
      },
    },
  ) as Asyncified<T>;

export function createMockNexus<
  U extends EndpointMeta = EndpointMeta,
  P extends PlatformMeta = PlatformMeta,
  RegisteredMatchers extends string = never,
  RegisteredDescriptors extends string = never,
>(): MockNexus<U, P, RegisteredMatchers, RegisteredDescriptors> {
  const services = new Map<string, RegisteredService>();
  const failures = new Map<string, Error>();
  const namedMatchers = new Map<string, (identity: U) => boolean>();
  const namedDescriptors = new Map<string, Partial<U>>();
  const createCalls: MockNexusCreateCall<
    U,
    RegisteredMatchers,
    RegisteredDescriptors
  >[] = [];
  const configureCalls: MockNexusConfigureCall<U, P>[] = [];
  const releaseCalls: MockNexusReleaseCall[] = [];
  const updateIdentityCalls: MockNexusUpdateIdentityCall<U>[] = [];
  let connectTo: readonly Target<U, string, string>[] | undefined;
  let localMeta: U | undefined;
  let policy: NexusConfig<U, P>["policy"] | undefined;

  const registerService = <T extends object>(
    token: Token<T>,
    implementation: T,
  ): void => {
    services.set(token.id, {
      token: token as Token<object, any>,
      service: implementation,
    });
  };

  const resolveCreate = <
    T extends object,
    M extends string = RegisteredMatchers,
    D extends string = RegisteredDescriptors,
  >(
    token: Token<T> | unknown,
    options: CreateOptions<U, M, D> | unknown = {},
  ): Result<Asyncified<T>, Error> => {
    if (!isToken<T>(token)) {
      return err(invalidTokenError());
    }
    const typedToken = token as unknown as Token<T, U>;
    if (!isPlainRuntimeObject(options)) {
      return err(invalidCreateOptionsError());
    }
    if (
      "target" in options &&
      options.target !== null &&
      options.target !== undefined &&
      !isPlainRuntimeObject(options.target)
    ) {
      return err(invalidCreateOptionsError());
    }
    if (
      "expects" in options &&
      options.expects !== undefined &&
      options.expects !== "one" &&
      options.expects !== "first"
    ) {
      return err(invalidCreateExpectsError());
    }
    if (
      "timeout" in options &&
      options.timeout !== undefined &&
      typeof options.timeout !== "number"
    ) {
      return err(invalidCreateTimeoutError());
    }

    const typedOptions = options as unknown as CreateOptions<U, M, D>;

    const tokenDefaultTarget = typedToken.defaultTarget;
    const finalTarget = getCreateTarget(
      typedOptions.target,
      tokenDefaultTarget,
      connectTo,
    );

    const targetingError = resolveTarget(
      typedToken.id,
      typedOptions.target,
      tokenDefaultTarget,
      connectTo,
    );
    if (targetingError) return err(targetingError);

    if (finalTarget) {
      const namedTargetError = resolveNamedTarget(
        finalTarget as Target<U, string, string>,
        namedDescriptors,
        namedMatchers,
      );
      if (namedTargetError) return err(namedTargetError);
    }

    createCalls.push({
      tokenId: typedToken.id,
      token: typedToken as unknown as Token<object, any>,
      options: typedOptions as unknown as CreateOptions<
        U,
        RegisteredMatchers,
        RegisteredDescriptors
      >,
    });

    const injectedFailure = failures.get(typedToken.id);
    if (injectedFailure) return err(injectedFailure);

    const registered = services.get(typedToken.id);
    if (!registered) return err(serviceNotFoundError(typedToken.id));

    return ok<Asyncified<T>, Error>(
      createAsyncProxy(registered.service as T),
    );
  };

  const configure = <const T extends NexusConfig<U, P>>(
    config: T,
  ): NexusInstance<
    U,
    P,
    RegisteredMatchers | GetMatchers<T>,
    RegisteredDescriptors | GetDescriptors<T>
  > => {
    configureCalls.push({ config: config as NexusConfig<U, P> });
    config.providers?.forEach((registration) => {
      registerService(registration.token, registration.service);
    });
    Object.entries(config.matchers ?? {}).forEach(([name, matcher]) => {
      namedMatchers.set(name, matcher);
    });
    Object.entries(config.descriptors ?? {}).forEach(([name, descriptor]) => {
      namedDescriptors.set(name, descriptor);
    });
    if (config.endpoint?.connectTo) {
      connectTo = config.endpoint.connectTo as readonly Target<
        U,
        string,
        string
      >[];
    }
    if (config.endpoint?.meta) {
      localMeta = config.endpoint.meta;
    }
    if (config.policy) {
      policy = config.policy;
    }
    void policy;
    void namedDescriptors;
    return nexus as NexusInstance<
      U,
      P,
      RegisteredMatchers | GetMatchers<T>,
      RegisteredDescriptors | GetDescriptors<T>
    >;
  };

  const updateIdentity = async (updates: Partial<U>): Promise<void> => {
    updateIdentityCalls.push({ updates });
    if (localMeta) localMeta = { ...localMeta, ...updates };
  };

  const safeRef = <T extends object>(target: T) => {
    if (typeof target !== "object" || target === null) {
      return err(
        new NexusUsageError("Nexus.ref() can only be used with objects."),
      );
    }
    return ok({ [REF_WRAPPER_SYMBOL]: true, target } as unknown as ReturnType<
      NexusInstance<U, P>["ref"]
    >);
  };

  const matchers = {
    and:
      (...items: MatcherTarget<U, RegisteredMatchers>[]) =>
      (identity: U) =>
        items.every((item) => {
          const matcher =
            typeof item === "string" ? namedMatchers.get(item) : item;
          return Boolean(matcher?.(identity));
        }),
    or:
      (...items: MatcherTarget<U, RegisteredMatchers>[]) =>
      (identity: U) =>
        items.some((item) => {
          const matcher =
            typeof item === "string" ? namedMatchers.get(item) : item;
          return Boolean(matcher?.(identity));
        }),
    not: (item: MatcherTarget<U, RegisteredMatchers>) => (identity: U) => {
      const matcher = typeof item === "string" ? namedMatchers.get(item) : item;
      return !matcher?.(identity);
    },
  } satisfies NexusInstance<
    U,
    P,
    RegisteredMatchers,
    RegisteredDescriptors
  >["matchers"];

  const release = (proxy: object): void => {
    releaseCalls.push({ proxy });
  };

  const unwrapResultOrThrow = <T>(result: Result<T, Error>): T => {
    if (result.isErr()) throw result.error;
    return result.value;
  };

  const safeConfigure = <const T extends NexusConfig<U, P>>(config: T) =>
    isPlainRuntimeObject(config)
      ? ok(configure(config))
      : err(invalidConfigError());

  const publicConfigure = <const T extends NexusConfig<U, P>>(config: T) =>
    unwrapResultOrThrow(safeConfigure(config));

  const create = async <T extends object>(
    token: Token<T>,
    options?: CreateOptions<U, RegisteredMatchers, RegisteredDescriptors>,
  ): Promise<Asyncified<T>> => {
    const result = resolveCreate<T, RegisteredMatchers, RegisteredDescriptors>(
      token,
      options ?? {},
    );
    if (result.isErr()) throw result.error;
    return result.value;
  };

  const safeCreate = <T extends object>(
    token: Token<T>,
    options?: CreateOptions<U, RegisteredMatchers, RegisteredDescriptors>,
  ) => {
    const result = resolveCreate<T, RegisteredMatchers, RegisteredDescriptors>(
      token,
      options ?? {},
    );
    return result.isErr() ? errAsync(result.error) : okAsync(result.value);
  };

  const safeUpdateIdentity = (updates: Partial<U>) =>
    isPlainRuntimeObject(updates)
      ? okAsync(updateIdentity(updates)).andThen(() => okAsync(undefined))
      : errAsync(invalidIdentityUpdatesError());

  const publicUpdateIdentity = async (updates: Partial<U>): Promise<void> => {
    const result = await safeUpdateIdentity(updates);
    if (result.isErr()) throw result.error;
  };

  const ref = <T extends object>(target: T) => {
    const result = safeRef(target);
    if (result.isErr()) throw result.error;
    return result.value;
  };

  const safeRelease = (proxy: object) => {
    release(proxy);
    return ok(undefined);
  };

  const nexus = {
    configure: publicConfigure,
    safeConfigure,
    create,
    safeCreate,
    createMulticast: () => Promise.reject(unsupportedOperationError()),
    safeCreateMulticast: () => errAsync(unsupportedOperationError()),
    updateIdentity: publicUpdateIdentity,
    safeUpdateIdentity,
    ref,
    safeRef,
    release,
    safeRelease,
    matchers,
  } as unknown as NexusInstance<
    U,
    P,
    RegisteredMatchers,
    RegisteredDescriptors
  >;

  return {
    nexus,
    service: registerService,
    failCreate: (token, error) => {
      failures.set(token.id, error);
    },
    clear: (token) => {
      if (token) {
        services.delete(token.id);
        failures.delete(token.id);
        for (let index = createCalls.length - 1; index >= 0; index -= 1) {
          if (createCalls[index]?.tokenId === token.id)
            createCalls.splice(index, 1);
        }
        return;
      }
      services.clear();
      failures.clear();
      namedMatchers.clear();
      namedDescriptors.clear();
      createCalls.length = 0;
      configureCalls.length = 0;
      releaseCalls.length = 0;
      updateIdentityCalls.length = 0;
      connectTo = undefined;
      localMeta = undefined;
      policy = undefined;
    },
    calls: {
      create: (token) =>
        token
          ? createCalls.filter((call) => call.tokenId === token.id)
          : [...createCalls],
      configure: () => [...configureCalls],
      release: () => [...releaseCalls],
      updateIdentity: () => [...updateIdentityCalls],
    },
  };
}
