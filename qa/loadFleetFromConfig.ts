import { CONFIG } from "./config";
import { type LoadFleetOptions, loadFleet } from "./fleetSource";
import type { StationSpec } from "./manifest";
import { fetchOnceFleet } from "./onceProvider";

export type LoadFleetFromConfigOptions = Pick<
  LoadFleetOptions,
  "cliIncludePatterns" | "cliExcludePatterns"
>;

/**
 * The production wiring for qa/fleetSource.ts's loadFleet(): supplies the env-driven
 * CONFIG file paths (§8) and the real ONCE fetch (qa/onceProvider.ts's fetchOnceFleet) as
 * loadFleet()'s options. qa/fleetSource.ts itself stays free of any CONFIG/onceProvider
 * import so its union/filter orchestration can be unit-tested with plain injected data
 * (qa/fleetSource.test.ts) — this is the one place that connects it back to the real
 * environment, and qa/run.ts calls this instead of loadFleet() directly.
 */
export function loadFleetFromConfig(
  options: LoadFleetFromConfigOptions = {},
): Promise<StationSpec[]> {
  return loadFleet({
    ...options,
    manifestFile: CONFIG.manifestFile,
    includeFile: CONFIG.includeFile,
    excludeFile: CONFIG.excludeFile,
    fetchCpmsFleet: fetchOnceFleet,
  });
}
