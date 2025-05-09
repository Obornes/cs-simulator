import { z } from "zod";
import { OcppCall, OcppMessage } from "../../ocppMessage";
import { VCP } from "../../vcp";

const ExtendedTriggerMessageReqSchema = z.object({
  requestedMessage: z.enum([
    "BootNotification",
    "LogStatusNotification",
    "FirmwareStatusNotification",
    "Heartbeat",
    "MeterValues",
    "SignChargePointCertificate",
    "StatusNotification",
  ]),
  connectorId: z.number().int().nullish(),
});
type ExtendedTriggerMessageReqType = typeof ExtendedTriggerMessageReqSchema;

const ExtendedTriggerMessageResSchema = z.object({
  status: z.enum(["Accepted", "Rejected", "NotImplemented"]),
});
type ExtendedTriggerMessageResType = typeof ExtendedTriggerMessageResSchema;

class ExtendedTriggerMessageOcppMessage extends OcppMessage<
  ExtendedTriggerMessageReqType,
  ExtendedTriggerMessageResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<ExtendedTriggerMessageReqType>>,
  ): Promise<void> => {
    vcp.respond(this.response(call, { status: "Accepted" }));
  };
}

export const extendedTriggerMessageOcppMessage =
  new ExtendedTriggerMessageOcppMessage(
    "ExtendedTriggerMessage",
    ExtendedTriggerMessageReqSchema,
    ExtendedTriggerMessageResSchema,
  );
