require("dotenv").config();

import * as uuid from "uuid";

import { OcppVersion } from "./src/ocppVersion";
import { TransactionManager } from "./src/transactionManager";
import { bootNotificationOcppMessage } from "./src/v16/messages/bootNotification";
import { startTransactionOcppMessage } from "./src/v16/messages/startTransaction";
import { stopTransactionOcppMessage } from "./src/v16/messages/stopTransaction";
import { VCP } from "./src/vcp";

/**
 * SYS-739 — Stress test script for ONCE/OREVE platform.
 *
 * Supports:
 *   - one RFID for all VCPs via RFID_TAG
 *   - multiple RFIDs via RFID_TAGS=token1,token2,token3
 *
 * With CP_COUNT=2 and RFID_TAGS=ST-202xxx,ST-202yyy:
 *   ZZ_1_1 -> ST-202xxx
 *   ZZ_1_2 -> ST-202yyy
 *
 * If CP_COUNT is greater than RFID_TAGS count, the script reuses tokens in round-robin.
 * To avoid reuse, set RFID_TAG_REUSE=false.
 */

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIntegerEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be a valid integer. Received: ${rawValue}`);
  }

  return parsed;
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const rawValue = process.env[name];
  if (!rawValue) {
    return defaultValue;
  }

  return ["true", "1", "yes", "y"].includes(rawValue.trim().toLowerCase());
}

function parseCsvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildChargePointId(prefix: string, index: number, idWidth: number): string {
  return `${prefix}${index.toString().padStart(idWidth, "0")}`;
}

function getRfidTagForVcp(
  vcpIndex: number,
  fallbackRfidTag: string,
  rfidTags: string[],
  allowReuse: boolean,
): string {
  if (rfidTags.length === 0) {
    return fallbackRfidTag;
  }

  const tokenIndex = vcpIndex - 1;

  if (!allowReuse && tokenIndex >= rfidTags.length) {
    throw new Error(
      `RFID_TAG_REUSE=false but CP_COUNT is greater than RFID_TAGS count. ` +
      `Missing RFID token for VCP index ${vcpIndex}.`,
    );
  }

  return rfidTags[tokenIndex % rfidTags.length];
}

/**
 * Wait until transactionManager has a transaction for connectorId=1,
 * then return its transactionId.
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

    if (match?.transactionId !== undefined && match?.transactionId !== null) {
      return match.transactionId;
    }

    await sleep(pollMs);
  }

  return null;
}

(async () => {
  TransactionManager.START_INTERVAL = false;

  const chargePointsCount = parseIntegerEnv("CP_COUNT", 10);
  const chargePointIdPrefix = process.env.ID_PREFIX ?? "CS_2_";
  const idWidth = parseIntegerEnv("ID_WIDTH", 1);

  const fallbackRfidTag = process.env.RFID_TAG ?? "TEST";
  const rfidTags = parseCsvEnv("RFID_TAGS");
  const allowRfidReuse = parseBooleanEnv("RFID_TAG_REUSE", true);

  const staggerMs = parseIntegerEnv("STAGGER_MS", 5000);
  const startDelayMs = parseIntegerEnv("START_DELAY_MS", 0);
  const durationMs = parseIntegerEnv("DURATION_MS", 300000);
  const pollMs = parseIntegerEnv("POLL_MS", 500);
  const pollTimeout = parseIntegerEnv("POLL_TIMEOUT", 30000);
  const meterIntervalMs = parseIntegerEnv("METER_INTERVAL_MS", 30000);
  const stopSettleMs = parseIntegerEnv("STOP_SETTLE_MS", 3000);
  const sharedPassword = process.env.PASSWORD ?? undefined;

  console.log(
    `Starting stress test: ${chargePointsCount} VCPs, ` +
    `prefix="${chargePointIdPrefix}", idWidth=${idWidth}, ` +
    `RFID mode=${rfidTags.length > 0 ? "RFID_TAGS" : "RFID_TAG"}, ` +
    `RFID count=${rfidTags.length || 1}, RFID reuse=${allowRfidReuse}, ` +
    `duration=${durationMs}ms`,
  );

  if (rfidTags.length > 0) {
    console.log("RFID assignment preview:");
    for (let i = 1; i <= Math.min(chargePointsCount, 10); i++) {
      const chargePointId = buildChargePointId(chargePointIdPrefix, i, idWidth);
      const rfidTag = getRfidTagForVcp(i, fallbackRfidTag, rfidTags, allowRfidReuse);
      console.log(`  ${chargePointId} -> ${rfidTag}`);
    }
    if (chargePointsCount > 10) {
      console.log(`  ... ${chargePointsCount - 10} more VCPs`);
    }
  }

  for (let i = 1; i <= chargePointsCount; i++) {
    const chargePointId = buildChargePointId(chargePointIdPrefix, i, idWidth);
    const rfidTag = getRfidTagForVcp(
      i,
      fallbackRfidTag,
      rfidTags,
      allowRfidReuse,
    );

    await connectToVCP({
      chargePointId,
      pollMs,
      pollTimeout,
      durationMs,
      meterIntervalMs,
      stopSettleMs,
      startDelayMs,
      sharedPassword,
      rfidTag,
    });

    await sleep(staggerMs);
  }

  const totalWaitMs =
    chargePointsCount * staggerMs + pollTimeout + durationMs * 1.2 + 60_000;

  console.log(
    `All VCPs launched. Process will exit in ~${Math.ceil(totalWaitMs / 1000)}s ` +
    `once all sessions complete.`,
  );

  await sleep(totalWaitMs);
  console.log("✓ Stress test script finished.");
  process.exit(0);
})();

async function connectToVCP({
  chargePointId,
  pollMs,
  pollTimeout,
  durationMs,
  meterIntervalMs,
  stopSettleMs,
  startDelayMs,
  sharedPassword,
  rfidTag,
  transactionId = null,
  sessionStartedAt = null,
}: {
  chargePointId: string;
  pollMs: number;
  pollTimeout: number;
  durationMs: number;
  meterIntervalMs: number;
  stopSettleMs: number;
  startDelayMs: number;
  sharedPassword: string | undefined;
  rfidTag: string;
  transactionId?: string | number | null;
  sessionStartedAt?: Date | null;
}) {
  let sessionGateResolve!: () => void;
  const sessionGate = new Promise<void>((resolve) => {
    sessionGateResolve = resolve;
  });

  const password =
    sharedPassword ?? `ocpp_password_${chargePointId.replace(/\*/g, "_")}`;

  const vcp = new VCP({
    endpoint: process.env.WS_URL ?? "ws://localhost:5555",
    chargePointId,
    ocppVersion: OcppVersion.OCPP_1_6,
    basicAuthPassword: password,
  });

  vcp
    .connect(() => {
      console.warn(`[${chargePointId}] disconnected. Reconnecting...`);
      connectToVCP({
        chargePointId,
        pollMs,
        pollTimeout,
        durationMs,
        meterIntervalMs,
        stopSettleMs,
        startDelayMs,
        sharedPassword,
        rfidTag,
        transactionId,
        sessionStartedAt,
      });
    })
    .then(async () => {
      vcp.send(
        bootNotificationOcppMessage.request({
          chargePointVendor: "Solidstudio",
          chargePointModel: "VirtualChargePoint",
          chargePointSerialNumber: "S001",
          firmwareVersion: "1.0.0",
        }),
      );

      if (startDelayMs > 0) {
        await sleep(startDelayMs);
      }

      if (transactionId === null) {
        vcp.send(
          startTransactionOcppMessage.request({
            connectorId: 1,
            idTag: rfidTag,
            meterStart: 0,
            timestamp: new Date().toISOString(),
          }),
        );

        transactionId = await waitForTransactionId(vcp, 1, pollMs, pollTimeout);

        if (transactionId === null) {
          console.warn(
            `[${chargePointId}] ⚠️ No transactionId after ${pollTimeout}ms. ` +
            `RFID=${rfidTag}. StartTransaction may have been rejected. ` +
            `Skipping MeterValues and StopTransaction.`,
          );
          sessionGateResolve();
          return;
        }

        sessionStartedAt = new Date();

        console.log(
          `[${chargePointId}] ✓ Session started. ` +
          `RFID=${rfidTag}, transactionId=${transactionId}. ` +
          `Will stop in ${durationMs}ms.`,
        );
      }

      sessionGateResolve();

      if (!sessionStartedAt || transactionId === null) {
        return;
      }

      const deadline = sessionStartedAt.getTime() + durationMs;

      while (Date.now() < deadline) {
        const waitMs = Math.min(meterIntervalMs, deadline - Date.now());
        await sleep(waitMs);

        if (Date.now() >= deadline || vcp.isFinishing) {
          break;
        }

        try {
          vcp.send({
            messageId: uuid.v4(),
            action: "MeterValues",
            payload: {
              connectorId: 1,
              transactionId,
              meterValue: [
                {
                  timestamp: new Date().toISOString(),
                  sampledValue: [
                    {
                      value: (
                        (Date.now() - sessionStartedAt.getTime()) /
                        100
                      ).toString(),
                      measurand: "Energy.Active.Import.Register",
                      unit: "Wh",
                    },
                  ],
                },
              ],
            },
          });
        } catch (error) {
          console.error(`[${chargePointId}] Failed to send MeterValues`, error);
          break;
        }
      }

      if (vcp.isFinishing || transactionId === null) {
        return;
      }

      const meterStop = Math.round(
        (Date.now() - sessionStartedAt.getTime()) / 100,
      );

      console.log(
        `[${chargePointId}] Sending StopTransaction. ` +
        `RFID=${rfidTag}, transactionId=${transactionId}, meterStop=${meterStop}`,
      );

      try {
        vcp.send(
          stopTransactionOcppMessage.request({
            transactionId: transactionId as number,
            idTag: rfidTag,
            meterStop,
            timestamp: new Date().toISOString(),
            reason: "Local",
          }),
        );

        if (stopSettleMs > 0) {
          await sleep(stopSettleMs);
        }
      } catch (error) {
        console.error(`[${chargePointId}] Failed to send StopTransaction`, error);
      }
    })
    .catch((error) => {
      console.error(`[${chargePointId}] Failed to connect or run VCP`, error);
      sessionGateResolve();
    });

  console.log(`[${chargePointId}] Waiting for session to start with RFID=${rfidTag}...`);
  await sessionGate;
}
