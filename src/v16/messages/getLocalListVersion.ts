import { z } from "zod";
import { OcppCall, OcppMessage } from "../../ocppMessage";
import { VCP } from "../../vcp";

const GetLocalListVersionReqSchema = z.object({});
type GetLocalListVersionReqType = typeof GetLocalListVersionReqSchema;

const GetLocalListVersionResSchema = z.object({
  listVersion: z.number().int(),
});
type GetLocalListVersionResType = typeof GetLocalListVersionResSchema;

class GetLocalListVersionOcppMessage extends OcppMessage<
  GetLocalListVersionReqType,
  GetLocalListVersionResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<GetLocalListVersionReqType>>,
  ): Promise<void> => {
    vcp.respond(this.response(call, { listVersion: 0 }));
  };
}

export const getLocalListVersionOcppMessage =
  new GetLocalListVersionOcppMessage(
    "GetLocalListVersion",
    GetLocalListVersionReqSchema,
    GetLocalListVersionResSchema,
  );
