import { expectTypeOf } from "vitest";
import type {
  NexusCallError,
  NexusConnectionConstraintFailedError,
  NexusServiceError,
  NexusUsageError,
  ResourceAcquireError,
} from "@/errors";
import type { NexusUsageErrorCode } from "./usage-errors";
type ResourceAcquireErrorCode =
  | "E_CONN_CLOSED"
  | "E_SERVICE_UNAVAILABLE"
  | "E_USAGE_INVALID";

expectTypeOf<
  ResourceAcquireError["code"]
>().toEqualTypeOf<ResourceAcquireErrorCode>();
expectTypeOf<NexusUsageError["code"]>().toEqualTypeOf<NexusUsageErrorCode>();

expectTypeOf<Extract<NexusCallError, NexusServiceError>>().toEqualTypeOf<
  NexusServiceError<"E_SERVICE_UNAVAILABLE">
>();
expectTypeOf<
  Extract<NexusCallError, NexusConnectionConstraintFailedError>
>().toBeNever();
