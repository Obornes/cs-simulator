import { readFile } from "node:fs/promises";
import { z } from "zod";
import { logger } from "../src/logger";
import type { StationSpec } from "./manifest";

// docs/fleet-loader-spec.md §5.3
export const RegexFilterListSchema = z.array(z.string().min(1));

/**
 * Loads a JSON array of regex pattern strings from `path` (§5.3, §8.3). Returns [] — not an
 * error — when no path is configured or the file doesn't exist (the expected shape for "no
 * include/exclude filtering configured"). A path that *is* configured but points at a
 * malformed/invalid file is a real misconfiguration: logged loudly, but still returns []
 * (same stance as qa/manifest.ts's loadExplicitList).
 */
export async function loadPatternFile(
  path: string | undefined,
): Promise<string[]> {
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
    logger.error(`Failed to read pattern file ${path}: ${err}`);
    return [];
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    logger.error(`Pattern file ${path} is not valid JSON: ${err}`);
    return [];
  }

  const result = RegexFilterListSchema.safeParse(parsedJson);
  if (!result.success) {
    logger.error(
      `Pattern file ${path} failed schema validation: ${result.error}`,
    );
    return [];
  }
  return result.data;
}

/** §8.3 — file patterns and CLI patterns merged into one deduplicated list per side. */
export function mergePatterns(...sources: string[][]): string[] {
  return Array.from(new Set(sources.flat()));
}

/**
 * §4c — applied after unioning both sources (§4a, §4b). Include narrows to ids matching at
 * least one pattern (no-op when empty); exclude then drops ids matching any pattern (no-op
 * when empty), applied last. Patterns aren't auto-anchored — compiled with `new RegExp`
 * as-is, so e.g. `"SIM-"` matches anywhere in the id unless the pattern itself anchors with
 * `^`/`$`.
 */
export function applyRegexFilters(
  stations: StationSpec[],
  includePatterns: string[],
  excludePatterns: string[],
): StationSpec[] {
  let result = stations;

  if (includePatterns.length > 0) {
    const include = includePatterns.map((p) => new RegExp(p));
    result = result.filter((s) => include.some((r) => r.test(s.id)));
  }

  if (excludePatterns.length > 0) {
    const exclude = excludePatterns.map((p) => new RegExp(p));
    result = result.filter((s) => !exclude.some((r) => r.test(s.id)));
  }

  return result;
}
