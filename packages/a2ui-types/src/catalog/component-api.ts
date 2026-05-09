import type { ComponentApi as UpstreamComponentApi } from "@a2ui/web_core/v0_9";
import type { z } from "zod";

/**
 * Local shadow of `@a2ui/web_core`'s `ComponentApi` with a
 * v4-compatible schema constraint.
 *
 * `@a2ui/web_core@0.9.1-alpha.0` declares
 * `ComponentApi<Schema extends z.ZodTypeAny>` against zod v3's
 * `ZodTypeAny`. When this workspace upgrades to zod v4, v4's
 * `ZodObject<…, $strict>` is structurally distinct (new `_zod.def`
 * namespace) and no longer satisfies that v3 constraint — even
 * though it's runtime-compatible via v4's compat shim.
 *
 * Widening the schema type to `z.ZodType` unblocks v4 catalog
 * schemas without touching upstream. Remove this shadow (and
 * re-import directly from `@a2ui/web_core`) once upstream ships a
 * zod-v4-compatible release.
 */
export type ComponentApi = Omit<UpstreamComponentApi, "schema"> & {
  readonly schema: z.ZodType;
};
