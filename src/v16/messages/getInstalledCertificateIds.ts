import { z } from "zod";
import { OcppCall, OcppMessage } from "../../ocppMessage";
import { VCP } from "../../vcp";

const GetInstalledCertificateIdsReqSchema = z.object({
  certificateType: z.enum([
    "CentralSystemRootCertificate",
    "ManufacturerRootCertificate",
  ]),
});
type GetInstalledCertificateIdsReqType =
  typeof GetInstalledCertificateIdsReqSchema;

const GetInstalledCertificateIdsResSchema = z.object({
  status: z.enum(["Accepted", "NotFound"]),
  certificateHashDataChain: z
    .array(
      z.object({
        hashAlgorithm: z.enum(["SHA256", "SHA384", "SHA512"]),
        issuerNameHash: z.string(),
        issuerKeyHash: z.string(),
        serialNumber: z.string(),
      }),
    )
    .nullish(),
});
type GetInstalledCertificateIdsResType =
  typeof GetInstalledCertificateIdsResSchema;

class GetInstalledCertificateIdsOcppMessage extends OcppMessage<
  GetInstalledCertificateIdsReqType,
  GetInstalledCertificateIdsResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<GetInstalledCertificateIdsReqType>>,
  ): Promise<void> => {
    vcp.respond(this.response(call, { status: "Accepted" }));
  };
}

export const getInstalledCertificateIdsOcppMessage =
  new GetInstalledCertificateIdsOcppMessage(
    "GetInstalledCertificateIds",
    GetInstalledCertificateIdsReqSchema,
    GetInstalledCertificateIdsResSchema,
  );
