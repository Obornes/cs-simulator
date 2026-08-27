import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { OcppVersion, toProtocolVersion } from "../src/ocppVersion";
import { CONFIG } from "./config";
import type { StationSpec } from "./manifest";
import { logDebug, logInfo } from "./stats";

// docs/fleet-loader-spec.md §6.1 — a fresh, connector-aware Station, not a copy of
// demo/station.ts, but deliberately mirroring its connection-lifecycle/send-plumbing shape
// (connect/disconnect/destroy, staggered jittered reconnect, pendingCalls-keyed send) for
// consistency across the two tools.

export type ConnectionState = "disconnected" | "connecting" | "connected";
export type ConnectorStatus =
  | "available"
  | "preparing"
  | "charging"
  | "finishing";

function connectorKey(evseId: number, connectorId: number): string {
  return `${evseId}:${connectorId}`;
}

export interface ConnectorRuntime {
  evseId: number;
  connectorId: number;
  status: ConnectorStatus;
  // No `session` field yet — charging sessions are the next slice (§6.1's remaining
  // bullets: tick(), startChargingSession, RemoteStart/Stop handlers). Every connector is
  // "available" for as long as that doesn't exist.
}

interface PendingCall {
  resolve: (payload: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_MIN_MS = 10_000;
const RECONNECT_MAX_MS = 60_000;
const CALL_TIMEOUT_MS = 30_000;

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export class Station {
  readonly spec: StationSpec;
  state: ConnectionState = "disconnected";
  connectors: Map<string, ConnectorRuntime>;

  private ws: WebSocket | null = null;
  private pendingCalls = new Map<string, PendingCall>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
  private destroyed = false;
  private intentionalDisconnect = false;

  constructor(spec: StationSpec) {
    this.spec = spec;
    this.connectors = new Map(
      spec.evses.flatMap((evse) =>
        evse.connectorIds.map(
          (connectorId) =>
            [
              connectorKey(evse.id, connectorId),
              { evseId: evse.id, connectorId, status: "available" as const },
            ] as const,
        ),
      ),
    );
  }

  get id(): string {
    return this.spec.id;
  }

  // --- connection lifecycle (mirrors demo/station.ts:connect/disconnect/destroy) ---

  connect(): void {
    if (this.destroyed) {
      return;
    }
    this.clearReconnectTimer();
    this.state = "connecting";

    let ws: WebSocket;
    try {
      ws = new WebSocket(`${CONFIG.wsUrl}/${this.spec.id}`, [
        toProtocolVersion(this.spec.ocppVersion),
      ]);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      logDebug(this.id, "WebSocket connected");
      this.boot().catch((err) => logDebug(this.id, `boot failed: ${err}`));
    });
    ws.on("message", (data) => this.handleMessage(data.toString()));
    ws.on("close", () => {
      this.cleanupOnClose();
      if (!this.destroyed && !this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
      this.intentionalDisconnect = false;
    });
    ws.on("error", () => {
      // "close" always follows "error" on `ws` — reconnect scheduling lives there.
    });
  }

  disconnect(intentional = false): void {
    this.intentionalDisconnect = intentional;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.state = "disconnected";
  }

  destroy(): void {
    this.destroyed = true;
    this.clearReconnectTimer();
    this.clearHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
  }

  private cleanupOnClose(): void {
    this.clearHeartbeat();
    // Resolve (rather than leave hanging) any call still awaiting a response when the
    // socket drops mid-flight — e.g. mid-boot — and cancel its now-pointless 30s fallback
    // timer instead of leaving it scheduled.
    for (const pending of this.pendingCalls.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
    this.pendingCalls.clear();
    this.ws = null;
    this.state = "disconnected";
  }

  private scheduleReconnect(): void {
    if (this.destroyed) {
      return;
    }
    this.state = "disconnected";
    const delay = randomBetween(RECONNECT_MIN_MS, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --- boot sequence (§6.1 "Boot sequence" bullet, §6.2 "Per-station boot sequence") ---

  private async boot(): Promise<void> {
    const bootResult = (await this.call(
      "BootNotification",
      bootNotificationPayload(this.spec),
    )) as { interval?: number } | null;
    if (
      bootResult &&
      typeof bootResult.interval === "number" &&
      bootResult.interval > 0
    ) {
      this.heartbeatIntervalMs = bootResult.interval * 1000;
    }

    for (const connector of this.connectors.values()) {
      await this.call(
        "StatusNotification",
        statusNotificationPayload(
          this.spec.ocppVersion,
          connector,
          "Available",
        ),
      );
    }

    this.state = "connected";
    this.heartbeatTimer = setInterval(
      () => this.call("Heartbeat", {}),
      this.heartbeatIntervalMs,
    );
    logInfo(
      this.id,
      `Connected (${this.connectors.size} connector${this.connectors.size === 1 ? "" : "s"})`,
    );
  }

  // --- send/receive plumbing (mirrors demo/station.ts's pattern) ---

  private call(action: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve(null);
        return;
      }
      const msgId = randomUUID();
      logDebug(this.id, `>>> ${action}`);
      // Stored on the pending entry so a normal response (or a close) can cancel it —
      // otherwise it keeps firing (and keeping the event loop alive) 30s after the call
      // already resolved.
      const timeout = setTimeout(() => {
        if (this.pendingCalls.delete(msgId)) {
          resolve(null);
        }
      }, CALL_TIMEOUT_MS);
      this.pendingCalls.set(msgId, { resolve, timeout });
      try {
        this.ws.send(JSON.stringify([2, msgId, action, payload]));
      } catch {
        this.pendingCalls.delete(msgId);
        clearTimeout(timeout);
        resolve(null);
      }
    });
  }

  private respondError(
    msgId: string,
    errorCode: string,
    description: string,
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.ws.send(JSON.stringify([4, msgId, errorCode, description, {}]));
    } catch {
      // ignore
    }
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || parsed.length < 3) {
      return;
    }

    const messageType = parsed[0];

    // CallResult [3, msgId, payload]
    if (messageType === 3) {
      const [, msgId, payload] = parsed;
      const pending = this.pendingCalls.get(msgId as string);
      if (pending) {
        this.pendingCalls.delete(msgId as string);
        clearTimeout(pending.timeout);
        pending.resolve(payload);
      }
      return;
    }

    // CallError [4, msgId, errorCode, errorDescription, errorDetails]
    if (messageType === 4) {
      const [, msgId] = parsed;
      const pending = this.pendingCalls.get(msgId as string);
      if (pending) {
        this.pendingCalls.delete(msgId as string);
        clearTimeout(pending.timeout);
        pending.resolve(null);
      }
      return;
    }

    // Call [2, msgId, action, payload] — incoming from the CSMS. No charge-point-initiated
    // session/remote-command handling yet (§6.1's remaining bullets), so every incoming
    // Call is protocol-acknowledged as unimplemented rather than left to hang.
    if (messageType === 2 && parsed.length >= 4) {
      const [, msgId, action] = parsed as [number, string, string, unknown];
      logDebug(this.id, `<<< Incoming: ${action} (not implemented yet)`);
      this.respondError(msgId, "NotImplemented", `${action} not supported yet`);
    }
  }
}

function bootNotificationPayload(spec: StationSpec): unknown {
  if (spec.ocppVersion === OcppVersion.OCPP_1_6) {
    return {
      chargePointVendor: "Solidstudio",
      chargePointModel: "VirtualCP",
      chargePointSerialNumber: spec.id,
      firmwareVersion: "1.0.0",
    };
  }
  return {
    reason: "PowerUp",
    chargingStation: {
      vendorName: "Solidstudio",
      model: "VirtualCP",
      serialNumber: spec.id,
      firmwareVersion: "1.0.0",
    },
  };
}

// §6.1 "Wire-level calls stay version-aware" — 1.6 never carries `evseId` on the wire;
// 2.0.1/2.1 always carry both.
function statusNotificationPayload(
  ocppVersion: OcppVersion,
  connector: ConnectorRuntime,
  status: string,
): unknown {
  if (ocppVersion === OcppVersion.OCPP_1_6) {
    return {
      connectorId: connector.connectorId,
      errorCode: "NoError",
      status,
      timestamp: new Date().toISOString(),
    };
  }
  return {
    timestamp: new Date().toISOString(),
    connectorStatus: status,
    evseId: connector.evseId,
    connectorId: connector.connectorId,
  };
}
