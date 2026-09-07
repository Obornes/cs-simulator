import { z } from "zod";
import { logger } from "../src/logger";
import { OcppVersion } from "../src/ocppVersion";
import { CONFIG } from "./config";
import { type StationSpec, StationSpecSchema } from "./manifest";

// docs/fleet-loader-spec.md §4b — the ONCE-fetched provider.

const PAGE_LIMIT = 1000; // PaginationDto's max on the obornes-cpo-backbone side

// `obornes-cpo-backbone` uses underscores (its prisma `OcppVersion` enum); this repo's
// OcppVersion uses dots (src/ocppVersion.ts). §4b's "known gotcha".
const CPMS_OCPP_VERSION: Record<string, OcppVersion> = {
  OCPP_1_6: OcppVersion.OCPP_1_6,
  OCPP_2_0_1: OcppVersion.OCPP_2_0_1,
  OCPP_2_1: OcppVersion.OCPP_2_1,
};

const OnceConnectorSchema = z.object({
  ocppConnectorId: z.number().int().positive(),
});

const OnceChargingPointSchema = z.object({
  ocppEvseId: z.number().int().positive(),
  connectors: z.array(OnceConnectorSchema),
});

const OnceChargingPoolSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
});

const OnceChargingStationSchema = z.object({
  ocppChargingStationId: z.string().min(1),
  ocppVersion: z.string().optional(),
  chargingPoints: z.array(OnceChargingPointSchema),
  // Always present on the real CPMS response (confirmed non-optional in
  // ChargingStationWithChargingPoolDto), but kept optional here defensively so a station
  // missing it in some edge case degrades to "no pool" rather than being skipped outright.
  chargingPool: OnceChargingPoolSchema.optional(),
});

const OncePaginatedResultSchema = z.object({
  data: z.array(OnceChargingStationSchema),
  pagination: z.object({
    next: z.string().nullable(),
  }),
});

type OnceChargingStation = z.infer<typeof OnceChargingStationSchema>;

// docs/fleet-loader-spec.md §6.2 "CPMS authentication/authorization failures" — terminal,
// never retried. The message is deliberately non-specific for 401 (the ONCE API returns
// the same shape for a bad key, an expired key, and an unknown/inactive tenant, on purpose).
class OnceAuthError extends Error {}

async function parseAuthError(response: Response): Promise<OnceAuthError> {
  if (response.status === 401) {
    return new OnceAuthError(
      "401 Unauthorized from ONCE_API_URL. Check ONCE_API_KEY (unset / wrong / expired) and, " +
        "if this environment has multitenancy enabled, ONCE_API_TENANT_ID (unset / wrong slug / " +
        "tenant not ACTIVE) — the ONCE API returns an identical 401 for all of these on purpose, " +
        "to avoid leaking which one it is.",
    );
  }
  if (response.status === 403) {
    const body = await response.json().catch(() => undefined);
    const requiredPermission =
      body?.error?.requiredPermission ?? "ChargingStation.Read";
    return new OnceAuthError(
      `403 Forbidden — ONCE_API_KEY lacks the "${requiredPermission}" permission.`,
    );
  }
  const body = await response.text().catch(() => "");
  return new OnceAuthError(
    `${response.status} ${response.statusText} — ${body}`.trim(),
  );
}

const TRANSIENT_RETRY_ATTEMPTS = 3;
const TRANSIENT_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(
  page: number,
): Promise<z.infer<typeof OncePaginatedResultSchema>> {
  const url = `${CONFIG.onceApiUrl}/charging-stations/rsql-list?page=${page}&limit=${PAGE_LIMIT}`;
  const headers: Record<string, string> = {
    "x-api-key": CONFIG.onceApiKey as string,
    "content-type": "application/json",
  };
  if (CONFIG.onceApiTenantId) {
    headers["X-Tenant-Id"] = CONFIG.onceApiTenantId;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_RETRY_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: "{}" });
    } catch (err) {
      lastError = err;
      logger.warn(
        `ONCE fetch (page ${page}, attempt ${attempt}/${TRANSIENT_RETRY_ATTEMPTS}) failed: ${err}`,
      );
      await sleep(TRANSIENT_RETRY_DELAY_MS);
      continue;
    }

    // §6.2: any 4xx from this endpoint is terminal — never retried.
    if (response.status >= 400 && response.status < 500) {
      throw await parseAuthError(response);
    }
    if (!response.ok) {
      lastError = new Error(`${response.status} ${response.statusText}`);
      logger.warn(
        `ONCE fetch (page ${page}, attempt ${attempt}/${TRANSIENT_RETRY_ATTEMPTS}) failed: ${lastError}`,
      );
      await sleep(TRANSIENT_RETRY_DELAY_MS);
      continue;
    }

    const parsed = OncePaginatedResultSchema.safeParse(await response.json());
    if (!parsed.success) {
      // Contract drift, not a transient failure — fail fast rather than retry a guaranteed
      // repeat parse error.
      throw new Error(
        `ONCE response for page ${page} failed schema validation: ${parsed.error}`,
      );
    }
    return parsed.data;
  }

  throw new Error(
    `ONCE fetch (page ${page}) failed after ${TRANSIENT_RETRY_ATTEMPTS} attempts: ${lastError}`,
  );
}

// §4b's connector-topology gotcha: in cpo-backbone's seed data, ocppConnectorId === ocppEvseId
// of the parent charging point — an acknowledged simplification (IBC-2888), not real OCPP 2.0.1
// topology. We map chargingPoints verbatim regardless (ocppEvseId → EvseSpec.id,
// connectors[].ocppConnectorId → EvseSpec.connectorIds), so a real topology "just works" the
// day cpo-backbone's data no longer needs that simplification.
function mapStation(raw: OnceChargingStation): StationSpec | null {
  const ocppVersion =
    raw.ocppVersion !== undefined
      ? CPMS_OCPP_VERSION[raw.ocppVersion]
      : undefined;
  if (ocppVersion === undefined) {
    logger.warn(
      `Skipping ONCE station ${raw.ocppChargingStationId}: unrecognized ocppVersion "${raw.ocppVersion}"`,
    );
    return null;
  }

  const evses = raw.chargingPoints
    .filter((cp) => cp.connectors.length > 0)
    .map((cp) => ({
      id: cp.ocppEvseId,
      connectorIds: cp.connectors.map((c) => c.ocppConnectorId),
    }));
  if (evses.length === 0) {
    logger.warn(
      `Skipping ONCE station ${raw.ocppChargingStationId}: no usable charging point/connector`,
    );
    return null;
  }

  const result = StationSpecSchema.safeParse({
    id: raw.ocppChargingStationId,
    ocppVersion,
    evses,
    // Conditional spread, not `pool: raw.chargingPool` — see this task's header gotcha:
    // explicitly passing `pool: undefined` would add an own `pool` key to the parsed
    // result even when chargingPool is absent, breaking every deepEqual test that expects
    // no pool key at all.
    ...(raw.chargingPool ? { pool: raw.chargingPool } : {}),
  });
  if (!result.success) {
    logger.warn(
      `Skipping ONCE station ${raw.ocppChargingStationId}: ${result.error}`,
    );
    return null;
  }
  return result.data;
}

/**
 * Fetches the full fleet from ONCE (obornes-cpo-backbone's public API), paginating until
 * exhausted. Returns an empty list — not an error — when ONCE_API_URL/ONCE_API_KEY aren't
 * configured (docs/fleet-loader-spec.md §4b "if unconfigured"). On an auth failure or any
 * other terminal fetch error, logs it loudly and also returns an empty list — a
 * misconfigured-but-set ONCE source must never look identical to "not configured" in the
 * logs, but must also never take down the rest of the fleet loader (§6.2).
 */
export async function fetchOnceFleet(): Promise<StationSpec[]> {
  if (!CONFIG.onceApiUrl || !CONFIG.onceApiKey) {
    return [];
  }

  const stations: StationSpec[] = [];
  try {
    let page = 1;
    while (true) {
      const result = await fetchPage(page);
      for (const raw of result.data) {
        const spec = mapStation(raw);
        if (spec) {
          stations.push(spec);
        }
      }
      if (result.pagination.next === null) {
        break;
      }
      page += 1;
    }
  } catch (err) {
    logger.error(
      `ONCE fetch failed: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }

  return stations;
}
