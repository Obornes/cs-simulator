import * as dotenv from "dotenv";

dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH ?? ".env.stress",
});

import { OcppVersion } from "./src/ocppVersion";
import { bootNotificationOcppMessage } from "./src/v16/messages/bootNotification";
import { startTransactionOcppMessage } from "./src/v16/messages/startTransaction";
import { stopTransactionOcppMessage } from "./src/v16/messages/stopTransaction";
import { VCP } from "./src/vcp";

/**
 * SYS-739 — Stress test script for ONCE / OREVE platform.
 *
 * Each VCP:
 *   1. Connects via WebSocket
 *   2. Sends BootNotification
 *   3. Sends StartTransaction
 *   4. Waits for transactionId
 *   5. Waits DURATION_MS
 *   6. Sends StopTransaction
 *   7. Script exits only after all VCP tasks are completed
 *
 * Env vars:
 *   WS_URL          WebSocket endpoint
 *   CP_COUNT        Number of VCPs to launch
 *   ID_PREFIX       Charge point ID base prefix, example: FR*ORV*CS
 *   ID_WIDTH        Numeric suffix width, example: 4 => 0001, 0010
 *   PASSWORD        Optional shared password
 *   RFID_TAG        RFID token
 *   STAGGER_MS      Delay between VCP launches
 *   START_DELAY_MS  Delay between BootNotification and StartTransaction
 *   DURATION_MS     Session duration before StopTransaction
 *   POLL_MS         Polling interval for transactionId
 *   POLL_TIMEOUT    Max wait time for transactionId
 *   STOP_SETTLE_MS  Small delay after StopTransaction before completing task
 */

function parseNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);

  if (Number.isNaN(parsed)) {
    console.warn(
      `[ENV] ${name}="${raw}" is not a valid number. Using default=${defaultValue}`,
    );
    return defaultValue;
  }

  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildChargePointId(prefix: string, index: number, width: number): string {
  return `${prefix}${String(index).padStart(width, "0")}`;
}

function buildPassword(chargePointId: string, sharedPassword?: string): string {
  if (sharedPassword) {
    return sharedPassword;
  }

  return `ocpp_password_${chargePointId.replace(/\*/g, "_")}`;
}

/**
 * Wait until transactionManager has a transaction for connectorId,
 * then return its transactionId.
 *
 * Returns null if timeout is reached.
 */
async function waitForTransactionId(
  vcp: VCP,
  connectorId: number,
  pollMs: number,
  timeoutMs: number,
): Promise<string | number | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const match = Array.from(vcp.transactionManager.transactions.values()).find(
      (transaction) => transaction.connectorId === connectorId,
    );

    if (match) {
      return match.transactionId;
    }

    await sleep(pollMs);
  }

  return null;
}

async function runVcp(params: {
  chargePointId: string;
  password: string;
  endpoint: string;
  rfidTag: string;
  durationMs: number;
  pollMs: number;
  pollTimeout: number;
  startDelayMs: number;
  stopSettleMs: number;
}): Promise<void> {
  const {
    chargePointId,
    password,
    endpoint,
    rfidTag,
    durationMs,
    pollMs,
    pollTimeout,
    startDelayMs,
    stopSettleMs,
  } = params;

  const autoStop = durationMs > 0;

  const vcp = new VCP({
    endpoint,
    chargePointId,
    ocppVersion: OcppVersion.OCPP_1_6,
    basicAuthPassword: password,
  });

  console.log(`[${chargePointId}] Connecting to ${endpoint}`);

  await vcp.connect();

  console.log(`[${chargePointId}] Connected. Sending BootNotification`);

  vcp.send(
    bootNotificationOcppMessage.request({
      chargePointVendor: "Solidstudio",
      chargePointModel: "VirtualChargePoint",
      chargePointSerialNumber: chargePointId,
      firmwareVersion: "1.0.0",
    }),
  );

  if (startDelayMs > 0) {
    console.log(
      `[${chargePointId}] Waiting ${startDelayMs}ms before StartTransaction`,
    );
    await sleep(startDelayMs);
  }

  console.log(`[${chargePointId}] Sending StartTransaction`);

  vcp.send(
    startTransactionOcppMessage.request({
      connectorId: 1,
      idTag: rfidTag,
      meterStart: 0,
      timestamp: new Date().toISOString(),
    }),
  );

  const transactionId = await waitForTransactionId(vcp, 1, pollMs, pollTimeout);

  if (transactionId === null) {
    console.warn(
      `[${chargePointId}] No transactionId after ${pollTimeout}ms. ` +
        `StartTransaction may have been rejected. Skipping StopTransaction.`,
    );
    return;
  }

  const numericTransactionId = Number(transactionId);

  if (Number.isNaN(numericTransactionId)) {
    console.warn(
      `[${chargePointId}] Invalid transactionId="${transactionId}". ` +
        `Skipping StopTransaction.`,
    );
    return;
  }

  console.log(
    `[${chargePointId}] Session started. transactionId=${numericTransactionId}`,
  );

  if (!autoStop) {
    console.log(
      `[${chargePointId}] DURATION_MS=0, session will stay open until manual stop / Ctrl+C`,
    );
    return;
  }

  console.log(
    `[${chargePointId}] Waiting ${durationMs}ms before StopTransaction`,
  );

  await sleep(durationMs);

  const meterStopRaw = vcp.transactionManager.getMeterValue(numericTransactionId);
  const meterStop = Math.round(Number(meterStopRaw) || 0);

  console.log(
    `[${chargePointId}] Sending StopTransaction. transactionId=${numericTransactionId}, meterStop=${meterStop}`,
  );

  vcp.send(
    stopTransactionOcppMessage.request({
      transactionId: numericTransactionId,
      idTag: rfidTag,
      meterStop,
      timestamp: new Date().toISOString(),
      reason: "Local",
    }),
  );

  if (stopSettleMs > 0) {
    await sleep(stopSettleMs);
  }

  console.log(`[${chargePointId}] Completed`);
}

async function main(): Promise<void> {
  const endpoint = process.env.WS_URL ?? "ws://localhost:5555";

  const chargePointsCount = parseNumberEnv("CP_COUNT", 10);
  const chargePointIdPrefix = process.env.ID_PREFIX ?? "CS_2_";
  const idWidth = parseNumberEnv("ID_WIDTH", 0);

  const rfidTag = process.env.RFID_TAG ?? "TEST";
  const staggerMs = parseNumberEnv("STAGGER_MS", 1500);
  const startDelayMs = parseNumberEnv("START_DELAY_MS", 0);
  const durationMs = parseNumberEnv("DURATION_MS", 300000);
  const pollMs = parseNumberEnv("POLL_MS", 500);
  const pollTimeout = parseNumberEnv("POLL_TIMEOUT", 30000);
  const stopSettleMs = parseNumberEnv("STOP_SETTLE_MS", 3000);
  const sharedPassword = process.env.PASSWORD || undefined;

  console.log("Loaded stress configuration:", {
    WS_URL: endpoint,
    CP_COUNT: chargePointsCount,
    ID_PREFIX: chargePointIdPrefix,
    ID_WIDTH: idWidth,
    RFID_TAG: rfidTag,
    STAGGER_MS: staggerMs,
    START_DELAY_MS: startDelayMs,
    DURATION_MS: durationMs,
    POLL_MS: pollMs,
    POLL_TIMEOUT: pollTimeout,
    STOP_SETTLE_MS: stopSettleMs,
    PASSWORD_MODE: sharedPassword ? "shared PASSWORD" : "per-VCP password",
  });

  const tasks: Promise<void>[] = [];

  for (let i = 1; i <= chargePointsCount; i++) {
    const chargePointId =
      idWidth > 0
        ? buildChargePointId(chargePointIdPrefix, i, idWidth)
        : `${chargePointIdPrefix}${i}`;

    const password = buildPassword(chargePointId, sharedPassword);

    console.log(
      `[${i}/${chargePointsCount}] Launching ${chargePointId} with password=${password}`,
    );

    const task = runVcp({
      chargePointId,
      password,
      endpoint,
      rfidTag,
      durationMs,
      pollMs,
      pollTimeout,
      startDelayMs,
      stopSettleMs,
    }).catch((error) => {
      console.error(`[${chargePointId}] Failed`, error);
      throw error;
    });

    tasks.push(task);

    if (i < chargePointsCount && staggerMs > 0) {
      await sleep(staggerMs);
    }
  }

  console.log(`All ${chargePointsCount} VCPs launched. Waiting for completion...`);

  const results = await Promise.allSettled(tasks);

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  console.log("Stress test summary:", {
    total: results.length,
    succeeded: fulfilled.length,
    failed: rejected.length,
  });

  if (rejected.length > 0) {
    process.exit(1);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("Fatal error in stress test script", error);
  process.exit(1);
});