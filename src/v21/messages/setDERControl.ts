import { z } from "zod";
import { OcppCall, OcppCallResult, OcppMessage } from "../../ocppMessage";
import { VCP } from "../../vcp";
import {
  DERControlType,
  DERCurve,
  EnterService,
  FixedPF,
  FixedVar,
  FreqDroop,
  Gradient,
  LimitMaxDischarge,
  StatusInfoTypeSchema,
} from "./_common";

const SetDERControlReqSchema = z.object({
  isDefault: z.boolean(),
  controlId: z.string().max(36),
  controlType: DERControlType,
  curve: DERCurve.nullish(),
  fixedPFAbsorb: FixedPF.nullish(),
  fixedPFInject: FixedPF.nullish(),
  fixedVar: FixedVar.nullish(),
  limitMaxDischarge: LimitMaxDischarge.nullish(),
  freqDroop: FreqDroop.nullish(),
  enterService: EnterService.nullish(),
  gradient: Gradient.nullish(),
});
type SetDERControlReqType = typeof SetDERControlReqSchema;

const SetDERControlResSchema = z.object({
  status: z.enum(["Accepted", "Rejected"]),
  statusInfo: StatusInfoTypeSchema.nullish(),
});
type SetDERControlResType = typeof SetDERControlResSchema;

class SetDERControlOcppMessage extends OcppMessage<
  SetDERControlReqType,
  SetDERControlResType
> {
  resHandler = async (
    _vcp: VCP,
    _call: OcppCall<z.infer<SetDERControlReqType>>,
    _result: OcppCallResult<z.infer<SetDERControlResType>>,
  ): Promise<void> => {
    // NOOP
  };
}

export const setDERControlOcppMessage = new SetDERControlOcppMessage(
  "SetDERControl",
  SetDERControlReqSchema,
  SetDERControlResSchema,
);
