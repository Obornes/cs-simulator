require("dotenv").config();

import { OcppVersion } from "./src/ocppVersion";
import { bootNotificationOcppMessage } from "./src/v16/messages/bootNotification";
import { startTransactionOcppMessage } from "./src/v16/messages/startTransaction";
import { stopTransactionOcppMessage } from "./src/v16/messages/stopTransaction";
import { VCP } from "./src/vcp";

/**
 * SYS-739 — Stress test script (patched for ONCE/OREVE platform).
 *
 * Each VCP:
 *   1. Connects via WebSocket
 *   2. Sends BootNotification
 *   3. Sends StartTransaction
 *   4. Waits for the StartTransaction response (polls transactionManager)
 *   5. After DURATION_MS, sends StopTransaction with the captured transactionId
 *   6. Process exits cleanly once all VCPs have stopped
 *
 * Env vars:
 *   WS_URL        WebSocket endpoint (e.g. wss://server.16.ocpp.int.oreve.com)
 *   CP_COUNT      Number of VCPs to launch (default 10)
 *   ID_PREFIX     Charge point ID prefix (default "CS_2_")
 *   PASSWORD      Optional: single shared password. If not set, uses per-VCP password:
 *                   ocpp_password_{chargePointId}
 *   RFID_TAG      RFID token for StartTransaction (default "TEST")
 *   STAGGER_MS    Delay between VCP connections in ms (default 100)
 *   DURATION_MS   How long each session runs before StopTransaction is sent
 *                   (default 300000 = 5 min | set to 0 to disable auto-stop)
 *   POLL_MS       How often to poll for transactionId after StartTransaction (default 500)
 *   POLL_TIMEOUT  Max ms to wait for transactionId before giving up (default 30000)
 */

/**
 * Wait until transactionManager has a transaction for connectorId=1,
 * then return its transactionId.
 * Returns null if timeout is reached (e.g. StartTransaction was rejected).
 */
async function waitForTransactionId(
  vcp: VCP,
  connectorId: number,
  pollMs: number,
  timeoutMs: number,
): Promise<string | number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // TransactionManager.transactions is a public Map<transactionId, TransactionState>
    // We find the transaction matching our connectorId
    const match = Array.from(vcp.transactionManager.transactions.values()).find(
      (t) => t.connectorId === connectorId,
    );
    if (match) {
      return match.transactionId;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

(async () => {
  const chargePointsCount = Number.parseInt(process.env.CP_COUNT ?? "10");
  const chargePointIdPrefix = process.env.ID_PREFIX ?? "CS_2_";
  const rfidTag = process.env.RFID_TAG ?? "TEST";
  const staggerMs = Number.parseInt(process.env.STAGGER_MS ?? "5000");
  const durationMs = Number.parseInt(process.env.DURATION_MS ?? "300000");
  const pollMs = Number.parseInt(process.env.POLL_MS ?? "500");
  const pollTimeout = Number.parseInt(process.env.POLL_TIMEOUT ?? "30000");
  const sharedPassword = process.env.PASSWORD ?? undefined;
  const autoStop = durationMs > 0;

  console.log(
    `Starting stress test: ${chargePointsCount} VCPs, prefix="${chargePointIdPrefix}", ` +
    `idTag="${rfidTag}", duration=${autoStop ? `${durationMs}ms` : "manual (Ctrl+C to stop)"}`,
  );

  for (let i = 1; i <= chargePointsCount; i++) {
    const chargePointId = `${chargePointIdPrefix}${i}`;
    const password = sharedPassword ?? `ocpp_password_${chargePointId.replace(/\*/g, "_")}`;

    let sessionStartedRes: (value?: unknown) => void;
    const sessionStarted = new Promise((res) => {
      sessionStartedRes = res;
    });

    const vcp = new VCP({
      endpoint: process.env.WS_URL ?? "ws://localhost:5555",
      chargePointId,
      ocppVersion: OcppVersion.OCPP_1_6,
      basicAuthPassword: password,
    });

    vcp.connect().then(async () => {
      // 1 — BootNotification
      vcp.send(
        bootNotificationOcppMessage.request({
          chargePointVendor: "Solidstudio",
          chargePointModel: "VirtualChargePoint",
          chargePointSerialNumber: "S001",
          firmwareVersion: "1.0.0",
        }),
      );

      // 2 — StartTransaction
      const meterStart = 0;
      vcp.send(
        startTransactionOcppMessage.request({
          connectorId: 1,
          idTag: rfidTag,
          meterStart,
          timestamp: new Date().toISOString(),
        }),
      );

      if (!autoStop) return;

      // 3 — Wait for transactionId to appear in transactionManager
      // (populated by startTransaction resHandler once ONCE responds)
      const transactionId = await waitForTransactionId(vcp, 1, pollMs, pollTimeout);

      // Unblock outer loop so next VCP can start staggering — independent of StopTransaction.
      sessionStartedRes();

      if (transactionId === null) {
        console.warn(
          `[${chargePointId}] ⚠️  No transactionId after ${pollTimeout}ms — ` +
          `StartTransaction may have been rejected (check RFID allowlist). Skipping StopTransaction.`,
        );
        return;
      }

      console.log(
        `[${chargePointId}] ✓ Session started (transactionId=${transactionId}). ` +
        `Will stop in ${durationMs}ms.`,
      );

      // 4 — Wait for session duration
      await new Promise((r) => setTimeout(r, durationMs));

      // 5 — StopTransaction
      const meterStop = vcp.transactionManager.getMeterValue(transactionId);
      console.log(
        `[${chargePointId}] Sending StopTransaction (transactionId=${transactionId}, meterStop=${meterStop})`,
      );
      vcp.send(
        stopTransactionOcppMessage.request({
          transactionId: transactionId as number,
          idTag: rfidTag,
          meterStop: Math.round(meterStop),
          timestamp: new Date().toISOString(),
          reason: "Local",
        }),
      );
    });

    // Gate the next VCP on this one's StartTransaction completing, so transactionIds
    // are assigned in order and the stagger delay starts from a stable baseline.
    console.log(`[${chargePointId}] Waiting for session to start...`);
    await sessionStarted;

    await new Promise((r) => setTimeout(r, staggerMs));
  }

  if (autoStop) {
    // Total wait: ramp-up + poll timeout + session duration + 15s buffer for StopTransaction responses
    const totalWaitMs =
      chargePointsCount * staggerMs + pollTimeout + durationMs + 15_000;
    console.log(
      `All VCPs started. Process will exit in ~${Math.ceil(totalWaitMs / 1000)}s ` +
      `once all sessions complete.`,
    );
    await new Promise((r) => setTimeout(r, totalWaitMs));
    console.log("✓ All StopTransactions sent. Exiting.");
    process.exit(0);
  }
})();
