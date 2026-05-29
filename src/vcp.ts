import * as util from "node:util";
import { WebSocket } from "ws";

import { serve } from "@hono/node-server";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "./logger";
import { call } from "./messageFactory";
import type { OcppCall, OcppCallError, OcppCallResult } from "./ocppMessage";
import {
  type OcppMessageHandler,
  resolveMessageHandler,
} from "./ocppMessageHandler";
import { ocppOutbox } from "./ocppOutbox";
import { type OcppVersion, toProtocolVersion } from "./ocppVersion";
import {
  validateOcppIncomingRequest,
  validateOcppIncomingResponse,
  validateOcppOutgoingRequest,
  validateOcppOutgoingResponse,
} from "./schemaValidator";
import { TransactionManager } from "./transactionManager";
import { heartbeatOcppMessage } from "./v16/messages/heartbeat";

interface VCPOptions {
  ocppVersion: OcppVersion;
  endpoint: string;
  chargePointId: string;
  basicAuthPassword?: string;
  adminPort?: number;
}

interface LogEntry {
  type: "Application";
  timestamp: string;
  level: string;
  message: string;
  metadata: Record<string, unknown>;
}

export interface VCPDisconnectInfo {
  source: "close" | "error";
  code?: number;
  reason?: string;
  error?: unknown;
}

export type VCPDisconnectHandler = (info: VCPDisconnectInfo) => void;

export class VCP {
  private ws?: WebSocket;
  private messageHandler: OcppMessageHandler;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private disconnectEmitted = false;
  private opened = false;

  public isFinishing = false;

  transactionManager = new TransactionManager();

  constructor(private vcpOptions: VCPOptions) {
    this.messageHandler = resolveMessageHandler(vcpOptions.ocppVersion);

    if (vcpOptions.adminPort) {
      const adminApi = new Hono();

      adminApi.get("/health", (c) => c.text("OK"));

      adminApi.post(
        "/execute",
        zValidator(
          "json",
          z.object({
            action: z.string(),
            payload: z.any(),
          }),
        ),
        (c) => {
          const validated = c.req.valid("json");
          this.send(call(validated.action, validated.payload));
          return c.text("OK");
        },
      );

      serve({
        fetch: adminApi.fetch,
        port: vcpOptions.adminPort,
      });
    }
  }

  async connect(onDisconnected?: VCPDisconnectHandler): Promise<void> {
    logger.info(`Connecting... | ${util.inspect(this.vcpOptions)}`);

    this.isFinishing = false;
    this.disconnectEmitted = false;
    this.opened = false;

    return new Promise((resolve, reject) => {
      const websocketUrl = `${this.vcpOptions.endpoint}/${this.vcpOptions.chargePointId}`;
      const protocol = toProtocolVersion(this.vcpOptions.ocppVersion);

      this.ws = new WebSocket(websocketUrl, [protocol], {
        rejectUnauthorized: false,
        followRedirects: true,
        headers: {
          ...(this.vcpOptions.basicAuthPassword && {
            Authorization: `Basic ${Buffer.from(
              `${this.vcpOptions.chargePointId}:${this.vcpOptions.basicAuthPassword}`,
            ).toString("base64")}`,
          }),
        },
      });

      this.ws.on("open", () => {
        this.opened = true;
        resolve();
      });

      this.ws.on("message", (message: string) => this._onMessage(message));

      this.ws.on("ping", () => {
        logger.info("Received PING");
      });

      this.ws.on("pong", () => {
        logger.info("Received PONG");
      });

      this.ws.on("close", (code: number, reasonBuffer: Buffer) => {
        const reason = reasonBuffer?.toString?.() ?? "";

        if (!this.opened) {
          reject(
            new Error(
              `WebSocket closed before open. code=${code}, reason=${reason}`,
            ),
          );
          return;
        }

        this._onDisconnect(
          {
            source: "close",
            code,
            reason,
          },
          onDisconnected,
        );
      });

      this.ws.on("error", (error: unknown) => {
        logger.error("Error on websocket", error);

        if (!this.opened) {
          reject(error);
          return;
        }

        this._onDisconnect(
          {
            source: "error",
            error,
          },
          onDisconnected,
        );
      });
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // biome-ignore lint/suspicious/noExplicitAny: OCPP payloads are action-specific
  send(ocppCall: OcppCall<any>) {
    if (!this.ws) {
      throw new Error("Websocket not initialized. Call connect() first");
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        `Cannot send ${ocppCall.action}. WebSocket is not open. readyState=${this.ws.readyState}`,
      );
    }

    ocppOutbox.enqueue(ocppCall);

    const jsonMessage = JSON.stringify([
      2,
      ocppCall.messageId,
      ocppCall.action,
      ocppCall.payload,
    ]);

    logger.info(`Sending message ➡️  ${jsonMessage}`);

    validateOcppOutgoingRequest(
      this.vcpOptions.ocppVersion,
      ocppCall.action,
      JSON.parse(JSON.stringify(ocppCall.payload)),
    );

    this.ws.send(jsonMessage);
  }

  // biome-ignore lint/suspicious/noExplicitAny: OCPP payloads are action-specific
  respond(result: OcppCallResult<any>) {
    if (!this.ws) {
      throw new Error("Websocket not initialized. Call connect() first");
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        `Cannot respond to ${result.action}. WebSocket is not open. readyState=${this.ws.readyState}`,
      );
    }

    const jsonMessage = JSON.stringify([3, result.messageId, result.payload]);

    logger.info(`Responding with ➡️  ${jsonMessage}`);

    validateOcppIncomingResponse(
      this.vcpOptions.ocppVersion,
      result.action,
      JSON.parse(JSON.stringify(result.payload)),
    );

    this.ws.send(jsonMessage);
  }

  // biome-ignore lint/suspicious/noExplicitAny: OCPP payloads are action-specific
  respondError(error: OcppCallError<any>) {
    if (!this.ws) {
      throw new Error("Websocket not initialized. Call connect() first");
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(
        `Cannot respond with error. WebSocket is not open. readyState=${this.ws.readyState}`,
      );
    }

    const jsonMessage = JSON.stringify([
      4,
      error.messageId,
      error.errorCode,
      error.errorDescription,
      error.errorDetails,
    ]);

    logger.info(`Responding with ➡️  ${jsonMessage}`);

    this.ws.send(jsonMessage);
  }

  configureHeartbeat(interval: number) {
    this.clearHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected()) {
        return;
      }

      try {
        this.send(heartbeatOcppMessage.request({}));
      } catch (error) {
        logger.error("Failed to send Heartbeat", error);
      }
    }, interval);
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  close() {
    this.isFinishing = true;
    this.clearHeartbeat();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }

    this.ws = undefined;
  }

  terminate() {
    this.isFinishing = true;
    this.clearHeartbeat();

    if (this.ws) {
      this.ws.terminate();
    }

    this.ws = undefined;
  }

  async getDiagnosticData(): Promise<LogEntry[]> {
    try {
      const transport = logger.transports[0];

      const logStream = new Promise<LogEntry[]>((resolve) => {
        const entries: LogEntry[] = [];

        transport.on(
          "logged",
          (info: {
            timestamp: string;
            level: string;
            message: string;
            [key: string]: unknown;
          }) => {
            entries.push({
              type: "Application",
              timestamp: info.timestamp || new Date().toISOString(),
              level: info.level,
              message: info.message,
              metadata: Object.fromEntries(
                Object.entries(info).filter(
                  ([key]) => !["timestamp", "level", "message"].includes(key),
                ),
              ),
            });
          },
        );

        setTimeout(() => resolve(entries), 10000);
      });

      return await logStream;
    } catch (err) {
      logger.error("Failed to read application logs:", err);
      return [];
    }
  }

  private _onMessage(message: string) {
    logger.info(`Receive message ⬅️  ${message}`);

    const data = JSON.parse(message);
    const [type, ...rest] = data;

    if (type === 2) {
      const [messageId, action, payload] = rest;

      validateOcppIncomingRequest(this.vcpOptions.ocppVersion, action, payload);

      this.messageHandler.handleCall(this, {
        messageId,
        action,
        payload,
      });
    } else if (type === 3) {
      const [messageId, payload] = rest;
      const enqueuedCall = ocppOutbox.get(messageId);

      if (!enqueuedCall) {
        throw new Error(
          `Received CallResult for unknown messageId=${messageId}`,
        );
      }

      validateOcppOutgoingResponse(
        this.vcpOptions.ocppVersion,
        enqueuedCall.action,
        payload,
      );

      this.messageHandler.handleCallResult(this, enqueuedCall, {
        messageId,
        payload,
        action: enqueuedCall.action,
      });
    } else if (type === 4) {
      const [messageId, errorCode, errorDescription, errorDetails] = rest;

      this.messageHandler.handleCallError(this, {
        messageId,
        errorCode,
        errorDescription,
        errorDetails,
      });
    } else {
      throw new Error(`Unrecognized message type ${type}`);
    }
  }

  private _onDisconnect(
    info: VCPDisconnectInfo,
    onDisconnected?: VCPDisconnectHandler,
  ) {
    if (this.isFinishing) {
      return;
    }

    if (this.disconnectEmitted) {
      return;
    }

    this.disconnectEmitted = true;
    this.clearHeartbeat();

    logger.info(
      `Connection disconnected. source=${info.source}, code=${info.code}, reason=${info.reason}`,
    );

    onDisconnected?.(info);
  }
}