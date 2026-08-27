import { type StationSpec, loadExplicitList } from "./manifest";
import {
  applyRegexFilters,
  loadPatternFile,
  mergePatterns,
} from "./regexFilter";

export interface LoadFleetOptions {
  // §4a — path to the explicit-list manifest JSON file. Undefined → that source contributes
  // no stations, silently (not an error) — see qa/manifest.ts's loadExplicitList.
  manifestFile?: string;
  // §4c, §8.3 — include/exclude regex pattern-list files. Undefined → no filtering on that
  // side, silently (not an error) — see qa/regexFilter.ts's loadPatternFile.
  includeFile?: string;
  excludeFile?: string;
  // §8.3 — CLI `--include`/`--exclude` values, additive on top of each side's pattern file.
  // No CLI parser exists yet (that's qa/run.ts's job once it does); callers pass these in.
  cliIncludePatterns?: string[];
  cliExcludePatterns?: string[];
  // §4b — fetches the fleet from a CPMS, generically: this module doesn't know or care which
  // one. Undefined → that source contributes no stations, silently (not an error), same as
  // the other two sources above. The production wiring (the real ONCE fetch,
  // qa/onceProvider.ts's fetchOnceFleet) lives in qa/loadFleetFromConfig.ts instead — this
  // module stays free of any CONFIG/ONCE-specific dependency so it can be unit-tested with
  // plain injected data.
  fetchCpmsFleet?: () => Promise<StationSpec[]>;
}

/**
 * docs/fleet-loader-spec.md §4 — "gather from both, then filter", not "pick one source".
 * Always reads the explicit-list manifest (§4a) *and* fetches from a CPMS (§4b) — each
 * independently contributes an empty list when its option is omitted, never an error —
 * unions the two, then runs the union through the include/exclude regex pass (§4c). With
 * nothing configured anywhere, the result is simply an empty fleet, which is the expected
 * shape for "you haven't told the loader where to get stations from yet".
 */
export async function loadFleet(
  options: LoadFleetOptions = {},
): Promise<StationSpec[]> {
  const [explicitList, cpmsList, includeFilePatterns, excludeFilePatterns] =
    await Promise.all([
      loadExplicitList(options.manifestFile),
      options.fetchCpmsFleet ? options.fetchCpmsFleet() : Promise.resolve([]),
      loadPatternFile(options.includeFile),
      loadPatternFile(options.excludeFile),
    ]);

  const union = [...explicitList, ...cpmsList];

  const includePatterns = mergePatterns(
    includeFilePatterns,
    options.cliIncludePatterns ?? [],
  );
  const excludePatterns = mergePatterns(
    excludeFilePatterns,
    options.cliExcludePatterns ?? [],
  );

  return applyRegexFilters(union, includePatterns, excludePatterns);
}
