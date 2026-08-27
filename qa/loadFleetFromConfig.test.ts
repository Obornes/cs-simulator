import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { CONFIG } from "./config";
import { loadFleetFromConfig } from "./loadFleetFromConfig";
import { withTempJsonFile } from "./testSupport";

function onceResponse(ids: string[]) {
  return {
    data: ids.map((id) => ({
      ocppChargingStationId: id,
      ocppVersion: "OCPP_1_6",
      chargingPoints: [{ ocppEvseId: 1, connectors: [{ ocppConnectorId: 1 }] }],
    })),
    pagination: { next: null },
  };
}

function mockOnceFetch(ids: string[]): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(onceResponse(ids)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("loadFleetFromConfig", () => {
  let originalFetch: typeof fetch;
  let originalConfig: typeof CONFIG;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalConfig = { ...CONFIG };
    CONFIG.onceApiUrl = undefined;
    CONFIG.onceApiKey = undefined;
    CONFIG.onceApiTenantId = undefined;
    CONFIG.manifestFile = undefined;
    CONFIG.includeFile = "/nonexistent/include.json";
    CONFIG.excludeFile = "/nonexistent/exclude.json";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.assign(CONFIG, originalConfig);
  });

  test("returns [] when nothing is configured in CONFIG", async () => {
    assert.deepEqual(await loadFleetFromConfig(), []);
  });

  test("reads CONFIG.manifestFile and unions it with the real ONCE fetch", async () => {
    CONFIG.onceApiUrl = "https://once.example.test/_external/api/v1";
    CONFIG.onceApiKey = "test-key";
    mockOnceFetch(["ONCE-0001"]);

    await withTempJsonFile(
      {
        stations: [
          { id: "SIM-0001", ocppVersion: "OCPP_1.6", connectorCount: 1 },
        ],
      },
      async (manifestPath) => {
        CONFIG.manifestFile = manifestPath;
        const result = await loadFleetFromConfig();
        assert.deepEqual(result.map((s) => s.id).sort(), [
          "ONCE-0001",
          "SIM-0001",
        ]);
      },
    );
  });

  test("doesn't call the real ONCE fetch when ONCE_API_URL/ONCE_API_KEY are unset", async () => {
    const calls: unknown[] = [];
    globalThis.fetch = (async () => {
      calls.push(1);
      throw new Error("fetch should not be called when ONCE is unconfigured");
    }) as typeof fetch;

    await withTempJsonFile(
      {
        stations: [
          { id: "SIM-0001", ocppVersion: "OCPP_1.6", connectorCount: 1 },
        ],
      },
      async (manifestPath) => {
        CONFIG.manifestFile = manifestPath;
        const result = await loadFleetFromConfig();
        assert.deepEqual(
          result.map((s) => s.id),
          ["SIM-0001"],
        );
        assert.equal(calls.length, 0);
      },
    );
  });

  test("reads CONFIG.includeFile/excludeFile for filtering", async () => {
    CONFIG.onceApiUrl = "https://once.example.test/_external/api/v1";
    CONFIG.onceApiKey = "test-key";
    mockOnceFetch(["SIM-0001", "SIM-0002", "ACE-0003"]);

    await withTempJsonFile(["^SIM-"], async (includePath) => {
      await withTempJsonFile(["0002$"], async (excludePath) => {
        CONFIG.includeFile = includePath;
        CONFIG.excludeFile = excludePath;

        const result = await loadFleetFromConfig();

        assert.deepEqual(
          result.map((s) => s.id),
          ["SIM-0001"],
        );
      });
    });
  });

  test("still passes cliIncludePatterns/cliExcludePatterns through to loadFleet", async () => {
    CONFIG.onceApiUrl = "https://once.example.test/_external/api/v1";
    CONFIG.onceApiKey = "test-key";
    mockOnceFetch(["SIM-0001", "ACE-0003"]);

    const result = await loadFleetFromConfig({ cliIncludePatterns: ["^ACE-"] });

    assert.deepEqual(
      result.map((s) => s.id),
      ["ACE-0003"],
    );
  });
});
