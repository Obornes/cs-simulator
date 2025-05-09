import { z } from "zod";
import { OcppCall, OcppMessage } from "../../ocppMessage";
import { VCP } from "../../vcp";
import { StatusInfoTypeSchema } from "./_common";

const ClearTariffsReqSchema = z.object({
  tariffIds: z.array(z.string().max(60)).nullish(),
  evseId: z.number().int().nullish(),
});
type ClearTariffsReqType = typeof ClearTariffsReqSchema;

const ClearTariffsResSchema = z.object({
  clearTariffsResult: z.array(
    z.object({
      tariffId: z.string().max(60).nullish(),
      status: z.enum(["Accepted", "Rejected", "NoTariff"]),
      statusInfo: StatusInfoTypeSchema.nullish(),
    }),
  ),
});
type ClearTariffsResType = typeof ClearTariffsResSchema;

class ClearTariffsOcppMessage extends OcppMessage<
  ClearTariffsReqType,
  ClearTariffsResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<ClearTariffsReqType>>,
  ): Promise<void> => {
    vcp.respond(
      this.response(call, {
        clearTariffsResult:
          call.payload.tariffIds?.map((tariffId) => ({
            tariffId: tariffId,
            status: "Accepted",
          })) ?? [],
      }),
    );
  };
}

export const clearTariffsOcppMessage = new ClearTariffsOcppMessage(
  "ClearTariffs",
  ClearTariffsReqSchema,
  ClearTariffsResSchema,
);
