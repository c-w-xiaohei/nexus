import type { IframeConnectionMeta } from "./types.js";

export function isTrustedConnectionMeta(meta: IframeConnectionMeta): boolean {
  return (
    meta.facts.sourceMatched &&
    meta.facts.originMatched &&
    meta.facts.nonceMatched &&
    meta.facts.trusted
  );
}

export function createConnectionMeta(
  meta: IframeConnectionMeta,
): IframeConnectionMeta {
  return Object.freeze({
    ...meta,
    facts: Object.freeze({ ...meta.facts }),
  });
}
