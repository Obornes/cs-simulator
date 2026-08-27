// Independent copy of demo/stats.ts's color/logging conventions — qa/ doesn't import from
// demo/ (docs/fleet-loader-spec.md §9).
import type { Station } from "./station";

export const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
};

function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

export function logInfo(stationId: string, msg: string): void {
  console.log(
    `${C.dim}[${ts()}]${C.reset} ${C.cyan}[${stationId}]${C.reset} ${msg}`,
  );
}

export function logDebug(stationId: string, msg: string): void {
  if (process.env.LOG_LEVEL === "debug") {
    console.log(
      `${C.dim}[${ts()}]${C.reset} ${C.dim}[${stationId}] ${msg}${C.reset}`,
    );
  }
}

/**
 * docs/fleet-loader-spec.md §6.2 "Progress/readiness reporting" — purely informational, not
 * a blocking readiness gate. EVSE/connector counts only cover already-`connected` stations,
 * so the numbers climb as the stagger window (§6.2) progresses.
 */
export function printProgress(stations: Station[]): void {
  const connectedStations = stations.filter((s) => s.state === "connected");
  const evseIds = new Set<string>();
  let connectorCount = 0;
  for (const station of connectedStations) {
    connectorCount += station.connectors.size;
    for (const connector of station.connectors.values()) {
      evseIds.add(`${station.id}:${connector.evseId}`);
    }
  }
  console.log(
    `${C.bold}${C.green}[${ts()}]${C.reset} Connected: ${C.cyan}${connectedStations.length}/${stations.length}${C.reset} ` +
      `(${evseIds.size} EVSEs, ${connectorCount} connectors booted)`,
  );
}
