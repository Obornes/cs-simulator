import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OcppVersion } from "../src/ocppVersion";
import { StationSpecSchema, loadExplicitList } from "./manifest";
import { withTempFile, withTempJsonFile } from "./testSupport";

describe("StationSpecSchema", () => {
  test("normalizes connectorCount into a single-EVSE evses list", () => {
    const result = StationSpecSchema.parse({
      id: "SIM-0007",
      ocppVersion: OcppVersion.OCPP_1_6,
      connectorCount: 3,
    });
    assert.deepEqual(result.evses, [{ id: 1, connectorIds: [1, 2, 3] }]);
  });

  test("passes an explicit evses list through unchanged", () => {
    const evses = [
      { id: 1, connectorIds: [1] },
      { id: 2, connectorIds: [1, 2] },
    ];
    const result = StationSpecSchema.parse({
      id: "MULTI-0001",
      ocppVersion: OcppVersion.OCPP_2_0_1,
      evses,
    });
    assert.deepEqual(result.evses, evses);
  });

  test("rejects a spec with neither connectorCount nor evses", () => {
    assert.throws(() =>
      StationSpecSchema.parse({
        id: "SIM-0001",
        ocppVersion: OcppVersion.OCPP_1_6,
      }),
    );
  });

  test("rejects a spec with both connectorCount and evses", () => {
    assert.throws(() =>
      StationSpecSchema.parse({
        id: "SIM-0001",
        ocppVersion: OcppVersion.OCPP_1_6,
        connectorCount: 1,
        evses: [{ id: 1, connectorIds: [1] }],
      }),
    );
  });

  test("rejects sessionMaxMinutes below sessionMinMinutes", () => {
    assert.throws(() =>
      StationSpecSchema.parse({
        id: "SIM-0001",
        ocppVersion: OcppVersion.OCPP_1_6,
        connectorCount: 1,
        sessionMinMinutes: 10,
        sessionMaxMinutes: 5,
      }),
    );
  });
});

describe("loadExplicitList", () => {
  test("returns [] when no path is configured", async () => {
    assert.deepEqual(await loadExplicitList(undefined), []);
  });

  test("returns [] when the file doesn't exist", async () => {
    assert.deepEqual(await loadExplicitList("/nonexistent/manifest.json"), []);
  });

  test("loads and validates a manifest, applying station overrides over defaults", async () => {
    await withTempJsonFile(
      {
        defaults: {
          chargeProbability: 0.1,
          sessionMinMinutes: 5,
          sessionMaxMinutes: 20,
        },
        stations: [
          {
            id: "SIM-0007",
            ocppVersion: OcppVersion.OCPP_1_6,
            connectorCount: 2,
          },
          {
            id: "ACE-0003",
            ocppVersion: OcppVersion.OCPP_1_6,
            connectorCount: 4,
            chargeProbability: 0.5,
          },
        ],
      },
      async (path) => {
        const result = await loadExplicitList(path);

        assert.equal(result.length, 2);
        assert.equal(result[0].id, "SIM-0007");
        assert.equal(result[0].chargeProbability, 0.1); // inherited from defaults
        assert.equal(result[0].sessionMinMinutes, 5);
        assert.equal(result[1].id, "ACE-0003");
        assert.equal(result[1].chargeProbability, 0.5); // its own override wins
        assert.equal(result[1].sessionMinMinutes, 5); // still inherited
      },
    );
  });

  test("returns [] when the file isn't valid JSON", async () => {
    await withTempFile("not json", async (path) => {
      assert.deepEqual(await loadExplicitList(path), []);
    });
  });

  test("returns [] when the file fails schema validation", async () => {
    await withTempJsonFile({ stations: [] }, async (path) => {
      // `stations` must have at least one entry (§5.2)
      assert.deepEqual(await loadExplicitList(path), []);
    });
  });
});
