import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { WebSocketServer } from "ws";
import { OcppVersion } from "../src/ocppVersion";
import { CONFIG } from "./config";
import type { StationSpec } from "./manifest";
import { Station } from "./station";

function spec(overrides: Partial<StationSpec> = {}): StationSpec {
  return {
    id: "SIM-0001",
    ocppVersion: OcppVersion.OCPP_2_0_1,
    evses: [{ id: 1, connectorIds: [1] }],
    ...overrides,
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface TestServer {
  server: WebSocketServer;
  frames: unknown[][];
  close: () => Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const frames: unknown[][] = [];
  server.on("connection", (ws) => {
    ws.on("message", (data) => {
      const parsed = JSON.parse(data.toString());
      frames.push(parsed);
      // Auto-respond to every Call from the station, like a real CSMS would.
      if (parsed[0] === 2) {
        const [, msgId, action] = parsed;
        const response =
          action === "BootNotification"
            ? { status: "Accepted", interval: 300 }
            : {};
        ws.send(JSON.stringify([3, msgId, response]));
      }
    });
  });

  const address = server.address() as { port: number };
  CONFIG.wsUrl = `ws://localhost:${address.port}`;

  return {
    server,
    frames,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const client of server.clients) {
          client.terminate();
        }
      }),
  };
}

describe("Station", () => {
  let originalWsUrl: string;
  let activeStation: Station | undefined;
  let activeServer: TestServer | undefined;

  beforeEach(() => {
    originalWsUrl = CONFIG.wsUrl;
  });

  afterEach(async () => {
    activeStation?.destroy();
    activeStation = undefined;
    await activeServer?.close();
    activeServer = undefined;
    CONFIG.wsUrl = originalWsUrl;
  });

  test("builds one connector per (evseId, connectorId) from spec.evses", () => {
    const station = new Station(
      spec({
        evses: [
          { id: 1, connectorIds: [1] },
          { id: 2, connectorIds: [1, 2] },
        ],
      }),
    );
    activeStation = station;

    assert.deepEqual(Array.from(station.connectors.keys()).sort(), [
      "1:1",
      "2:1",
      "2:2",
    ]);
    assert.deepEqual(station.connectors.get("2:2"), {
      evseId: 2,
      connectorId: 2,
      status: "available",
    });
  });

  test("boots: BootNotification then one StatusNotification per connector, evseId included (2.0.1)", async () => {
    activeServer = await startTestServer();

    const station = new Station(
      spec({
        evses: [
          { id: 1, connectorIds: [1] },
          { id: 2, connectorIds: [1, 2] },
        ],
      }),
    );
    activeStation = station;
    station.connect();

    await waitUntil(() => station.state === "connected");

    const calls = activeServer.frames.filter((f) => f[0] === 2) as [
      number,
      string,
      string,
      Record<string, unknown>,
    ][];
    assert.equal(calls.length, 4); // 1 BootNotification + 3 StatusNotification
    assert.equal(calls[0][2], "BootNotification");
    assert.deepEqual(
      calls.slice(1).map((c) => [c[2], c[3].evseId, c[3].connectorId]),
      [
        ["StatusNotification", 1, 1],
        ["StatusNotification", 2, 1],
        ["StatusNotification", 2, 2],
      ],
    );
  });

  test("OCPP 1.6 StatusNotification omits evseId", async () => {
    activeServer = await startTestServer();

    const station = new Station(
      spec({
        ocppVersion: OcppVersion.OCPP_1_6,
        evses: [{ id: 1, connectorIds: [1] }],
      }),
    );
    activeStation = station;
    station.connect();

    await waitUntil(() => station.state === "connected");

    const statusCall = activeServer.frames.find(
      (f) => f[2] === "StatusNotification",
    ) as [number, string, string, Record<string, unknown>];
    assert.equal("evseId" in statusCall[3], false);
    assert.equal(statusCall[3].connectorId, 1);
  });

  test("responds NotImplemented to an unhandled incoming Call", async () => {
    activeServer = await startTestServer();

    const station = new Station(spec());
    activeStation = station;
    station.connect();
    await waitUntil(() => station.state === "connected");

    const serverSocket = Array.from(activeServer.server.clients)[0];
    serverSocket.send(
      JSON.stringify([2, "srv-msg-1", "SomeUnhandledAction", {}]),
    );

    await waitUntil(() =>
      (activeServer?.frames ?? []).some(
        (f) => f[0] === 4 && f[1] === "srv-msg-1",
      ),
    );
    const errorFrame = activeServer.frames.find(
      (f) => f[0] === 4 && f[1] === "srv-msg-1",
    );
    assert.equal(errorFrame?.[2], "NotImplemented");
  });

  test("destroy() prevents any further connect() from doing anything", async () => {
    activeServer = await startTestServer();

    const station = new Station(spec());
    activeStation = station;
    station.connect();
    await waitUntil(() => station.state === "connected");

    station.destroy();
    await waitUntil(() => station.state === "disconnected");

    const framesBeforeRetry = activeServer.frames.length;
    station.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(station.state, "disconnected");
    assert.equal(activeServer.frames.length, framesBeforeRetry);
  });
});
