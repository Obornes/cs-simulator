import { z } from "zod";
import { OcppCall, OcppMessage } from "../../ocppMessage";
import { VCP } from "../../vcp";
import { StatusInfoTypeSchema } from "./_common";

const GetTariffsReqSchema = z.object({
  evseId: z.number().int().nonnegative(),
});
type GetTariffsReqType = typeof GetTariffsReqSchema;

const GetTariffsResSchema = z.object({
  status: z.enum(["Accepted", "Rejected", "NoTariff"]),
  tariffAssignments: z
    .array(
      z.object({
        tariffId: z.string().max(60),
        tariffKind: z.enum(["DefaultTariff", "DriverTariff"]),
        validFrom: z.string().datetime().nullish(),
        evseIds: z.array(z.number().int().nonnegative()).nullish(),
        idTokens: z.array(z.string().max(255)).nullish(),
      }),
    )
    .nullish(),
  statusInfo: StatusInfoTypeSchema.nullish(),
});
type GetTariffsResType = typeof GetTariffsResSchema;

class GetTariffsOcppMessage extends OcppMessage<
  GetTariffsReqType,
  GetTariffsResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<GetTariffsReqType>>,
  ): Promise<void> => {
    vcp.respond(this.response(call, { status: "NoTariff" }));
  };
}

export const getTariffsOcppMessage = new GetTariffsOcppMessage(
  "GetTariffs",
  GetTariffsReqSchema,
  GetTariffsResSchema,
);
