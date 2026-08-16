import type { ConnectionTarget, ContextMeta } from "./identity";

/** Associates an adapter's endpoint, connection, and targeting types. */
export interface AdapterModel {
  contextMeta: object;
  connectionMeta: object;
  connectionTarget: ConnectionTarget;
}

/** Model used by core-only custom endpoints and tests. */
export interface DefaultAdapterModel extends AdapterModel {
  contextMeta: ContextMeta;
  connectionMeta: object;
  connectionTarget: object;
}

export type ContextMetaOf<M extends AdapterModel> = M["contextMeta"];
export type ConnectionMetaOf<M extends AdapterModel> = M["connectionMeta"];
export type ConnectionTargetOf<M extends AdapterModel> = M["connectionTarget"];
export type ConnectionWhere<M extends AdapterModel> = (
  contextMeta: ContextMetaOf<M>,
  connectionMeta: ConnectionMetaOf<M>,
) => boolean;
