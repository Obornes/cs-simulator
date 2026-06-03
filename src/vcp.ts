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
import { TransactionManager } from "../../../Downloads/transactionManager";
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

export interface VCPCallResultEvent {
  messageId: string;
  action: string;
  payload: unknown;
}

export type VCPCallResultObserver = (event: VCPCallResultEvent) => void;

export class VCP {
  private ws?: WebSocket;
  private messageHandler: OcppMessageHandler;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private callResultObservers = new Set<VCPCallResultObserver>();

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

  async connect(reconnect?: () => void): Promise<void> {
    logger.info(`Connecting... | ${util.inspect(this.vcpOptions)}`);
    this.isFinishing = false;
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

      this.ws.on("open", () => resolve());
      this.ws.on("message", (message: string) => this._onMessage(message));
      this.ws.on("ping", () => {
        logger.info("Received PING");
      });
      this.ws.on("pong", () => {
        logger.info("Received PONG");
      });
      this.ws.on("close", (code: number, reason: Buffer) =>
        this._onClose(code, reason?.toString?.() ?? "", reconnect),
      );
      this.ws.on("error", (error: unknown) => {
        logger.error(`Error on websocket`, error);
        if (this.isFinishing) {
          return;
        }
        if (reconnect) {
          setTimeout(() => reconnect(), 1000);
        } else {
          reject(error);
        }
      });
    });
  }

  onCallResult(observer: VCPCallResultObserver): () => void {
    this.callResultObservers.add(observer);

    return () => {
      this.callResultObservers.delete(observer);
    };
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  send(ocppCall: OcppCall<any>): boolean {
    /*
     * Stress-test safety:
     * MeterValues / Heartbeat timers can still fire while the VCP is closing
     * or after the backend closed the websocket. In that case, do not throw a
     * fatal exception because it crashes the whole stress-test process.
     */
    if (!this.canSend(ocppCall.action)) {
      return false;
    }

    try {
      validateOcppOutgoingRequest(
        this.vcpOptions.ocppVersion,
        ocppCall.action,
        JSON.parse(JSON.stringify(ocppCall.payload)),
      );

      ocppOutbox.enqueue(ocppCall);

      const jsonMessage = JSON.stringify([
        2,
        ocppCall.messageId,
        ocppCall.action,
        ocppCall.payload,
      ]);

      logger.info(`Sending message ➡️  ${jsonMessage}`);

      this.ws?.send(jsonMessage);
      return true;
    } catch (error) {
      logger.error(
        `Failed to send ${ocppCall.action} for ${this.vcpOptions.chargePointId}`,
        error,
      );
      return false;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  respond(result: OcppCallResult<any>) {
    if (!this.canRespond(`respond to ${result.action}`)) {
      return;
    }

    const jsonMessage = JSON.stringify([3, result.messageId, result.payload]);
    logger.info(`Responding with ➡️  ${jsonMessage}`);
    validateOcppIncomingResponse(
      this.vcpOptions.ocppVersion,
      result.action,
      JSON.parse(JSON.stringify(result.payload)),
    );
    this.ws?.send(jsonMessage);
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp types
  respondError(error: OcppCallError<any>) {
    if (!this.canRespond("respond with error")) {
      return;
    }

    const jsonMessage = JSON.stringify([
      4,
      error.messageId,
      error.errorCode,
      error.errorDescription,
      error.errorDetails,
    ]);
    logger.info(`Responding with ➡️  ${jsonMessage}`);
    this.ws?.send(jsonMessage);
  }

  private canSend(action: string): boolean {
    if (this.isFinishing) {
      logger.info(
        `Skipping ${action}: VCP ${this.vcpOptions.chargePointId} is finishing`,
      );
      return false;
    }

    if (!this.ws) {
      logger.info(
        `Skipping ${action}: websocket is not initialized for ${this.vcpOptions.chargePointId}`,
      );
      return false;
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      logger.info(
        `Skipping ${action}: websocket is not open for ${this.vcpOptions.chargePointId}. readyState=${this.ws.readyState}`,
      );
      return false;
    }

    return true;
  }

  private canRespond(operation: string): boolean {
    if (!this.ws) {
      logger.warn(`Cannot ${operation}. WebSocket is not initialized.`);
      return false;
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      logger.warn(
        `Cannot ${operation}. WebSocket is not open. readyState=${this.ws.readyState}`,
      );
      return false;
    }

    return true;
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
    this.transactionManager.stopAllTransactions(
      `VCP ${this.vcpOptions.chargePointId} is closing`,
    );

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }

    this.ws = undefined;
  }

  terminate() {
    this.isFinishing = true;
    this.clearHeartbeat();
    this.transactionManager.stopAllTransactions(
      `VCP ${this.vcpOptions.chargePointId} is terminating`,
    );

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
    try {
      logger.info(`Receive message ⬅️  ${message}`);
      const data = JSON.parse(message);
      const [type, ...rest] = data;
      if (type === 2) {
        const [messageId, action, payload] = rest;
        validateOcppIncomingRequest(this.vcpOptions.ocppVersion, action, payload);
        this.messageHandler.handleCall(this, { messageId, action, payload });
      } else if (type === 3) {
        const [messageId, payload] = rest;
        const enqueuedCall = ocppOutbox.get(messageId);
        if (!enqueuedCall) {
          logger.warn(`Ignoring CallResult for unknown messageId=${messageId}`);
          return;
        }
        validateOcppOutgoingResponse(
          this.vcpOptions.ocppVersion,
          enqueuedCall.action,
          payload,
        );

        for (const observer of this.callResultObservers) {
          try {
            observer({
              messageId,
              payload,
              action: enqueuedCall.action,
            });
          } catch (error) {
            logger.error("VCP call result observer failed", error);
          }
        }

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
        logger.warn(`Ignoring unrecognized message type ${type}`);
      }
    } catch (error) {
      if (this.isFinishing) {
        logger.warn("Ignoring incoming message during VCP shutdown", error);
        return;
      }
      logger.error("Failed to process incoming OCPP message", error);
    }
  }

  private _onClose(code: number, reason: string, reconnect?: () => void) {
    if (this.isFinishing) {
      return;
    }

    this.isFinishing = true;
    this.clearHeartbeat();
    this.transactionManager.stopAllTransactions(
      `VCP ${this.vcpOptions.chargePointId} websocket closed`,
    );
    this.ws = undefined;

    logger.info(`Connection closed. code=${code}, reason=${reason}`);

    if (reconnect) {
      reconnect();
    }
  }
}
