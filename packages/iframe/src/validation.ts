import { IframeAdapterError } from "./errors";

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
  return expected === "*" && allowAnyOrigin === true
    ? true
    : actual === expected;
}
