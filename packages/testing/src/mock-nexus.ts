import {
  Nexus,
  NexusServiceError,
  NexusUsageError,
  Token,
  type AdapterModel,
  type Allified,
  type Asyncified,
  type ConnectionMetaOf,
  type ConnectionTargetOf,
  type ContextMetaOf,
  type CreateMulticastOptions,
  type CreateOptions,
  type NexusConfig,
  type NexusInstance,
  type SelectMulticastOptions,
  type SelectOptions,
  type Streamified,
} from "@nexus-js/core";
import { Result } from "better-result";

const { err, ok } = Result;
const DEFAULT_SELECT_WAIT_TIMEOUT = 30_000;

export interface MockProviderRegistration<M extends AdapterModel> {
  readonly target?: ConnectionTargetOf<M>;
  readonly contextMeta: ContextMetaOf<M>;
  readonly connectionMeta: ConnectionMetaOf<M>;
}

interface RegisteredService<M extends AdapterModel> {
  readonly token: Token<object> | Token<object, M>;
  readonly service: object;
  readonly registration?: MockProviderRegistration<M>;
}

export interface MockNexusCreateCall<M extends AdapterModel = AdapterModel> {
  readonly tokenId: string;
  readonly token: Token<object, any>;
  readonly options: CreateOptions<M>;
}

export interface MockNexusCreateMulticastCall<
  M extends AdapterModel = AdapterModel,
> {
  readonly tokenId: string;
  readonly token: Token<object, any>;
  readonly options: CreateMulticastOptions<M>;
}

export interface MockNexusSelectCall<M extends AdapterModel = AdapterModel> {
  readonly tokenId: string;
  readonly token: Token<object, any>;
  readonly options: SelectOptions<M>;
}

export interface MockNexusSelectMulticastCall<
  M extends AdapterModel = AdapterModel,
> {
  readonly tokenId: string;
  readonly token: Token<object, any>;
  readonly options: SelectMulticastOptions<M>;
}

export interface MockNexusConfigureCall<M extends AdapterModel = AdapterModel> {
  readonly config: NexusConfig<M>;
}

export interface MockNexusReleaseCall {
  readonly proxy: object;
}

export interface MockNexusUpdateIdentityCall<M extends AdapterModel> {
  readonly updates: Partial<ContextMetaOf<M>>;
}

export interface MockNexus<M extends AdapterModel = AdapterModel> {
  readonly nexus: NexusInstance<M>;
  service<T extends object>(
    token: Token<T> | Token<T, M>,
    implementation: T,
    registration?: MockProviderRegistration<M>,
  ): void;
  failCreate<T extends object>(
    token: Token<T> | Token<T, M>,
    error: Error,
  ): void;
  clear<T extends object>(token?: Token<T> | Token<T, M>): void;
  readonly calls: {
    create<T extends object>(
      token?: Token<T> | Token<T, M>,
    ): readonly MockNexusCreateCall<M>[];
    createMulticast<T extends object>(
      token?: Token<T> | Token<T, M>,
    ): readonly MockNexusCreateMulticastCall<M>[];
    select<T extends object>(
      token?: Token<T> | Token<T, M>,
    ): readonly MockNexusSelectCall<M>[];
    selectMulticast<T extends object>(
      token?: Token<T> | Token<T, M>,
    ): readonly MockNexusSelectMulticastCall<M>[];
    configure(): readonly MockNexusConfigureCall<M>[];
    release(): readonly MockNexusReleaseCall[];
    updateIdentity(): readonly MockNexusUpdateIdentityCall<M>[];
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

const isToken = <T extends object>(token: unknown): token is Token<T, any> =>
  token instanceof Token;

const hasOnlyKeys = (value: object, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

const isTimeout = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isAbortSignal = (value: unknown): value is AbortSignal =>
  value instanceof globalThis.AbortSignal;

const usageError = (message: string) =>
  new NexusUsageError(message, "E_USAGE_INVALID");

const serviceError = (
  message: string,
  code:
    | "E_SERVICE_ACQUISITION_TIMEOUT"
    | "E_SERVICE_NO_MATCH"
    | "E_SERVICE_AMBIGUOUS"
    | "E_SERVICE_WAIT_TIMEOUT"
    | "E_ABORTED",
) => new NexusServiceError(message, code);

const targetMatches = <M extends AdapterModel>(
  provider: RegisteredService<M>,
  target: ConnectionTargetOf<M>,
): boolean => {
  const providerTarget = provider.registration?.target;
  if (!providerTarget) return true;
  return Object.entries(target).every(
    ([key, value]) =>
      (providerTarget as Record<string, unknown>)[key] === value,
  );
};

const matches = <M extends AdapterModel>(
  provider: RegisteredService<M>,
  target: ConnectionTargetOf<M> | undefined,
  where:
    | ((
        contextMeta: ContextMetaOf<M>,
        connectionMeta: ConnectionMetaOf<M>,
      ) => boolean)
    | undefined,
) =>
  (!target || targetMatches(provider, target)) &&
  (!where ||
    (!!provider.registration &&
      where(
        provider.registration.contextMeta,
        provider.registration.connectionMeta,
      )));

const createAsyncProxy = <T extends object>(implementation: T): Asyncified<T> =>
  new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") return undefined;
        if (property === "toString") return () => "[object NexusMockProxy]";
        if (property === "valueOf") return () => implementation;
        if (property === "inspect" || property === "nodeType") return undefined;
        if (typeof property === "symbol")
          return (implementation as Record<PropertyKey, unknown>)[property];
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

const createMulticastProxy = <T extends object>(
  providers: readonly RegisteredService<any>[],
  expects: "all" | "stream",
): Allified<T> | Streamified<T> =>
  new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") return undefined;
        if (typeof property === "symbol") return undefined;
        const settle = async (
          provider: RegisteredService<any>,
          args: unknown[],
        ) => {
          try {
            const value = (provider.service as Record<PropertyKey, unknown>)[
              property
            ];
            const result =
              typeof value === "function"
                ? await value.apply(provider.service, args)
                : await value;
            return { status: "fulfilled" as const, value: result };
          } catch (reason) {
            const error =
              reason instanceof Error ? reason : new Error(String(reason));
            return {
              status: "rejected" as const,
              reason: { message: error.message, name: error.name },
            };
          }
        };
        const invoke = (...args: unknown[]) => {
          if (expects === "all")
            return Promise.all(
              providers.map((provider) => settle(provider, args)),
            );
          return Promise.resolve(
            (async function* () {
              for (const provider of providers)
                yield await settle(provider, args);
            })(),
          );
        };
        const value = providers[0]
          ? (providers[0].service as Record<PropertyKey, unknown>)[property]
          : undefined;
        return typeof value === "function" ? invoke : invoke();
      },
    },
  ) as Allified<T> | Streamified<T>;

export function createMockNexus<
  M extends AdapterModel = AdapterModel,
>(): MockNexus<M> {
  const refFactory = new Nexus<M>();
  const providers = new Map<string, RegisteredService<M>[]>();
  const failures = new Map<string, Error>();
  const listeners = new Set<() => void>();
  const createCalls: MockNexusCreateCall<M>[] = [];
  const createMulticastCalls: MockNexusCreateMulticastCall<M>[] = [];
  const selectCalls: MockNexusSelectCall<M>[] = [];
  const selectMulticastCalls: MockNexusSelectMulticastCall<M>[] = [];
  const configureCalls: MockNexusConfigureCall<M>[] = [];
  const releaseCalls: MockNexusReleaseCall[] = [];
  const updateIdentityCalls: MockNexusUpdateIdentityCall<M>[] = [];
  let defaultTarget: ConnectionTargetOf<M> | undefined;
  let localMeta: ContextMetaOf<M> | undefined;

  const registrationsFor = (tokenId: string) => providers.get(tokenId) ?? [];

  const registerService = <T extends object>(
    token: Token<T> | Token<T, M>,
    service: T,
    registration?: MockProviderRegistration<M>,
  ) => {
    const registered: RegisteredService<M> = {
      token: token as Token<object> | Token<object, M>,
      service,
      registration,
    };
    const entries = registrationsFor(token.id);
    providers.set(token.id, [...entries, registered]);
    for (const listener of listeners) listener();
  };

  const resolveCreateTarget = <T extends object>(
    token: Token<T, M>,
    target: ConnectionTargetOf<M> | undefined,
  ): Result<ConnectionTargetOf<M>, Error> => {
    const resolved = target ?? token.defaultTarget ?? defaultTarget;
    return resolved
      ? ok(resolved)
      : err(
          new NexusServiceError(
            `Mock Nexus cannot acquire '${token.id}' without a target.`,
            "E_TARGET_REQUIRED",
          ),
        );
  };

  const validateCreateOptions = (
    value: unknown,
  ): Result<CreateOptions<M>, Error> => {
    if (
      !isPlainObject(value) ||
      !hasOnlyKeys(value, [
        "target",
        "where",
        "timeout",
        "signal",
        "callTimeout",
      ])
    )
      return err(usageError("Mock Nexus create options are invalid."));
    if (
      "target" in value &&
      value.target !== undefined &&
      !isPlainObject(value.target)
    )
      return err(usageError("Mock Nexus create target must be an object."));
    if (
      "where" in value &&
      value.where !== undefined &&
      typeof value.where !== "function"
    )
      return err(usageError("Mock Nexus create where must be a function."));
    if (
      (value.timeout !== undefined && !isTimeout(value.timeout)) ||
      (value.callTimeout !== undefined && !isTimeout(value.callTimeout))
    )
      return err(
        usageError(
          "Mock Nexus create timeouts must be non-negative finite numbers.",
        ),
      );
    if (
      "signal" in value &&
      value.signal !== undefined &&
      !isAbortSignal(value.signal)
    )
      return err(
        usageError("Mock Nexus create signal must be an AbortSignal."),
      );
    return ok(value as CreateOptions<M>);
  };

  const validateSelectOptions = (
    value: unknown,
  ): Result<SelectOptions<M>, Error> => {
    if (
      !isPlainObject(value) ||
      !hasOnlyKeys(value, ["where", "wait", "callTimeout"])
    )
      return err(usageError("Mock Nexus select options are invalid."));
    if (
      "where" in value &&
      value.where !== undefined &&
      typeof value.where !== "function"
    )
      return err(usageError("Mock Nexus select where must be a function."));
    if (value.callTimeout !== undefined && !isTimeout(value.callTimeout))
      return err(
        usageError(
          "Mock Nexus select callTimeout must be a non-negative finite number.",
        ),
      );
    if ("wait" in value && value.wait !== undefined) {
      if (
        !isPlainObject(value.wait) ||
        !hasOnlyKeys(value.wait, ["timeout", "signal"])
      )
        return err(usageError("Mock Nexus select wait is invalid."));
      if (value.wait.timeout !== undefined && !isTimeout(value.wait.timeout))
        return err(
          usageError(
            "Mock Nexus select wait timeout must be a non-negative finite number.",
          ),
        );
      if (
        "signal" in value.wait &&
        value.wait.signal !== undefined &&
        !isAbortSignal(value.wait.signal)
      )
        return err(
          usageError("Mock Nexus select wait signal must be an AbortSignal."),
        );
    }
    return ok(value as SelectOptions<M>);
  };

  const validateMulticastOptions = (
    value: unknown,
  ): Result<CreateMulticastOptions<M>, Error> => {
    if (
      !isPlainObject(value) ||
      !hasOnlyKeys(value, [
        "targets",
        "where",
        "expects",
        "timeout",
        "signal",
        "callTimeout",
      ]) ||
      !Array.isArray(value.targets) ||
      value.targets.length === 0 ||
      value.targets.some((target) => !isPlainObject(target))
    )
      return err(
        usageError(
          "Mock Nexus multicast options require non-empty object targets.",
        ),
      );
    if (value.where !== undefined && typeof value.where !== "function")
      return err(usageError("Mock Nexus multicast where must be a function."));
    if (
      value.expects !== undefined &&
      value.expects !== "all" &&
      value.expects !== "stream"
    )
      return err(
        usageError("Mock Nexus multicast expects must be 'all' or 'stream'."),
      );
    if (
      (value.timeout !== undefined && !isTimeout(value.timeout)) ||
      (value.callTimeout !== undefined && !isTimeout(value.callTimeout))
    )
      return err(
        usageError(
          "Mock Nexus multicast timeouts must be non-negative finite numbers.",
        ),
      );
    if (value.signal !== undefined && !isAbortSignal(value.signal))
      return err(
        usageError("Mock Nexus multicast signal must be an AbortSignal."),
      );
    return ok(value as unknown as CreateMulticastOptions<M>);
  };

  const validateSelectMulticastOptions = (
    value: unknown,
  ): Result<SelectMulticastOptions<M>, Error> => {
    if (
      !isPlainObject(value) ||
      !hasOnlyKeys(value, ["where", "expects", "callTimeout"])
    )
      return err(usageError("Mock Nexus selectMulticast options are invalid."));
    if (value.where !== undefined && typeof value.where !== "function")
      return err(
        usageError("Mock Nexus selectMulticast where must be a function."),
      );
    if (
      value.expects !== undefined &&
      value.expects !== "all" &&
      value.expects !== "stream"
    )
      return err(
        usageError(
          "Mock Nexus selectMulticast expects must be 'all' or 'stream'.",
        ),
      );
    if (value.callTimeout !== undefined && !isTimeout(value.callTimeout))
      return err(
        usageError(
          "Mock Nexus selectMulticast callTimeout must be a non-negative finite number.",
        ),
      );
    return ok(value as SelectMulticastOptions<M>);
  };

  const waitFor = <T extends object>(
    token: Token<T, M>,
    target: ConnectionTargetOf<M> | undefined,
    where: SelectOptions<M>["where"],
    timeout: number | undefined,
    signal: AbortSignal | undefined,
    timeoutCode: "E_SERVICE_ACQUISITION_TIMEOUT" | "E_SERVICE_WAIT_TIMEOUT",
  ) =>
    new Promise<Result<RegisteredService<M>[], Error>>((resolve) => {
      const scan = () =>
        registrationsFor(token.id).filter((item) =>
          matches(item, target, where),
        );
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
      let wakeScheduled = false;
      const finish = (result: Result<RegisteredService<M>[], Error>) => {
        listeners.delete(onRegister);
        if (timer) globalThis.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onRegister = () => {
        if (wakeScheduled) return;
        wakeScheduled = true;
        globalThis.queueMicrotask(() => {
          wakeScheduled = false;
          const found = scan();
          if (found.length > 0) finish(ok(found));
        });
      };
      const onAbort = () =>
        finish(
          err(serviceError("Service acquisition was aborted.", "E_ABORTED")),
        );
      listeners.add(onRegister);
      const found = scan();
      if (found.length > 0) return finish(ok(found));
      if (signal?.aborted)
        return finish(
          err(serviceError("Service acquisition was aborted.", "E_ABORTED")),
        );
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = globalThis.setTimeout(
        () =>
          finish(
            err(
              serviceError(
                `Timed out waiting for a mock provider of '${token.id}'.`,
                timeoutCode,
              ),
            ),
          ),
        timeout ?? DEFAULT_SELECT_WAIT_TIMEOUT,
      );
    });

  const resolveCreate = async <T extends object>(
    token: unknown,
    input: unknown,
  ): Promise<Result<Asyncified<T>, Error>> => {
    if (!isToken<T>(token))
      return err(usageError("Mock Nexus create requires a Token."));
    const options = validateCreateOptions(input);
    if (options.isErr()) return options;
    const target = resolveCreateTarget(
      token as Token<T, M>,
      options.value.target,
    );
    if (target.isErr()) return target;
    if (options.value.signal?.aborted)
      return err(serviceError("Service acquisition was aborted.", "E_ABORTED"));
    createCalls.push({ tokenId: token.id, token, options: options.value });
    const failure = failures.get(token.id);
    if (failure) return err(failure);
    let provider = registrationsFor(token.id).find((item) =>
      matches(item, target.value, options.value.where),
    );
    if (!provider) {
      const waited = await waitFor(
        token as Token<T, M>,
        target.value,
        options.value.where,
        options.value.timeout,
        options.value.signal,
        "E_SERVICE_ACQUISITION_TIMEOUT",
      );
      if (waited.isErr()) return waited;
      provider = waited.value[0];
    }
    if (options.value.signal?.aborted)
      return err(serviceError("Service acquisition was aborted.", "E_ABORTED"));
    return provider
      ? ok(createAsyncProxy(provider.service as T))
      : err(
          serviceError(
            `No provider for '${token.id}' is available.`,
            "E_SERVICE_NO_MATCH",
          ),
        );
  };

  const resolveSelect = async <T extends object>(
    token: unknown,
    input: unknown,
  ): Promise<Result<Asyncified<T>, Error>> => {
    if (!isToken<T>(token))
      return err(usageError("Mock Nexus select requires a Token."));
    const options = validateSelectOptions(input);
    if (options.isErr()) return options;
    selectCalls.push({ tokenId: token.id, token, options: options.value });
    let candidates = registrationsFor(token.id).filter((item) =>
      matches(item, undefined, options.value.where),
    );
    if (candidates.length === 0 && options.value.wait) {
      const waited = await waitFor(
        token as Token<T, M>,
        undefined,
        options.value.where,
        options.value.wait.timeout,
        options.value.wait.signal,
        "E_SERVICE_WAIT_TIMEOUT",
      );
      if (waited.isErr()) return waited;
      candidates = waited.value;
    }
    if (candidates.length === 0)
      return err(
        serviceError(
          `No provider for '${token.id}' is available.`,
          "E_SERVICE_NO_MATCH",
        ),
      );
    if (candidates.length > 1)
      return err(
        serviceError(
          `Multiple providers for '${token.id}' are available.`,
          "E_SERVICE_AMBIGUOUS",
        ),
      );
    return ok(createAsyncProxy(candidates[0].service as T));
  };

  const resolveMulticast = async <T extends object>(
    token: unknown,
    input: unknown,
  ): Promise<Result<Allified<T> | Streamified<T>, Error>> => {
    if (!isToken<T>(token))
      return err(usageError("Mock Nexus createMulticast requires a Token."));
    const options = validateMulticastOptions(input);
    if (options.isErr()) return options;
    if (options.value.signal?.aborted)
      return err(serviceError("Service acquisition was aborted.", "E_ABORTED"));
    createMulticastCalls.push({
      tokenId: token.id,
      token,
      options: options.value,
    });
    const failure = failures.get(token.id);
    if (failure) return err(failure);
    const chosen: RegisteredService<M>[] = [];
    const deadline =
      Date.now() + (options.value.timeout ?? DEFAULT_SELECT_WAIT_TIMEOUT);
    for (const target of options.value.targets) {
      let provider = registrationsFor(token.id).find((item) =>
        matches(item, target, options.value.where),
      );
      if (!provider) {
        const waited = await waitFor(
          token as Token<T, M>,
          target,
          options.value.where,
          Math.max(0, deadline - Date.now()),
          options.value.signal,
          "E_SERVICE_ACQUISITION_TIMEOUT",
        );
        if (waited.isErr()) return waited;
        provider = waited.value[0];
      }
      if (options.value.signal?.aborted)
        return err(
          serviceError("Service acquisition was aborted.", "E_ABORTED"),
        );
      if (!chosen.includes(provider)) chosen.push(provider);
    }
    return ok(createMulticastProxy<T>(chosen, options.value.expects ?? "all"));
  };

  const resolveSelectMulticast = <T extends object>(
    token: unknown,
    input: unknown,
  ): Result<Allified<T> | Streamified<T>, Error> => {
    if (!isToken<T>(token))
      return err(usageError("Mock Nexus selectMulticast requires a Token."));
    const options = validateSelectMulticastOptions(input);
    if (options.isErr()) return options;
    selectMulticastCalls.push({
      tokenId: token.id,
      token,
      options: options.value,
    });
    const snapshot = registrationsFor(token.id).filter((item) =>
      matches(item, undefined, options.value.where),
    );
    return ok(
      createMulticastProxy<T>(snapshot, options.value.expects ?? "all"),
    );
  };

  const unwrap = <T>(result: Result<T, Error>): T => {
    if (result.isErr()) throw result.error;
    return result.value;
  };

  const nexus: NexusInstance<M> = {
    configure: (config) => unwrap(nexus.safeConfigure(config)),
    safeConfigure: (config) => {
      if (!isPlainObject(config))
        return err(usageError("Mock Nexus configure options are invalid."));
      configureCalls.push({ config });
      for (const provider of config.providers ?? [])
        registerService(provider.token, provider.service);
      if (config.endpoint?.defaultTarget)
        defaultTarget = config.endpoint.defaultTarget;
      if (config.endpoint?.meta) localMeta = config.endpoint.meta;
      return ok(nexus);
    },
    create: async (token, options) =>
      unwrap(await resolveCreate(token, options ?? {})),
    safeCreate: async (token, options) => resolveCreate(token, options ?? {}),
    createMulticast: (async <T extends object>(
      token: Token<T> | Token<T, M>,
      options: CreateMulticastOptions<M>,
    ) =>
      unwrap(
        await resolveMulticast<T>(token, options),
      )) as NexusInstance<M>["createMulticast"],
    safeCreateMulticast: (async <T extends object>(
      token: Token<T> | Token<T, M>,
      options: CreateMulticastOptions<M>,
    ) =>
      await resolveMulticast<T>(
        token,
        options,
      )) as NexusInstance<M>["safeCreateMulticast"],
    select: async (token, options) =>
      unwrap(await resolveSelect(token, options ?? {})),
    safeSelect: async (token, options) => resolveSelect(token, options ?? {}),
    selectMulticast: (async <T extends object>(
      token: Token<T> | Token<T, M>,
      options?: SelectMulticastOptions<M>,
    ) =>
      unwrap(
        resolveSelectMulticast<T>(token, options ?? {}),
      )) as NexusInstance<M>["selectMulticast"],
    safeSelectMulticast: (async <T extends object>(
      token: Token<T> | Token<T, M>,
      options?: SelectMulticastOptions<M>,
    ) =>
      resolveSelectMulticast<T>(
        token,
        options ?? {},
      )) as NexusInstance<M>["safeSelectMulticast"],
    provide: ((input: unknown, service?: object) =>
      unwrap(
        nexus.safeProvide(input as never, service as never),
      )) as NexusInstance<M>["provide"],
    safeProvide: ((input: unknown, service?: object) => {
      const registrations =
        isToken(input) && service
          ? [{ token: input, service }]
          : Array.isArray(input)
            ? input
            : isPlainObject(input) && isToken(input.token) && input.service
              ? [input]
              : undefined;
      if (!registrations)
        return err(usageError("Mock Nexus provide input is invalid."));
      for (const registration of registrations)
        registerService(registration.token, registration.service);
      return ok(nexus);
    }) as NexusInstance<M>["safeProvide"],
    ready: async () => undefined,
    safeReady: async () => ok(undefined),
    updateIdentity: async (updates) => {
      const result = await nexus.safeUpdateIdentity(updates);
      if (result.isErr()) throw result.error;
    },
    safeUpdateIdentity: (updates) => {
      if (!isPlainObject(updates))
        return Promise.resolve(
          err(usageError("Mock Nexus identity updates are invalid.")),
        );
      updateIdentityCalls.push({ updates });
      if (localMeta) localMeta = { ...localMeta, ...updates };
      return Promise.resolve(ok(undefined));
    },
    ref: (target) => refFactory.ref(target),
    safeRef: (target) => refFactory.safeRef(target),
    release: (proxy) => releaseCalls.push({ proxy }),
    safeRelease: (proxy) => {
      releaseCalls.push({ proxy });
      return ok(undefined);
    },
    Expose: () => () => undefined,
    Endpoint: () => () => undefined,
  };

  return {
    nexus,
    service: registerService,
    failCreate: (token, error) => failures.set(token.id, error),
    clear: (token) => {
      if (token) {
        providers.delete(token.id);
        failures.delete(token.id);
        for (const calls of [
          createCalls,
          createMulticastCalls,
          selectCalls,
          selectMulticastCalls,
        ]) {
          for (let index = calls.length - 1; index >= 0; index -= 1) {
            if (calls[index]?.tokenId === token.id) calls.splice(index, 1);
          }
        }
        return;
      }
      providers.clear();
      failures.clear();
      createCalls.length = 0;
      createMulticastCalls.length = 0;
      selectCalls.length = 0;
      selectMulticastCalls.length = 0;
      configureCalls.length = 0;
      releaseCalls.length = 0;
      updateIdentityCalls.length = 0;
      defaultTarget = undefined;
      localMeta = undefined;
    },
    calls: {
      create: (token) =>
        token
          ? createCalls.filter((call) => call.tokenId === token.id)
          : [...createCalls],
      createMulticast: (token) =>
        token
          ? createMulticastCalls.filter((call) => call.tokenId === token.id)
          : [...createMulticastCalls],
      select: (token) =>
        token
          ? selectCalls.filter((call) => call.tokenId === token.id)
          : [...selectCalls],
      selectMulticast: (token) =>
        token
          ? selectMulticastCalls.filter((call) => call.tokenId === token.id)
          : [...selectMulticastCalls],
      configure: () => [...configureCalls],
      release: () => [...releaseCalls],
      updateIdentity: () => [...updateIdentityCalls],
    },
  };
}
