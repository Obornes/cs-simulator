import { CONFIG, resolveStaggerSeconds } from "./config";
import { loadFleetFromConfig } from "./loadFleetFromConfig";
import { connectFleet } from "./orchestrate";
import { Station } from "./station";
import { logInfo, printProgress } from "./stats";

const PROGRESS_INTERVAL_MS = 15_000;

let shuttingDown = false;

async function main(): Promise<void> {
  const specs = await loadFleetFromConfig();
  if (specs.length === 0) {
    logInfo(
      "qa",
      "No stations to simulate — configure MANIFEST_FILE and/or ONCE_API_URL/ONCE_API_KEY.",
    );
    return;
  }

  const stations = specs.map((spec) => new Station(spec));
  const staggerSeconds = resolveStaggerSeconds(stations.length);

  logInfo(
    "qa",
    `Starting ${stations.length} station(s), staggered over 0-${staggerSeconds}s (WS_URL=${CONFIG.wsUrl})...`,
  );
  connectFleet(stations, staggerSeconds, () => shuttingDown);

  const progressTimer = setInterval(
    () => printProgress(stations),
    PROGRESS_INTERVAL_MS,
  );

  // §7's console isn't built yet — for now this just keeps the process alive and reports
  // progress until interrupted.
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(progressTimer);
    logInfo("qa", "Shutting down...");
    for (const station of stations) {
      station.destroy();
    }
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
