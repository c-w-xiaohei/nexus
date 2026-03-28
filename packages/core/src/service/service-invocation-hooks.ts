export const SERVICE_INVOKE_START = Symbol("nexus.service.invoke.start");
export const SERVICE_INVOKE_END = Symbol("nexus.service.invoke.end");
export const SERVICE_ON_DISCONNECT = Symbol("nexus.service.on.disconnect");

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
  typeof (value as Record<symbol, unknown>)[symbol] === "function";

export const isServiceWithHooks = (
  value: unknown,
): value is ServiceInvocationHooks =>
  hasHook(value, SERVICE_INVOKE_START) ||
  hasHook(value, SERVICE_INVOKE_END) ||
  hasHook(value, SERVICE_ON_DISCONNECT);
