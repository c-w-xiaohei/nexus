import type { UserMetadata } from "@/types/identity";
import { NexusConfigurationError, NexusTargetingError } from "@/errors";
import type {
  TargetCriteria,
  TargetDescriptor,
  TargetMatcher,
} from "./types/config";
import { err, ok, type Result } from "neverthrow";

type ResolvedNamedTarget<U extends UserMetadata> = {
  descriptor?: Partial<U>;
  matcher?: (identity: U) => boolean;
  groupName?: string;
};

export namespace TargetResolver {
  export const resolveNamedTarget = <U extends UserMetadata>(
    target: {
      descriptor?: TargetDescriptor<U, string>;
      matcher?: TargetMatcher<U, string>;
      groupName?: string;
    },
    namedDescriptors: ReadonlyMap<string, Partial<U>>,
    namedMatchers: ReadonlyMap<string, (identity: U) => boolean>,
    context?: string,
  ): Result<ResolvedNamedTarget<U>, NexusConfigurationError> => {
    const { descriptor: descriptorOrName, matcher: matcherOrName } = target;

    const descriptor =
      typeof descriptorOrName === "string"
        ? namedDescriptors.get(descriptorOrName)
        : descriptorOrName;

    const matcher =
      typeof matcherOrName === "string"
        ? namedMatchers.get(matcherOrName)
        : matcherOrName;

    const suffix = context ? ` ${context}` : "";

    if (
      descriptorOrName &&
      typeof descriptorOrName === "string" &&
      !descriptor
    ) {
      return err(
        new NexusConfigurationError(
          `Nexus: Descriptor with name "${descriptorOrName}" not found${suffix}.`,
        ),
      );
    }

    if (matcherOrName && typeof matcherOrName === "string" && !matcher) {
      return err(
        new NexusConfigurationError(
          `Nexus: Matcher with name "${matcherOrName}" not found${suffix}.`,
        ),
      );
    }

    return ok({
      descriptor,
      matcher,
      groupName: target.groupName,
    });
  };

  export const resolveUnicastTarget = <U extends UserMetadata>(
    optionsTarget: TargetCriteria<U, string, string>,
    tokenDefaultTarget: TargetCriteria<U, string, string> | undefined,
    connectTo: readonly TargetCriteria<U, string, string>[] | undefined,
    tokenId: string,
  ): Result<TargetCriteria<U, string, string>, NexusTargetingError> => {
    let finalTarget: TargetCriteria<U, string, string> = optionsTarget;

    if (isTargetEmpty(finalTarget) && tokenDefaultTarget) {
      finalTarget = tokenDefaultTarget;
    }

    if (isTargetEmpty(finalTarget)) {
      if (connectTo?.length === 1) {
        finalTarget = connectTo[0];
      } else if (connectTo && connectTo.length > 1) {
        return err(
          new NexusTargetingError(
            `Nexus: Default target is ambiguous. ${connectTo.length} targets are defined in 'connectTo'. Please specify a 'target' explicitly in create().`,
            "E_TARGET_UNEXPECTED_COUNT",
            { connectToCount: connectTo.length },
          ),
        );
      }
    }

    if (isTargetEmpty(finalTarget)) {
      return err(
        new NexusTargetingError(
          `Nexus: No target specified for creating proxy for token "${tokenId}". A target must be provided either in create() options, the Token, or a unique 'connectTo' endpoint config.`,
          "E_TARGET_NO_MATCH",
          { token: tokenId, target: optionsTarget },
        ),
      );
    }

    return ok(finalTarget);
  };
}

function isTargetEmpty(target: object | null | undefined): boolean {
  return !target || Object.keys(target).length === 0;
}
