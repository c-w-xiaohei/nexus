export const SERVICE_INVOKE_START = Symbol.for("nexus.service.invoke.start");
export const SERVICE_INVOKE_END = Symbol.for("nexus.service.invoke.end");
export const SERVICE_ON_DISCONNECT = Symbol.for("nexus.service.on.disconnect");

const SERVICE_INVOKE_START_KEY = "nexus.service.invoke.start";
const SERVICE_INVOKE_END_KEY = "nexus.service.invoke.end";
const SERVICE_ON_DISCONNECT_KEY = "nexus.service.on.disconnect";

export interface ServiceInvocationContext {
  readonly sourceConnectionId: string;
}

export interface ServiceInvocationHooks {
  [SERVICE_INVOKE_START]?(sourceConnectionId: string): ServiceInvocationContext;
  [SERVICE_INVOKE_END]?(invocationContext?: ServiceInvocationContext): void;
  [SERVICE_ON_DISCONNECT]?(connectionId: string): void;
}

const hasHook = <T extends symbol>(
  value: unknown,
  symbol: T,
): value is { [K in T]?: (...args: any[]) => unknown } =>
  typeof value === "object" &&
  value !== null &&
  typeof getHook(value, symbol) === "function";

export const getServiceInvocationHook = <T extends symbol>(
  value: unknown,
  symbol: T,
): ((...args: any[]) => unknown) | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return getHook(value, symbol);
};

const getHook = <T extends symbol>(
  value: object,
  symbol: T,
): ((...args: any[]) => unknown) | undefined => {
  const directHook = (value as Record<symbol, unknown>)[symbol];
  if (typeof directHook === "function") {
    return directHook as (...args: any[]) => unknown;
  }

  const expectedKey = hookKey(symbol);
  if (!expectedKey) {
    return undefined;
  }

  for (const candidate of Object.getOwnPropertySymbols(value)) {
    if (candidate === symbol || hookKey(candidate) !== expectedKey) {
      continue;
    }

    const hook = (value as Record<symbol, unknown>)[candidate];
    if (typeof hook === "function") {
      return hook as (...args: any[]) => unknown;
    }
  }

  return undefined;
};

const hookKey = (symbol: symbol): string | undefined => {
  const key = Symbol.keyFor(symbol) ?? symbol.description;
  switch (key) {
    case SERVICE_INVOKE_START_KEY:
    case SERVICE_INVOKE_END_KEY:
    case SERVICE_ON_DISCONNECT_KEY:
      return key;
    default:
      return undefined;
  }
};

export const isServiceWithHooks = (
  value: unknown,
): value is ServiceInvocationHooks =>
  hasHook(value, SERVICE_INVOKE_START) ||
  hasHook(value, SERVICE_INVOKE_END) ||
  hasHook(value, SERVICE_ON_DISCONNECT);
