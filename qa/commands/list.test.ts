import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { OcppVersion } from "../../src/ocppVersion";
import type { CommandContext } from "./command";
import type { StationSpec } from "../manifest";
import { Station } from "../station";
import ListCommand from "./list";

function spec(overrides: Partial<StationSpec> = {}): StationSpec {
  return {
    id: "SIM-0001",
    ocppVersion: OcppVersion.OCPP_1_6,
    evses: [{ id: 1, connectorIds: [1] }],
    ...overrides,
  };
}

function context(stations: Station[]): CommandContext {
  return { stations, shutdown: () => {} };
}

describe("ListCommand", () => {
  let originalLog: typeof console.log;
  let lines: string[];
  const command = new ListCommand();

  beforeEach(() => {
    originalLog = console.log;
    lines = [];
    console.log = (line: string) => {
      lines.push(line);
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test("prints one row per connector, EVSE=N/A for 1.6, POOL=N/A when unset", () => {
    const station16 = new Station(
      spec({ id: "SIM-0007", evses: [{ id: 1, connectorIds: [1, 2] }] }),
    );
    const station201 = new Station(
      spec({
        id: "MULTI-0001",
        ocppVersion: OcppVersion.OCPP_2_0_1,
        evses: [{ id: 3, connectorIds: [1] }],
        pool: { id: "SITE-42", name: "Site 42" },
      }),
    );
    const stationPoolIdOnly = new Station(
      spec({
        id: "POOL-ID-ONLY",
        ocppVersion: OcppVersion.OCPP_2_0_1,
        evses: [{ id: 1, connectorIds: [1] }],
        pool: { id: "SITE-99" },
      }),
    );

    command.execute([], context([station16, station201, stationPoolIdOnly]));

    const body = lines.slice(1); // drop the header row
    assert.equal(body.length, 4); // 2 connectors on SIM-0007 + 1 each on the other two

    assert.match(
      body[0],
      /SIM-0007\s+N\/A\s+1\s+disconnected\s+available\s+OCPP_1\.6\s+N\/A/,
    );
    assert.match(
      body[1],
      /SIM-0007\s+N\/A\s+2\s+disconnected\s+available\s+OCPP_1\.6\s+N\/A/,
    );
    assert.match(
      body[2],
      /MULTI-0001\s+3\s+1\s+disconnected\s+available\s+OCPP_2\.0\.1\s+Site 42/,
    );
    assert.match(
      body[3],
      /POOL-ID-ONLY\s+1\s+1\s+disconnected\s+available\s+OCPP_2\.0\.1\s+SITE-99/,
    );
  });

  test("--connection-status filters out non-matching stations entirely", () => {
    const connected = new Station(spec({ id: "CONNECTED-ONE" }));
    connected.state = "connected";
    const disconnected = new Station(spec({ id: "DISCONNECTED-ONE" }));

    command.execute(
      ["--connection-status=connected"],
      context([connected, disconnected]),
    );

    const body = lines.slice(1);
    assert.equal(body.length, 1);
    assert.match(body[0], /CONNECTED-ONE/);
  });

  test("--connector-status accepts comma-separated values (OR within the flag)", () => {
    const station = new Station(
      spec({ id: "MULTI-CONN", evses: [{ id: 1, connectorIds: [1, 2, 3] }] }),
    );
    // biome-ignore lint/style/noNonNullAssertion: test setup, connectors always populated
    station.connectors.get("1:1")!.status = "charging";
    // biome-ignore lint/style/noNonNullAssertion: test setup, connectors always populated
    station.connectors.get("1:2")!.status = "preparing";
    // biome-ignore lint/style/noNonNullAssertion: test setup, connectors always populated
    station.connectors.get("1:3")!.status = "available";

    command.execute(
      ["--connector-status=charging,preparing"],
      context([station]),
    );

    const body = lines.slice(1);
    assert.equal(body.length, 2);
    assert.ok(body.every((line) => !/available/.test(line)));
  });

  test("combines connection-status and connector-status with AND", () => {
    const disconnectedButChargingStale = new Station(spec({ id: "STALE" }));
    // biome-ignore lint/style/noNonNullAssertion: test setup, connectors always populated
    disconnectedButChargingStale.connectors.get("1:1")!.status = "charging";
    // station.state stays "disconnected" — a charging connector on a disconnected station

    const connectedAndCharging = new Station(spec({ id: "LIVE" }));
    connectedAndCharging.state = "connected";
    // biome-ignore lint/style/noNonNullAssertion: test setup, connectors always populated
    connectedAndCharging.connectors.get("1:1")!.status = "charging";

    command.execute(
      ["--connection-status=connected", "--connector-status=charging"],
      context([disconnectedButChargingStale, connectedAndCharging]),
    );

    const body = lines.slice(1);
    assert.equal(body.length, 1);
    assert.match(body[0], /LIVE/);
  });

  test("--pool-id filters by pool id; a pool-less station never matches an active filter", () => {
    const withPool = new Station(
      spec({
        id: "HAS-POOL",
        ocppVersion: OcppVersion.OCPP_2_0_1,
        pool: { id: "SITE-42" },
      }),
    );
    const withoutPool = new Station(spec({ id: "NO-POOL" }));

    command.execute(["--pool-id=SITE-42"], context([withPool, withoutPool]));

    const body = lines.slice(1);
    assert.equal(body.length, 1);
    assert.match(body[0], /HAS-POOL/);
  });

  test("an unknown flag prints a usage error and produces no rows", () => {
    const station = new Station(spec());

    command.execute(["--bogus=1"], context([station]));

    assert.equal(lines.length, 1);
    assert.match(lines[0], /Unknown flag "--bogus"/);
    assert.match(lines[0], new RegExp(command.usage.replace(/[[\]]/g, "\\$&")));
  });
});
