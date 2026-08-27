import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OcppVersion } from "../src/ocppVersion";
import type { StationSpec } from "./manifest";
import {
  applyRegexFilters,
  loadPatternFile,
  mergePatterns,
} from "./regexFilter";
import { withTempFile, withTempJsonFile } from "./testSupport";

function station(id: string): StationSpec {
  return {
    id,
    ocppVersion: OcppVersion.OCPP_1_6,
    evses: [{ id: 1, connectorIds: [1] }],
  };
}

describe("loadPatternFile", () => {
  test("returns [] when no path is configured", async () => {
    assert.deepEqual(await loadPatternFile(undefined), []);
  });

  test("returns [] when the file doesn't exist", async () => {
    assert.deepEqual(await loadPatternFile("/nonexistent/patterns.json"), []);
  });

  test("loads a JSON array of pattern strings", async () => {
    await withTempJsonFile(["^SIM-", "^ACE-\\d{4}$"], async (path) => {
      assert.deepEqual(await loadPatternFile(path), ["^SIM-", "^ACE-\\d{4}$"]);
    });
  });

  test("returns [] when the file isn't valid JSON", async () => {
    await withTempFile("not json", async (path) => {
      assert.deepEqual(await loadPatternFile(path), []);
    });
  });

  test("returns [] when the file fails schema validation", async () => {
    await withTempJsonFile([1, 2, 3], async (path) => {
      assert.deepEqual(await loadPatternFile(path), []);
    });
  });
});

describe("mergePatterns", () => {
  test("dedupes across multiple sources", () => {
    assert.deepEqual(mergePatterns(["^SIM-", "^ACE-"], ["^SIM-", "^TEST-"]), [
      "^SIM-",
      "^ACE-",
      "^TEST-",
    ]);
  });
});

describe("applyRegexFilters", () => {
  const stations = [
    station("SIM-0001"),
    station("SIM-0002"),
    station("ACE-0003"),
  ];

  test("is a no-op when no patterns are given", () => {
    assert.deepEqual(applyRegexFilters(stations, [], []), stations);
  });

  test("include keeps only ids matching at least one pattern", () => {
    const result = applyRegexFilters(stations, ["^SIM-"], []);
    assert.deepEqual(
      result.map((s) => s.id),
      ["SIM-0001", "SIM-0002"],
    );
  });

  test("exclude drops ids matching any pattern, applied after include", () => {
    const result = applyRegexFilters(stations, ["^SIM-"], ["0002$"]);
    assert.deepEqual(
      result.map((s) => s.id),
      ["SIM-0001"],
    );
  });

  test("patterns aren't auto-anchored", () => {
    const result = applyRegexFilters(stations, ["SIM"], []);
    assert.deepEqual(
      result.map((s) => s.id),
      ["SIM-0001", "SIM-0002"],
    );
  });
});
