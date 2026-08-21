import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { type OcppCall, OcppIncoming } from "../../ocppMessage";
import type { VCP } from "../../vcp";
import {
  ChargingProfileSchema,
  IdTokenTypeSchema,
  StatusInfoTypeSchema,
} from "./_common";
import { statusNotificationOcppOutgoing } from "./statusNotification";
import { transactionEventOcppOutgoing } from "./transactionEvent";

const RequestStartTransactionReqSchema = z.object({
  evseId: z.number().int().nullish(),
  remoteStartId: z.number().int(),
  idToken: IdTokenTypeSchema,
  chargingProfile: ChargingProfileSchema.nullish(),
  groupIdToken: IdTokenTypeSchema.nullish(),
});
type RequestStartTransactionReqType = typeof RequestStartTransactionReqSchema;

const RequestStartTransactionResSchema = z.object({
  status: z.enum(["Accepted", "Rejected"]),
  transactionId: z.string().max(36).nullish(),
  statusInfo: StatusInfoTypeSchema.nullish(),
});
type RequestStartTransactionResType = typeof RequestStartTransactionResSchema;

class RequestStartTransactionOcppIncoming extends OcppIncoming<
  RequestStartTransactionReqType,
  RequestStartTransactionResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<RequestStartTransactionReqType>>,
  ): Promise<void> => {
    const transactionEvseId = call.payload.evseId ?? 1;
    // RequestStartTransaction only lets the CSMS target an EVSE - the charge point picks
    // which of its connectors to actually use. This codebase currently models exactly one
    // connector per EVSE (same convention the CPMS's own seed data uses), so the EVSE id
    // doubles as the connector id for now. If a station ever needs several connectors per
    // EVSE, this is the one place to resolve a real connectorId instead of reusing evseId.
    const resolvedConnectorId = transactionEvseId;

    // Check if a transaction is already running on this connector
    if (!vcp.transactionManager.canStartNewTransaction(resolvedConnectorId)) {
      vcp.respond(
        this.response(call, {
          status: "Rejected",
        }),
      );
      return;
    }

    const transactionId = uuidv4();
    vcp.transactionManager.startTransaction(vcp, {
      transactionId: transactionId,
      idTag: call.payload.idToken.idToken,
      evseId: transactionEvseId,
      connectorId: resolvedConnectorId,
      meterValuesCallback: async (transactionStatus) => {
        vcp.send(
          transactionEventOcppOutgoing.request({
            eventType: "Updated",
            timestamp: new Date().toISOString(),
            seqNo: 0,
            triggerReason: "MeterValuePeriodic",
            transactionInfo: {
              transactionId: transactionId,
            },
            evse: {
              id: transactionEvseId,
              connectorId: resolvedConnectorId,
            },
            meterValue: [
              {
                timestamp: new Date().toISOString(),
                sampledValue: [
                  {
                    value: transactionStatus.meterValue,
                    measurand: "Energy.Active.Import.Register",
                    unitOfMeasure: {
                      unit: "kWh",
                    },
                  },
                ],
              },
            ],
          }),
        );
      },
    });
    vcp.respond(
      this.response(call, {
        status: "Accepted",
      }),
    );
    vcp.send(
      statusNotificationOcppOutgoing.request({
        evseId: transactionEvseId,
        connectorId: resolvedConnectorId,
        connectorStatus: "Occupied",
        timestamp: new Date().toISOString(),
      }),
    );
    vcp.send(
      transactionEventOcppOutgoing.request({
        eventType: "Started",
        timestamp: new Date().toISOString(),
        seqNo: 0,
        triggerReason: "Authorized",
        transactionInfo: {
          transactionId: transactionId,
          remoteStartId: call.payload.remoteStartId,
        },
        idToken: call.payload.idToken,
        evse: {
          id: transactionEvseId,
          connectorId: resolvedConnectorId,
        },
        meterValue: [
          {
            timestamp: new Date().toISOString(),
            sampledValue: [
              {
                value: 0,
                measurand: "Energy.Active.Import.Register",
                unitOfMeasure: {
                  unit: "kWh",
                },
              },
            ],
          },
        ],
      }),
    );
  };
}

export const requestStartTransactionOcppIncoming =
  new RequestStartTransactionOcppIncoming(
    "RequestStartTransaction",
    RequestStartTransactionReqSchema,
    RequestStartTransactionResSchema,
  );
