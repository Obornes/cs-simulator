import { z } from "zod";
import { OcppCall, OcppMessage } from "../../ocppMessage";
import { VCP } from "../../vcp";

const UpdateFirmwareReqSchema = z.object({
  location: z.string().url(),
  retries: z.number().int().nullish(),
  retrieveDate: z.string().datetime(),
  retryInterval: z.number().int().nullish(),
});
type UpdateFirmwareReqType = typeof UpdateFirmwareReqSchema;

const UpdateFirmwareResSchema = z.object({});
type UpdateFirmwareResType = typeof UpdateFirmwareResSchema;

class UpdateFirmwareOcppMessage extends OcppMessage<
  UpdateFirmwareReqType,
  UpdateFirmwareResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<UpdateFirmwareReqType>>,
  ): Promise<void> => {
    vcp.respond(this.response(call, {}));
  };
}

export const updateFirmwareOcppMessage = new UpdateFirmwareOcppMessage(
  "UpdateFirmware",
  UpdateFirmwareReqSchema,
  UpdateFirmwareResSchema,
);
