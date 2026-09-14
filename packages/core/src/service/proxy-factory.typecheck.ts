import { expectTypeOf } from "vitest";
import type { RemoteValue } from "@/api/types";
import { safeCall } from "./proxy-factory";

declare const call: RemoteValue<{ readonly id: string }>;

expectTypeOf(safeCall(call)).toEqualTypeOf<
  Promise<
    import("better-result").Result<
      { readonly id: string },
      import("@/errors").NexusCallError
    >
  >
>();
