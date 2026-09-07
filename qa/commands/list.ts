import { OcppVersion } from "../../src/ocppVersion";
import { Command, type CommandContext } from "./command";

const FLAG_NAMES = [
  "connection-status",
  "connector-status",
  "pool-id",
  "protocol",
] as const;
type FlagName = (typeof FLAG_NAMES)[number];
type ParsedFilters = Record<FlagName, string[]>;

function parseFilters(args: string[]): ParsedFilters | { error: string } {
  const filters: ParsedFilters = {
    "connection-status": [],
    "connector-status": [],
    "pool-id": [],
    protocol: [],
  };

  for (const arg of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) {
      return { error: `Unrecognized argument "${arg}"` };
    }
    const [, flag, value] = match;
    if (!(FLAG_NAMES as readonly string[]).includes(flag)) {
      return { error: `Unknown flag "--${flag}"` };
    }
    filters[flag as FlagName] = value.split(",");
  }

  return filters;
}

function matchesFilter(values: string[], actual: string): boolean {
  return values.length === 0 || values.includes(actual);
}

const COLUMNS = [
  "STATION",
  "EVSE",
  "CONNECTOR",
  "CONN-STATUS",
  "CONNECTOR-STATUS",
  "PROTOCOL",
  "POOL",
];

function printTable(rows: string[][]): void {
  const widths = COLUMNS.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i].length)),
  );
  const formatRow = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] + 2)).join("");

  console.log(formatRow(COLUMNS));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

// docs/fleet-loader-spec.md §7.3.1 — the only implemented console command this iteration.
export default class ListCommand extends Command {
  readonly name = "list";
  readonly usage =
    "list [--connection-status=<v,...>] [--connector-status=<v,...>] [--pool-id=<v,...>] [--protocol=<v,...>]";

  execute(args: string[], context: CommandContext): void {
    const filters = parseFilters(args);
    if ("error" in filters) {
      console.log(`${filters.error}\nUsage: ${this.usage}`);
      return;
    }

    const rows: string[][] = [];
    for (const station of context.stations) {
      const poolIdForFilter = station.spec.pool?.id ?? "";
      const stationMatches =
        matchesFilter(filters.protocol, station.spec.ocppVersion) &&
        matchesFilter(filters["connection-status"], station.state) &&
        matchesFilter(filters["pool-id"], poolIdForFilter);
      if (!stationMatches) {
        continue;
      }

      for (const connector of station.connectors.values()) {
        if (!matchesFilter(filters["connector-status"], connector.status)) {
          continue;
        }
        const evseDisplay =
          station.spec.ocppVersion === OcppVersion.OCPP_1_6
            ? "N/A"
            : String(connector.evseId);
        const poolDisplay =
          station.spec.pool?.name ?? station.spec.pool?.id ?? "N/A";
        rows.push([
          station.id,
          evseDisplay,
          String(connector.connectorId),
          station.state,
          connector.status,
          station.spec.ocppVersion,
          poolDisplay,
        ]);
      }
    }

    printTable(rows);
  }
}
