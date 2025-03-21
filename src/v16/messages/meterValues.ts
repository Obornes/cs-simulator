import { z } from "zod";
import { OcppCall, OcppCallResult, OcppMessage } from "../../ocppMessage";
import { VCP } from "../../vcp";
import { ConnectorIdSchema, MeterValueSchema } from "./_common";

const MeterValuesReqSchema = z.object({
  connectorId: ConnectorIdSchema,
  transactionId: z.number().int().nullish(),
  meterValue: z.array(MeterValueSchema).nonempty(),
});
type MeterValuesReqType = typeof MeterValuesReqSchema;

const MeterValuesResSchema = z.object({});
type MeterValuesResType = typeof MeterValuesResSchema;

class MeterValuesOcppMessage extends OcppMessage<
  MeterValuesReqType,
  MeterValuesResType
> {
  resHandler = async (
    _vcp: VCP,
    _call: OcppCall<z.infer<MeterValuesReqType>>,
    _result: OcppCallResult<z.infer<MeterValuesResType>>,
  ): Promise<void> => {
    // NOOP
  };
}

export const meterValuesOcppMessage = new MeterValuesOcppMessage(
  "MeterValues",
  MeterValuesReqSchema,
  MeterValuesResSchema,
);
