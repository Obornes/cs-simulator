import * as dotenv from "dotenv";

dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH ?? ".env.stress",
});

import * as uuid from "uuid";

import { OcppVersion } from "./src/ocppVersion";
import { TransactionManager } from "./src/transactionManager";
import { bootNotificationOcppMessage } from "./src/v16/messages/bootNotification";
import { startTransactionOcppMessage } from "./src/v16/messages/startTransaction";
import { stopTransactionOcppMessage } from "./src/v16/messages/stopTransaction";
import { VCP, type VCPDisconnectInfo } from "./src/vcp";

type TransactionId = string | number;

interface StressConfig {
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
  reconnectEnabled: boolean;
  maxReconnectAttempts: number;
  reconnectDelayMs: number;
  reconnectBackoffFactor: number;
  reconnectMaxDelayMs: number;
}

interface VcpSessionState {
  chargePointId: string;
  password: string;
  transactionId: TransactionId | null;
  sessionStartedAt: Date | null;
  startTransactionSent: boolean;
  completed: boolean;
  reconnectAttempts: number;
}

class ReconnectRequired extends Error {
  constructor(
    message: string,
    public readonly disconnectInfo?: VCPDisconnectInfo,
  ) {
    super(message);
    this.name = "ReconnectRequired";
  }
}

class NonRetryableSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableSessionError";
  }
}

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

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }

  return ["true", "1", "yes", "y"].includes(raw.toLowerCase());
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

function loadConfig(): StressConfig {
  return {
    endpoint: process.env.WS_URL ?? "ws://localhost:5555",
    chargePointsCount: parseNumberEnv("CP_COUNT", 10),
    chargePointIdPrefix: process.env.ID_PREFIX ?? "CS_2_",
    idWidth: parseNumberEnv("ID_WIDTH", 4),
    rfidTag: process.env.RFID_TAG ?? "TEST",
    staggerMs: parseNumberEnv("STAGGER_MS", 3000),
    startDelayMs: parseNumberEnv("START_DELAY_MS", 1000),
    durationMs: parseNumberEnv("DURATION_MS", 300000),
    pollMs: parseNumberEnv("POLL_MS", 500),
    pollTimeout: parseNumberEnv("POLL_TIMEOUT", 30000),
    meterIntervalMs: parseNumberEnv("METER_INTERVAL_MS", 10000),
    stopSettleMs: parseNumberEnv("STOP_SETTLE_MS", 3000),
    sharedPassword: process.env.PASSWORD || undefined,
    reconnectEnabled: parseBooleanEnv("RECONNECT_ENABLED", true),
    maxReconnectAttempts: parseNumberEnv("MAX_RECONNECT_ATTEMPTS", 5),
    reconnectDelayMs: parseNumberEnv("RECONNECT_DELAY_MS", 5000),
    reconnectBackoffFactor: parseNumberEnv("RECONNECT_BACKOFF_FACTOR", 2),
    reconnectMaxDelayMs: parseNumberEnv("RECONNECT_MAX_DELAY_MS", 60000),
  };
}

function createDisconnectSignal() {
  let disconnected = false;
  let disconnectInfo: VCPDisconnectInfo | undefined;
  let resolvePromise: (info: VCPDisconnectInfo) => void = () => {};

  const promise = new Promise<VCPDisconnectInfo>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    notify(info: VCPDisconnectInfo) {
      if (disconnected) {
        return;
      }

      disconnected = true;
      disconnectInfo = info;
      resolvePromise(info);
    },
    isDisconnected() {
      return disconnected;
    },
    info() {
      return disconnectInfo;
    },
  };
}

async function sleepOrDisconnect(
  ms: number,
  disconnectSignal: ReturnType<typeof createDisconnectSignal>,
): Promise<"timeout" | "disconnected"> {
  const result = await Promise.race([
    sleep(ms).then(() => "timeout" as const),
    disconnectSignal.promise.then(() => "disconnected" as const),
  ]);

  return result;
}

async function waitForTransactionId(
  vcp: VCP,
  connectorId: number,
  pollMs: number,
  timeoutMs: number,
  disconnectSignal: ReturnType<typeof createDisconnectSignal>,
): Promise<TransactionId | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (disconnectSignal.isDisconnected()) {
      throw new ReconnectRequired(
        "Disconnected while waiting for StartTransaction response",
        disconnectSignal.info(),
      );
    }

    const match = vcp.transactionManager.getTransactionByConnector(connectorId);

    if (match) {
      return match.transactionId;
    }

    const waitMs = Math.min(pollMs, deadline - Date.now());
    const waitResult = await sleepOrDisconnect(waitMs, disconnectSignal);

    if (waitResult === "disconnected") {
      throw new ReconnectRequired(
        "Disconnected while waiting for StartTransaction response",
        disconnectSignal.info(),
      );
    }
  }

  return null;
}

function sendBootNotification(vcp: VCP, chargePointId: string) {
  vcp.send(
    bootNotificationOcppMessage.request({
      chargePointVendor: "Solidstudio",
      chargePointModel: "VirtualChargePoint",
      chargePointSerialNumber: chargePointId,
      firmwareVersion: "1.0.0",
    }),
  );
}

function sendChargingStatusNotification(vcp: VCP) {
  vcp.send({
    messageId: uuid.v4(),
    action: "StatusNotification",
    payload: {
      connectorId: 1,
      errorCode: "NoError",
      status: "Charging",
      timestamp: new Date().toISOString(),
    },
  });
}

function sendMeterValues(
  vcp: VCP,
  transactionId: TransactionId,
  sessionStartedAt: Date,
) {
  const meterValue = (Date.now() - sessionStartedAt.getTime()) / 100;

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

function calculateReconnectDelay(config: StressConfig, attempt: number): number {
  const delay =
    config.reconnectDelayMs *
    Math.pow(config.reconnectBackoffFactor, Math.max(0, attempt - 1));

  return Math.min(delay, config.reconnectMaxDelayMs);
}

async function runConnectedSessionAttempt(
  config: StressConfig,
  state: VcpSessionState,
): Promise<void> {
  const disconnectSignal = createDisconnectSignal();

  const vcp = new VCP({
    endpoint: config.endpoint,
    chargePointId: state.chargePointId,
    ocppVersion: OcppVersion.OCPP_1_6,
    basicAuthPassword: state.password,
  });

  await vcp.connect((info) => {
    console.warn(
      `[${state.chargePointId}] Disconnected. source=${info.source}, code=${info.code}, reason=${info.reason}`,
    );
    disconnectSignal.notify(info);
  });

  console.log(`[${state.chargePointId}] Connected`);

  sendBootNotification(vcp, state.chargePointId);

  if (config.startDelayMs > 0) {
    const waitResult = await sleepOrDisconnect(
      config.startDelayMs,
      disconnectSignal,
    );

    if (waitResult === "disconnected") {
      throw new ReconnectRequired(
        "Disconnected before StartTransaction",
        disconnectSignal.info(),
      );
    }
  }

  if (state.transactionId === null) {
    console.log(`[${state.chargePointId}] Sending StartTransaction`);

    state.startTransactionSent = true;

    vcp.send(
      startTransactionOcppMessage.request({
        connectorId: 1,
        idTag: config.rfidTag,
        meterStart: 0,
        timestamp: new Date().toISOString(),
      }),
    );

    const transactionId = await waitForTransactionId(
      vcp,
      1,
      config.pollMs,
      config.pollTimeout,
      disconnectSignal,
    );

    if (transactionId === null) {
      throw new NonRetryableSessionError(
        `[${state.chargePointId}] No transactionId after ${config.pollTimeout}ms. StartTransaction may have been rejected.`,
      );
    }

    state.transactionId = transactionId;
    state.sessionStartedAt = new Date();
    state.reconnectAttempts = 0;

    console.log(
      `[${state.chargePointId}] Session started. transactionId=${state.transactionId}`,
    );
  } else {
    console.log(
      `[${state.chargePointId}] Reconnected with active transactionId=${state.transactionId}`,
    );

    if (state.sessionStartedAt) {
      vcp.transactionManager.restoreTransaction({
        transactionId: state.transactionId,
        idTag: config.rfidTag,
        meterValue: 0,
        startedAt: state.sessionStartedAt,
        connectorId: 1,
      });
    }

    sendChargingStatusNotification(vcp);
  }

  if (state.transactionId === null || state.sessionStartedAt === null) {
    throw new NonRetryableSessionError(
      `[${state.chargePointId}] Missing transaction state after StartTransaction`,
    );
  }

  if (config.durationMs === 0) {
    console.log(
      `[${state.chargePointId}] DURATION_MS=0. Session will continue until Ctrl+C.`,
    );

    await disconnectSignal.promise;

    throw new ReconnectRequired(
      "Disconnected during manual long-running session",
      disconnectSignal.info(),
    );
  }

  const deadline = state.sessionStartedAt.getTime() + config.durationMs;

  while (Date.now() < deadline) {
    const waitMs = Math.min(config.meterIntervalMs, deadline - Date.now());

    const waitResult = await sleepOrDisconnect(waitMs, disconnectSignal);

    if (waitResult === "disconnected") {
      throw new ReconnectRequired(
        "Disconnected during active transaction",
        disconnectSignal.info(),
      );
    }

    if (Date.now() >= deadline) {
      break;
    }

    sendMeterValues(vcp, state.transactionId, state.sessionStartedAt);
  }

  if (disconnectSignal.isDisconnected()) {
    throw new ReconnectRequired(
      "Disconnected before StopTransaction",
      disconnectSignal.info(),
    );
  }

  const meterStop = Math.round(
    (Date.now() - state.sessionStartedAt.getTime()) / 100,
  );

  console.log(
    `[${state.chargePointId}] Sending StopTransaction. transactionId=${state.transactionId}, meterStop=${meterStop}`,
  );

  vcp.send(
    stopTransactionOcppMessage.request({
      transactionId: Number(state.transactionId),
      idTag: config.rfidTag,
      meterStop,
      timestamp: new Date().toISOString(),
      reason: "Local",
    }),
  );

  if (config.stopSettleMs > 0) {
    const waitResult = await sleepOrDisconnect(
      config.stopSettleMs,
      disconnectSignal,
    );

    if (waitResult === "disconnected") {
      throw new ReconnectRequired(
        "Disconnected just after StopTransaction",
        disconnectSignal.info(),
      );
    }
  }

  state.completed = true;

  vcp.transactionManager.stopTransaction(state.transactionId);
  vcp.close();

  console.log(`[${state.chargePointId}] Completed`);
}

async function runVcpLifecycle(
  config: StressConfig,
  chargePointId: string,
): Promise<void> {
  const state: VcpSessionState = {
    chargePointId,
    password: buildPassword(chargePointId, config.sharedPassword),
    transactionId: null,
    sessionStartedAt: null,
    startTransactionSent: false,
    completed: false,
    reconnectAttempts: 0,
  };

  while (!state.completed) {
    try {
      await runConnectedSessionAttempt(config, state);
    } catch (error) {
      if (error instanceof NonRetryableSessionError) {
        console.error(error.message);
        throw error;
      }

      if (!(error instanceof ReconnectRequired)) {
        console.error(`[${state.chargePointId}] Unexpected failure`, error);
        throw error;
      }

      if (!config.reconnectEnabled) {
        console.error(
          `[${state.chargePointId}] Reconnect disabled. Stopping VCP lifecycle.`,
        );
        throw error;
      }

      if (state.startTransactionSent && state.transactionId === null) {
        throw new NonRetryableSessionError(
          `[${state.chargePointId}] Disconnected after StartTransaction was sent but before transactionId was captured. ` +
            `To avoid creating duplicate sessions, this VCP will not retry automatically.`,
        );
      }

      state.reconnectAttempts += 1;

      if (state.reconnectAttempts > config.maxReconnectAttempts) {
        throw new NonRetryableSessionError(
          `[${state.chargePointId}] Max reconnect attempts reached: ${config.maxReconnectAttempts}`,
        );
      }

      const delayMs = calculateReconnectDelay(config, state.reconnectAttempts);

      console.warn(
        `[${state.chargePointId}] Reconnecting attempt ${state.reconnectAttempts}/${config.maxReconnectAttempts} in ${delayMs}ms`,
      );

      await sleep(delayMs);
    }
  }
}

async function main(): Promise<void> {
  TransactionManager.START_INTERVAL = false;

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
    RECONNECT_ENABLED: config.reconnectEnabled,
    MAX_RECONNECT_ATTEMPTS: config.maxReconnectAttempts,
    RECONNECT_DELAY_MS: config.reconnectDelayMs,
    RECONNECT_BACKOFF_FACTOR: config.reconnectBackoffFactor,
    RECONNECT_MAX_DELAY_MS: config.reconnectMaxDelayMs,
    PASSWORD_MODE: config.sharedPassword ? "shared PASSWORD" : "per-VCP password",
  });

  const tasks: Promise<void>[] = [];

  for (let i = 1; i <= config.chargePointsCount; i++) {
    const chargePointId = buildChargePointId(
      config.chargePointIdPrefix,
      i,
      config.idWidth,
    );

    console.log(`[${i}/${config.chargePointsCount}] Launching ${chargePointId}`);

    const task = runVcpLifecycle(config, chargePointId).catch((error) => {
      console.error(`[${chargePointId}] Failed`, error);
      throw error;
    });

    tasks.push(task);

    if (i < config.chargePointsCount && config.staggerMs > 0) {
      await sleep(config.staggerMs);
    }
  }

  console.log(
    `All ${config.chargePointsCount} VCPs launched. Waiting for completion...`,
  );

  const results = await Promise.allSettled(tasks);

  const succeeded = results.filter((result) => result.status === "fulfilled");
  const failed = results.filter((result) => result.status === "rejected");

  console.log("Stress test summary:", {
    total: results.length,
    succeeded: succeeded.length,
    failed: failed.length,
  });

  if (failed.length > 0) {
    process.exit(1);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("Fatal error in stress test script", error);
  process.exit(1);
});