export const SERVICE_INVOKE_START = Symbol.for("nexus.service.invoke.start");
export const SERVICE_INVOKE_END = Symbol.for("nexus.service.invoke.end");
export const SERVICE_ON_DISCONNECT = Symbol.for("nexus.service.on.disconnect");

export interface ServiceInvocationContext {
  readonly sourceConnectionId: string;
  readonly sourceIdentity: unknown;
  readonly localIdentity: unknown;
  readonly platform: unknown;
}

export interface ServiceInvocationHooks {
  [SERVICE_INVOKE_START]?(
    invocationContext: ServiceInvocationContext,
  ): ServiceInvocationContext;
  [SERVICE_INVOKE_END]?(invocationContext?: ServiceInvocationContext): void;
  [SERVICE_ON_DISCONNECT]?(connectionId: string): void;
}

/** Find a lifecycle hook directly or across equivalent independently loaded symbols. */
export const getServiceInvocationHook = <
  K extends keyof ServiceInvocationHooks,
>(
  value: unknown,
  symbol: K,
): ServiceInvocationHooks[K] => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const directHook = (value as Record<symbol, unknown>)[symbol];
  if (typeof directHook === "function") {
    return directHook as ServiceInvocationHooks[K];
  }

  // Description matching supports hooks from independently loaded State bundles.
  for (const candidate of Object.getOwnPropertySymbols(value)) {
    if (candidate === symbol || candidate.description !== symbol.description) {
      continue;
    }

    const hook = (value as Record<symbol, unknown>)[candidate];
    if (typeof hook === "function") {
      return hook as ServiceInvocationHooks[K];
    }
  }

  return undefined;
};

/** Detect whether a value exposes any recognized invocation lifecycle hook. */
export const isServiceWithHooks = (
  value: unknown,
): value is ServiceInvocationHooks =>
  getServiceInvocationHook(value, SERVICE_INVOKE_START) !== undefined ||
  getServiceInvocationHook(value, SERVICE_INVOKE_END) !== undefined ||
  getServiceInvocationHook(value, SERVICE_ON_DISCONNECT) !== undefined;
