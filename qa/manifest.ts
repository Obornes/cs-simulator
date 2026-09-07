import { readFile } from "node:fs/promises";
import { z } from "zod";
import { logger } from "../src/logger";
import { OcppVersion } from "../src/ocppVersion";

// Left un-refined (a plain ZodObject, not ZodEffects) so it stays mergeable via `.merge()`
// below — the sessionMax >= sessionMin constraint is applied after the merge instead.
export const BehaviorOverridesSchema = z
  .object({
    chargeProbability: z.number().min(0).max(1),
    disconnectProbability: z.number().min(0).max(1),
    sessionMinMinutes: z.number().positive(),
    sessionMaxMinutes: z.number().positive(),
  })
  .partial();

const EvseSpecSchema = z.object({
  id: z.number().int().positive(), // ocppEvseId — internal-only label for OCPP 1.6, on-wire for 2.0.1/2.1
  connectorIds: z.array(z.number().int().positive()).min(1),
});

const PoolSpecSchema = z.object({
  id: z.string().min(1), // chargingPool.id from the CPMS (§4b) — opaque grouping key, not OCPP
  name: z.string().optional(), // chargingPool.name — display only
});

const StationSpecInputSchema = z
  .object({
    id: z.string().min(1), // ocppChargingStationId — used verbatim as CP_ID
    ocppVersion: z.nativeEnum(OcppVersion),
    connectorCount: z.number().int().positive().optional(), // shorthand — see docs/fleet-loader-spec.md §5.1
    evses: z.array(EvseSpecSchema).min(1).optional(), // explicit real topology
    pool: PoolSpecSchema.optional(), // §4b for ONCE-sourced stations; hand-authored in a manifest, or omitted
  })
  .merge(BehaviorOverridesSchema)
  .refine((s) => (s.connectorCount === undefined) !== (s.evses === undefined), {
    message: "Specify exactly one of connectorCount or evses",
    path: ["connectorCount"],
  })
  .refine(
    (s) =>
      s.sessionMinMinutes === undefined ||
      s.sessionMaxMinutes === undefined ||
      s.sessionMaxMinutes >= s.sessionMinMinutes,
    {
      message: "sessionMaxMinutes must be >= sessionMinMinutes",
      path: ["sessionMaxMinutes"],
    },
  );

export const StationSpecSchema = StationSpecInputSchema.transform((s) => {
  const { connectorCount, ...rest } = s;
  return {
    ...rest,
    evses: s.evses ?? [
      {
        id: 1,
        connectorIds: Array.from(
          { length: connectorCount as number },
          (_, i) => i + 1,
        ),
      },
    ],
  };
});

export type StationSpec = z.infer<typeof StationSpecSchema>;

// docs/fleet-loader-spec.md §5.2 — a wrapping object (not a bare array) so manifest-level
// defaults can be applied without a breaking shape change.
export const ManifestFileSchema = z.object({
  defaults: BehaviorOverridesSchema.optional(),
  stations: z.array(StationSpecSchema).min(1),
});
export type ManifestFile = z.infer<typeof ManifestFileSchema>;

/**
 * The explicit-list provider (§4a). Returns [] — not an error — when no path is configured
 * or the file doesn't exist; that's the expected shape for "ONCE-only, no explicit list".
 * A path that *is* configured but points at a malformed/invalid file is a real
 * misconfiguration: logged loudly, but still returns [] rather than taking down the rest of
 * the fleet loader (same stance as qa/onceProvider.ts's ONCE auth-failure handling).
 */
export async function loadExplicitList(
  path: string | undefined,
): Promise<StationSpec[]> {
  if (!path) {
    return [];
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    logger.error(`Failed to read manifest file ${path}: ${err}`);
    return [];
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    logger.error(`Manifest file ${path} is not valid JSON: ${err}`);
    return [];
  }

  const result = ManifestFileSchema.safeParse(parsedJson);
  if (!result.success) {
    logger.error(
      `Manifest file ${path} failed schema validation: ${result.error}`,
    );
    return [];
  }

  // §5.2's cascade, first step: per-station override wins over manifest defaults. The
  // remaining step (manifest defaults → global CONFIG) happens later, at qa/station.ts's
  // read time (§8.4) — this function only ever sees the manifest, never CONFIG.
  const { defaults, stations } = result.data;
  if (!defaults) {
    return stations;
  }
  return stations.map((station) => ({ ...defaults, ...station }));
}
