import { parseArgs } from "node:util";
import { loadCommands } from "./commands";
import type { CommandContext } from "./commands/command";
import { CONFIG, resolveStaggerSeconds } from "./config";
import { runExecLines, startInteractiveConsole } from "./console";
import { loadFleetFromConfig } from "./loadFleetFromConfig";
import { connectFleet } from "./orchestrate";
import { Station } from "./station";
import { logInfo, printProgress } from "./stats";

const PROGRESS_INTERVAL_MS = 15_000;

let shuttingDown = false;

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { exec: { type: "string", multiple: true, default: [] } },
    strict: false,
  });
  const rawExec = values.exec ?? [];
  const execLines = rawExec.filter((v): v is string => typeof v === "string");
  if (execLines.length !== rawExec.length) {
    logInfo(
      "qa",
      "Ignoring --exec flag(s) given without a value (e.g. a trailing --exec with nothing after it).",
    );
  }

  const specs = await loadFleetFromConfig();
  if (specs.length === 0) {
    logInfo(
      "qa",
      "No stations to simulate — configure MANIFEST_FILE and/or ONCE_API_URL/ONCE_API_KEY.",
    );
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

  const commands = await loadCommands();
  const context: CommandContext = { stations, shutdown };
  await runExecLines(execLines, context, commands);
  if (!shuttingDown) {
    startInteractiveConsole(context, commands);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
