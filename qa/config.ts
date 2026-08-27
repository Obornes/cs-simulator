// Env-var-driven config, following this repo's existing .env/start.sh convention
// (WS_URL, CP_ID, PASSWORD — see root CLAUDE.md). Behavior-profile defaults (§8.4) join
// this file once qa/station.ts's session model exists.
export const CONFIG = {
  // Same env var the root index_*.ts scripts already use for the OCPP WebSocket endpoint.
  wsUrl: process.env.WS_URL ?? "ws://localhost:3000",
  // Base URL up to and including `/_external/api/v1` — the provider appends
  // `/charging-stations/rsql-list`. Unset → the ONCE source contributes no stations.
  onceApiUrl: process.env.ONCE_API_URL,
  // Sent as the `x-api-key` header. Unset → the ONCE source contributes no stations.
  onceApiKey: process.env.ONCE_API_KEY,
  // Sent as `X-Tenant-Id` when set. Only required when the target obornes-cpo-backbone
  // environment has multitenancy enabled — safely omitted otherwise.
  onceApiTenantId: process.env.ONCE_API_TENANT_ID,
  // §4a — path to the explicit-list manifest JSON file. Unset → that source contributes no
  // stations (ONCE-only is a legitimate setup).
  manifestFile: process.env.MANIFEST_FILE,
  // §4c, §8.3 — include/exclude regex pattern-list files, applied after unioning §4a/§4b.
  // Defaulted (not left unset) since these are the documented default paths; a missing file
  // at either path — default or overridden — is treated as "no filter configured", not an
  // error (see qa/regexFilter.ts's loadPatternFile).
  includeFile: process.env.CPMS_INCLUDE_FILE ?? "qa/manifests/include.json",
  excludeFile: process.env.CPMS_EXCLUDE_FILE ?? "qa/manifests/exclude.json",
};

/**
 * §6.2 "Connection fan-out" — how many seconds to spread `stationCount` connection attempts
 * over. `STAGGER_SECONDS` overrides; otherwise scales with fleet size (roughly 9%/s, floored
 * at 10s), same formula as demo/config.ts's `staggerSeconds`. Fleet size isn't known at
 * module-load time here (it depends on qa/fleetSource.ts's fetch), unlike demo/ where
 * STATION_COUNT is itself the config — so this is a function, computed once loadFleet()
 * resolves, rather than a static CONFIG field.
 */
export function resolveStaggerSeconds(stationCount: number): number {
  const override = process.env.STAGGER_SECONDS;
  if (override) {
    return Number.parseInt(override, 10);
  }
  return Math.max(10, Math.ceil(stationCount * 0.09));
}
