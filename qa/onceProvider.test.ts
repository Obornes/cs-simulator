import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { OcppVersion } from "../src/ocppVersion";
import { CONFIG } from "./config";
import { fetchOnceFleet } from "./onceProvider";

type FetchCall = { url: string; init: RequestInit };

function mockFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headersOf(call: FetchCall): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

describe("fetchOnceFleet", () => {
  let originalFetch: typeof fetch;
  let originalConfig: typeof CONFIG;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalConfig = { ...CONFIG };
    CONFIG.onceApiUrl = "https://once.example.test/_external/api/v1";
    CONFIG.onceApiKey = "test-key";
    CONFIG.onceApiTenantId = undefined;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.assign(CONFIG, originalConfig);
  });

  test("returns [] and makes no request when ONCE_API_URL/ONCE_API_KEY are unset", async () => {
    CONFIG.onceApiUrl = undefined;
    CONFIG.onceApiKey = undefined;
    const calls = mockFetch(() => {
      throw new Error("fetch should not be called when unconfigured");
    });

    const result = await fetchOnceFleet();

    assert.deepEqual(result, []);
    assert.equal(calls.length, 0);
  });

  test("maps a single page and stops when pagination.next is null", async () => {
    const calls = mockFetch(() =>
      jsonResponse(200, {
        data: [
          {
            ocppChargingStationId: "SIM-0001",
            ocppVersion: "OCPP_2_0_1",
            chargingPoints: [
              { ocppEvseId: 1, connectors: [{ ocppConnectorId: 1 }] },
              {
                ocppEvseId: 2,
                connectors: [{ ocppConnectorId: 1 }, { ocppConnectorId: 2 }],
              },
            ],
          },
        ],
        pagination: { next: null },
      }),
    );

    const result = await fetchOnceFleet();

    assert.equal(calls.length, 1);
    assert.match(
      calls[0].url,
      /\/charging-stations\/rsql-list\?page=1&limit=1000$/,
    );
    assert.equal(headersOf(calls[0])["x-api-key"], "test-key");
    assert.equal("X-Tenant-Id" in headersOf(calls[0]), false);

    assert.deepEqual(result, [
      {
        id: "SIM-0001",
        ocppVersion: OcppVersion.OCPP_2_0_1,
        evses: [
          { id: 1, connectorIds: [1] },
          { id: 2, connectorIds: [1, 2] },
        ],
      },
    ]);
  });

  test("maps chargingPool into StationSpec.pool when present", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        data: [
          {
            ocppChargingStationId: "SIM-0001",
            ocppVersion: "OCPP_2_0_1",
            chargingPoints: [
              { ocppEvseId: 1, connectors: [{ ocppConnectorId: 1 }] },
            ],
            chargingPool: { id: "SITE-42", name: "Site 42" },
          },
        ],
        pagination: { next: null },
      }),
    );

    const result = await fetchOnceFleet();

    assert.deepEqual(result[0].pool, { id: "SITE-42", name: "Site 42" });
  });

  test("leaves pool unset when chargingPool is absent (existing behavior, unchanged)", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        data: [
          {
            ocppChargingStationId: "SIM-0001",
            ocppVersion: "OCPP_2_0_1",
            chargingPoints: [
              { ocppEvseId: 1, connectors: [{ ocppConnectorId: 1 }] },
            ],
          },
        ],
        pagination: { next: null },
      }),
    );

    const result = await fetchOnceFleet();

    assert.equal("pool" in result[0], false);
  });

  test("paginates until pagination.next is null", async () => {
    const calls = mockFetch((call) => {
      const page = new URL(call.url).searchParams.get("page");
      if (page === "1") {
        return jsonResponse(200, {
          data: [
            {
              ocppChargingStationId: "SIM-0001",
              ocppVersion: "OCPP_1_6",
              chargingPoints: [
                { ocppEvseId: 1, connectors: [{ ocppConnectorId: 1 }] },
              ],
            },
          ],
          pagination: {
            next: "https://once.example.test/_external/api/v1/charging-stations/rsql-list?page=2&limit=1000",
          },
        });
      }
      return jsonResponse(200, {
        data: [
          {
            ocppChargingStationId: "SIM-0002",
            ocppVersion: "OCPP_1_6",
            chargingPoints: [
              { ocppEvseId: 1, connectors: [{ ocppConnectorId: 1 }] },
            ],
          },
        ],
        pagination: { next: null },
      });
    });

    const result = await fetchOnceFleet();

    assert.equal(calls.length, 2);
    assert.deepEqual(
      result.map((s) => s.id),
      ["SIM-0001", "SIM-0002"],
    );
  });

  test("sends X-Tenant-Id when ONCE_API_TENANT_ID is configured", async () => {
    CONFIG.onceApiTenantId = "tenant-a";
    const calls = mockFetch(() =>
      jsonResponse(200, { data: [], pagination: { next: null } }),
    );

    await fetchOnceFleet();

    assert.equal(headersOf(calls[0])["X-Tenant-Id"], "tenant-a");
  });

  test("returns [] without retrying on a 401 (ambiguous key/tenant rejection)", async () => {
    const calls = mockFetch(() => new Response(null, { status: 401 }));

    const result = await fetchOnceFleet();

    assert.deepEqual(result, []);
    assert.equal(calls.length, 1);
  });

  test("returns [] without retrying on a 403 (missing permission)", async () => {
    const calls = mockFetch(() =>
      jsonResponse(403, {
        message: "Forbidden",
        error: {
          message: "Missing required permission: ChargingStation.Read",
          requiredPermission: "ChargingStation.Read",
        },
      }),
    );

    const result = await fetchOnceFleet();

    assert.deepEqual(result, []);
    assert.equal(calls.length, 1);
  });

  test("skips a station with an unrecognized ocppVersion but keeps the rest", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        data: [
          {
            ocppChargingStationId: "BAD-1",
            ocppVersion: "OCPP_9_9",
            chargingPoints: [
              { ocppEvseId: 1, connectors: [{ ocppConnectorId: 1 }] },
            ],
          },
          {
            ocppChargingStationId: "GOOD-1",
            ocppVersion: "OCPP_1_6",
            chargingPoints: [
              { ocppEvseId: 1, connectors: [{ ocppConnectorId: 1 }] },
            ],
          },
        ],
        pagination: { next: null },
      }),
    );

    const result = await fetchOnceFleet();

    assert.deepEqual(
      result.map((s) => s.id),
      ["GOOD-1"],
    );
  });

  test("skips a station whose charging points have no connectors", async () => {
    mockFetch(() =>
      jsonResponse(200, {
        data: [
          {
            ocppChargingStationId: "EMPTY-1",
            ocppVersion: "OCPP_1_6",
            chargingPoints: [{ ocppEvseId: 1, connectors: [] }],
          },
        ],
        pagination: { next: null },
      }),
    );

    const result = await fetchOnceFleet();

    assert.deepEqual(result, []);
  });

  test("retries a transient network error then succeeds", async () => {
    let attempt = 0;
    const calls = mockFetch(() => {
      attempt++;
      if (attempt === 1) {
        throw new Error("ECONNRESET");
      }
      return jsonResponse(200, { data: [], pagination: { next: null } });
    });

    const result = await fetchOnceFleet();

    assert.deepEqual(result, []);
    assert.equal(calls.length, 2);
  });

  test("returns [] after exhausting retries on a persistent network error", async () => {
    const calls = mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    const result = await fetchOnceFleet();

    assert.deepEqual(result, []);
    assert.equal(calls.length, 3);
  });
});
