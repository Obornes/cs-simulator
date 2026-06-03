require("dotenv").config();

import { randomUUID } from "node:crypto";
import { OcppVersion } from "./src/ocppVersion";
import { bootNotificationOcppMessage } from "./src/v16/messages/bootNotification";
import { startTransactionOcppMessage } from "./src/v16/messages/startTransaction";
import { stopTransactionOcppMessage } from "./src/v16/messages/stopTransaction";
import { VCP } from "./src/vcp";

type TransactionId = string | number;

type Config = {
  endpoint: string;
  chargePointsCount: number;
  chargePointIdPrefix: string;
  idWidth: number;
  rfidTag: string;
  staggerMs: number;
  startDelayMs: number;
  durationMs: number;
  pollMs: number;
  pollTimeout: number;
  meterIntervalMs: number;
  stopSettleMs: number;
  sharedPassword?: string;
};

type StartResult = {
  chargePointId: string;
  started: boolean;
  transactionId: TransactionId | null;
  error?: string;
};

type VcpResult = StartResult & {
  stopped: boolean;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function parseNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);

  if (Number.isNaN(parsed)) {
    console.warn(`[ENV] ${name}="${raw}" is invalid. Using default=${defaultValue}`);
    return defaultValue;
  }

  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadConfig(): Config {
  return {
    endpoint: process.env.WS_URL ?? "ws://localhost:5555",
    chargePointsCount: parseNumberEnv("CP_COUNT", 10),
    chargePointIdPrefix: process.env.ID_PREFIX ?? "CS_2_",
    idWidth: parseNumberEnv("ID_WIDTH", 1),
    rfidTag: process.env.RFID_TAG ?? "TEST",
    staggerMs: parseNumberEnv("STAGGER_MS", 3000),
    startDelayMs: parseNumberEnv("START_DELAY_MS", 5000),
    durationMs: parseNumberEnv("DURATION_MS", 300000),
    pollMs: parseNumberEnv("POLL_MS", 500),
    pollTimeout: parseNumberEnv("POLL_TIMEOUT", 120000),
    meterIntervalMs: parseNumberEnv("METER_INTERVAL_MS", 10000),
    stopSettleMs: parseNumberEnv("STOP_SETTLE_MS", 3000),
    sharedPassword: process.env.PASSWORD || undefined,
  };
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

function getTransactionId(vcp: VCP, connectorId: number): TransactionId | null {
  const match = Array.from(vcp.transactionManager.transactions.values()).find(
    (transaction) => transaction.connectorId === connectorId,
  );

  return match?.transactionId ?? null;
}

function extractStartTransactionResult(payload: unknown): {
  status?: string;
  transactionId?: TransactionId;
} {
  const p = payload as {
    idTagInfo?: { status?: string };
    transactionId?: TransactionId;
  };

  return {
    status: p?.idTagInfo?.status,
    transactionId: p?.transactionId,
  };
}

async function waitForStartTransactionAccepted(
  vcp: VCP,
  startMessageId: string,
  connectorId: number,
  pollMs: number,
  timeoutMs: number,
): Promise<{ transactionId: TransactionId } | { error: string }> {
  return await new Promise((resolve) => {
    let done = false;
    let cleanup = () => undefined;

    const finish = (result: { transactionId: TransactionId } | { error: string }) => {
      if (done) {
        return;
      }

      done = true;
      cleanup();
      clearTimeout(timeout);
      clearInterval(pollInterval);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({
        error: `No valid transactionId after ${timeoutMs}ms. StartTransaction may have been rejected or delayed.`,
      });
    }, timeoutMs);

    const pollInterval = setInterval(() => {
      const transactionId = getTransactionId(vcp, connectorId);

      if (transactionId !== null && Number(transactionId) > 0) {
        finish({ transactionId });
      }
    }, pollMs);

    cleanup = vcp.onCallResult((event) => {
      if (event.messageId !== startMessageId || event.action !== "StartTransaction") {
        return;
      }

      const { status, transactionId } = extractStartTransactionResult(event.payload);

      if (status !== "Accepted") {
        finish({
          error: `StartTransaction rejected by backend. idTag status=${status ?? "unknown"}, transactionId=${transactionId ?? "missing"}`,
        });
        return;
      }

      if (transactionId === undefined || transactionId === null || Number(transactionId) <= 0) {
        finish({
          error: `StartTransaction accepted status but returned invalid transactionId=${transactionId}`,
        });
        return;
      }

      finish({ transactionId });
    });
  });
}

function sendBootNotification(vcp: VCP, chargePointId: string): void {
  vcp.send(
    bootNotificationOcppMessage.request({
      chargePointVendor: "Solidstudio",
      chargePointModel: "VirtualChargePoint",
      chargePointSerialNumber: chargePointId,
      firmwareVersion: "1.0.0",
    }),
  );
}

function sendMeterValues(
  vcp: VCP,
  transactionId: TransactionId,
  sessionStartedAt: Date,
): void {
  const meterValue = Math.round((Date.now() - sessionStartedAt.getTime()) / 100);

  vcp.send({
    messageId: randomUUID(),
    action: "MeterValues",
    payload: {
      connectorId: 1,
      transactionId,
      meterValue: [
        {
          timestamp: new Date().toISOString(),
          sampledValue: [
            {
              value: meterValue.toString(),
              measurand: "Energy.Active.Import.Register",
              unit: "Wh",
            },
          ],
        },
      ],
    },
  });
}

async function runVcpLifecycle(
  config: Config,
  chargePointId: string,
  startGate: Deferred<StartResult>,
): Promise<VcpResult> {
  const password = buildPassword(chargePointId, config.sharedPassword);
  const vcp = new VCP({
    endpoint: config.endpoint,
    chargePointId,
    ocppVersion: OcppVersion.OCPP_1_6,
    basicAuthPassword: password,
  });

  let startGateResolved = false;
  let transactionId: TransactionId | null = null;
  let sessionStartedAt: Date | null = null;

  const resolveStartGate = (result: StartResult) => {
    if (!startGateResolved) {
      startGateResolved = true;
      startGate.resolve(result);
    }
  };

  try {
    console.log(`[${chargePointId}] Connecting...`);
    await vcp.connect();
    console.log(`[${chargePointId}] Connected`);

    sendBootNotification(vcp, chargePointId);

    if (config.startDelayMs > 0) {
      await sleep(config.startDelayMs);
    }

    console.log(`[${chargePointId}] Sending StartTransaction`);
    const startTransactionCall = startTransactionOcppMessage.request({
      connectorId: 1,
      idTag: config.rfidTag,
      meterStart: 0,
      timestamp: new Date().toISOString(),
    });

    vcp.send(startTransactionCall);

    const startResult = await waitForStartTransactionAccepted(
      vcp,
      startTransactionCall.messageId,
      1,
      config.pollMs,
      config.pollTimeout,
    );

    if ("error" in startResult) {
      console.error(`[${chargePointId}] ${startResult.error}`);
      resolveStartGate({
        chargePointId,
        started: false,
        transactionId: null,
        error: startResult.error,
      });
      vcp.close();
      return {
        chargePointId,
        started: false,
        transactionId: null,
        stopped: false,
        error: startResult.error,
      };
    }

    transactionId = startResult.transactionId;
    sessionStartedAt = new Date();

    console.log(`[${chargePointId}] Session really started in backend. transactionId=${transactionId}`);

    resolveStartGate({
      chargePointId,
      started: true,
      transactionId,
    });

    if (config.durationMs === 0) {
      console.log(`[${chargePointId}] DURATION_MS=0. Leaving session active.`);
      return { chargePointId, started: true, transactionId, stopped: false };
    }

    const stopAt = Date.now() + config.durationMs;

    while (Date.now() < stopAt) {
      await sleep(Math.min(config.meterIntervalMs, stopAt - Date.now()));

      if (Date.now() < stopAt) {
        sendMeterValues(vcp, transactionId, sessionStartedAt);
      }
    }

    const meterStop = Math.round((Date.now() - sessionStartedAt.getTime()) / 100);

    console.log(
      `[${chargePointId}] Sending StopTransaction. transactionId=${transactionId}, meterStop=${meterStop}`,
    );

    vcp.send(
      stopTransactionOcppMessage.request({
        transactionId: Number(transactionId),
        idTag: config.rfidTag,
        meterStop,
        timestamp: new Date().toISOString(),
        reason: "Local",
      }),
    );

    if (config.stopSettleMs > 0) {
      await sleep(config.stopSettleMs);
    }

    vcp.transactionManager.stopTransaction(transactionId);
    vcp.close();

    console.log(`[${chargePointId}] Completed`);

    return { chargePointId, started: true, transactionId, stopped: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${chargePointId}] Failed: ${message}`);

    resolveStartGate({
      chargePointId,
      started: false,
      transactionId,
      error: message,
    });

    try {
      vcp.close();
    } catch {
      // Ignore cleanup errors during stress tests.
    }

    return {
      chargePointId,
      started: transactionId !== null,
      transactionId,
      stopped: false,
      error: message,
    };
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  console.log("Loaded stress configuration:", {
    WS_URL: config.endpoint,
    CP_COUNT: config.chargePointsCount,
    ID_PREFIX: config.chargePointIdPrefix,
    ID_WIDTH: config.idWidth,
    RFID_TAG: config.rfidTag,
    STAGGER_MS: config.staggerMs,
    START_DELAY_MS: config.startDelayMs,
    DURATION_MS: config.durationMs,
    POLL_MS: config.pollMs,
    POLL_TIMEOUT: config.pollTimeout,
    METER_INTERVAL_MS: config.meterIntervalMs,
    STOP_SETTLE_MS: config.stopSettleMs,
    PASSWORD_MODE: config.sharedPassword ? "shared password" : "per-VCP password",
    LAUNCH_MODE: "sequential: next VCP starts only after previous StartTransaction is Accepted with a valid transactionId",
  });

  const lifecycles: Promise<VcpResult>[] = [];

  for (let index = 1; index <= config.chargePointsCount; index += 1) {
    const chargePointId = buildChargePointId(
      config.chargePointIdPrefix,
      index,
      config.idWidth,
    );

    console.log(`[${index}/${config.chargePointsCount}] Launching ${chargePointId}`);

    const startGate = deferred<StartResult>();
    const lifecycle = runVcpLifecycle(config, chargePointId, startGate);
    lifecycles.push(lifecycle);

    const startResult = await startGate.promise;

    if (startResult.started) {
      console.log(
        `[${chargePointId}] Start gate passed. transactionId=${startResult.transactionId}. Next VCP can start.`,
      );
    } else {
      console.warn(
        `[${chargePointId}] Start gate failed. ${startResult.error}. Next VCP will continue after stagger delay.`,
      );
    }

    if (index < config.chargePointsCount && config.staggerMs > 0) {
      await sleep(config.staggerMs);
    }
  }

  console.log(`All ${config.chargePointsCount} VCPs launched. Waiting for completion...`);

  const results = await Promise.all(lifecycles);
  const started = results.filter((result) => result.started).length;
  const stopped = results.filter((result) => result.stopped).length;
  const failed = results.filter((result) => !result.started || result.error).length;

  console.log("Stress test summary:", {
    total: config.chargePointsCount,
    started,
    stopped,
    failed,
  });

  const failedResults = results.filter((result) => !result.started || result.error);

  if (failedResults.length > 0) {
    console.error("Failed VCPs:");
    for (const result of failedResults) {
      console.error(`- ${result.chargePointId}: ${result.error ?? "not started"}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Fatal stress test error", error);
  process.exit(1);
});
