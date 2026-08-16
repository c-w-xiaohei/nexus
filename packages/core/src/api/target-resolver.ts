import type { AdapterModel, ConnectionTargetOf } from "@/types/adapter-model";
import { NexusServiceError } from "@/errors";
import { Result } from "better-result";
const { err, ok } = Result;

export namespace TargetResolver {
  export const resolveUnicastTarget = <M extends AdapterModel>(
    optionsTarget: ConnectionTargetOf<M> | undefined,
    tokenDefaultTarget: ConnectionTargetOf<M> | undefined,
    endpointDefaultTarget: ConnectionTargetOf<M> | undefined,
    tokenId: string,
  ): Result<ConnectionTargetOf<M>, NexusServiceError> => {
    let finalTarget = optionsTarget;

    if (isTargetEmpty(finalTarget) && tokenDefaultTarget) {
      finalTarget = tokenDefaultTarget;
    }

    if (isTargetEmpty(finalTarget)) {
      finalTarget = endpointDefaultTarget;
    }

    if (isTargetEmpty(finalTarget)) {
      return err(
        new NexusServiceError(
          `Nexus: No target specified for acquiring "${tokenId}". Provide target, Token.defaultTarget, or endpoint.defaultTarget.`,
          "E_TARGET_REQUIRED",
        ),
      );
    }

    return ok(finalTarget);
  };
}

function isTargetEmpty(target: object | undefined): target is undefined {
  return typeof target === "undefined";
}
