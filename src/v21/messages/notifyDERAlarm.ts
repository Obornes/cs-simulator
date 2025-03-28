import { z } from "zod";
import { OcppCall, OcppCallResult, OcppMessage } from "../../ocppMessage";
import { VCP } from "../../vcp";
import { DERControlType } from "./_common";

const NotifyDERAlarmReqSchema = z.object({
  controlType: DERControlType,
  gridEventFault: z
    .enum([
      "CurrentImbalance",
      "LocalEmergency",
      "LowInputPower",
      "OverCurrent",
      "OverFrequency",
      "OverVoltage",
      "PhaseRotation",
      "RemoteEmergency",
      "UnderFrequency",
      "UnderVoltage",
      "VoltageImbalance",
    ])
    .nullish(),
  alarmEnded: z.boolean().nullish(),
  timestamp: z.string().datetime(),
  extraInfo: z.string().max(200).nullish(),
});
type NotifyDERAlarmReqType = typeof NotifyDERAlarmReqSchema;

const NotifyDERAlarmResSchema = z.object({});
type NotifyDERAlarmResType = typeof NotifyDERAlarmResSchema;

class NotifyDERAlarmOcppMessage extends OcppMessage<
  NotifyDERAlarmReqType,
  NotifyDERAlarmResType
> {
  resHandler = async (
    _vcp: VCP,
    _call: OcppCall<z.infer<NotifyDERAlarmReqType>>,
    _result: OcppCallResult<z.infer<NotifyDERAlarmResType>>,
  ): Promise<void> => {
    // NOOP
  };
}

export const notifyDERAlarmOcppMessage = new NotifyDERAlarmOcppMessage(
  "NotifyDERAlarm",
  NotifyDERAlarmReqSchema,
  NotifyDERAlarmResSchema,
);
