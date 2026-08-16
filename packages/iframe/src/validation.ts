import { IframeAdapterError } from "./errors.js";

export function validateAppId(appId: string): void {
  if (!appId)
    throw new IframeAdapterError(
      "Iframe appId must not be empty",
      "E_IFRAME_CONFIG_INVALID",
    );
}

export function validateOrigin(origin: string, allowAnyOrigin?: boolean): void {
  if (!origin)
    throw new IframeAdapterError(
      "Iframe target origin is required",
      "E_IFRAME_CONFIG_INVALID",
    );
  if (origin === "*" && allowAnyOrigin !== true)
    throw new IframeAdapterError(
      "Iframe '*' origin requires allowAnyOrigin:true",
      "E_IFRAME_CONFIG_INVALID",
    );
}

export function originMatches(
  actual: string,
  expected: string,
  allowAnyOrigin?: boolean,
): boolean {
  if (expected === "*") {
    return allowAnyOrigin === true && actual !== "*";
  }
  return actual === expected;
}

/** Matches a connection target against configured origin policy, not an event. */
export function targetOriginMatches(
  target: string,
  configured: string,
  allowAnyOrigin?: boolean,
): boolean {
  if (target === "*") {
    return configured === "*" && allowAnyOrigin === true;
  }
  if (configured === "*") {
    return allowAnyOrigin === true;
  }
  return target === configured;
}
