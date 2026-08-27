import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OcppVersion } from "../src/ocppVersion";
import { loadFleet } from "./fleetSource";
import type { StationSpec } from "./manifest";
import { withTempJsonFile } from "./testSupport";

function station(id: string): StationSpec {
  return {
    id,
    ocppVersion: OcppVersion.OCPP_1_6,
    evses: [{ id: 1, connectorIds: [1] }],
  };
}

describe("loadFleet", () => {
  test("returns [] when no option is given at all", async () => {
    assert.deepEqual(await loadFleet(), []);
  });

  test("unions the manifest's stations with the injected fetchCpmsFleet's stations", async () => {
    await withTempJsonFile(
      {
        stations: [
          { id: "SIM-0001", ocppVersion: "OCPP_1.6", connectorCount: 1 },
        ],
      },
      async (manifestPath) => {
        const result = await loadFleet({
          manifestFile: manifestPath,
          fetchCpmsFleet: async () => [station("ONCE-0001")],
        });
        assert.deepEqual(result.map((s) => s.id).sort(), [
          "ONCE-0001",
          "SIM-0001",
        ]);
      },
    );
  });

  test("contributes only the manifest's stations when fetchCpmsFleet is omitted", async () => {
    await withTempJsonFile(
      {
        stations: [
          { id: "SIM-0001", ocppVersion: "OCPP_1.6", connectorCount: 1 },
        ],
      },
      async (manifestPath) => {
        const result = await loadFleet({ manifestFile: manifestPath });
        assert.deepEqual(
          result.map((s) => s.id),
          ["SIM-0001"],
        );
      },
    );
  });

  test("contributes only fetchCpmsFleet's stations when manifestFile is omitted", async () => {
    const result = await loadFleet({
      fetchCpmsFleet: async () => [station("ONCE-0001")],
    });
    assert.deepEqual(
      result.map((s) => s.id),
      ["ONCE-0001"],
    );
  });

  test("applies include/exclude filters loaded from the given file paths", async () => {
    await withTempJsonFile(["^SIM-"], async (includePath) => {
      await withTempJsonFile(["0002$"], async (excludePath) => {
        const result = await loadFleet({
          includeFile: includePath,
          excludeFile: excludePath,
          fetchCpmsFleet: async () => [
            station("SIM-0001"),
            station("SIM-0002"),
            station("ACE-0003"),
          ],
        });

        assert.deepEqual(
          result.map((s) => s.id),
          ["SIM-0001"],
        );
      });
    });
  });

  test("merges CLI-provided patterns additively with file patterns", async () => {
    await withTempJsonFile(["^SIM-"], async (includePath) => {
      const result = await loadFleet({
        includeFile: includePath,
        cliIncludePatterns: ["^ACE-"],
        fetchCpmsFleet: async () => [station("SIM-0001"), station("ACE-0003")],
      });

      assert.deepEqual(result.map((s) => s.id).sort(), [
        "ACE-0003",
        "SIM-0001",
      ]);
    });
  });
});
