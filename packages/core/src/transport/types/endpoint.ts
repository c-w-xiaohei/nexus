import type {
  AdapterModel,
  ConnectionTargetOf,
  ConnectionMetaOf,
  ContextMetaOf,
} from "@/types/adapter-model";
import type { IPort } from "./port";

/** The adapter seam: connect one target and match only ready connections. */
export interface IEndpoint<M extends AdapterModel> {
  listen?(
    accept: (port: IPort, connectionMeta: ConnectionMetaOf<M>) => void,
  ): void | Promise<unknown>;
  connect?(target: ConnectionTargetOf<M>): Promise<{
    port: IPort;
    connectionMeta: ConnectionMetaOf<M>;
  }>;
  /** Returns the key used only to coalesce pending creation attempts. */
  targetKey?(target: ConnectionTargetOf<M>): string;
  matchesTarget?(
    target: ConnectionTargetOf<M>,
    contextMeta: ContextMetaOf<M>,
    connectionMeta: ConnectionMetaOf<M>,
  ): boolean;
  close?(): void | Promise<void>;
  capabilities?: {
    binaryPackets?: boolean;
    transferables?: boolean;
    supportsTransferables?: boolean;
  };
}
