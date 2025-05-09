import { z } from "zod";
import { OcppCall, OcppCallResult, OcppMessage } from "../../ocppMessage";
import { VCP } from "../../vcp";
import { StatusInfoTypeSchema } from "./_common";

const CertificateSignedReqSchema = z.object({
  certificateChain: z.string().max(10000),
  certificateType: z
    .enum(["ChargeStationCertificate", "V2GCertificate"])
    .nullish(),
});
type CertificateSignedReqType = typeof CertificateSignedReqSchema;

const CertificateSignedResSchema = z.object({
  status: z.enum(["Accepted", "Rejected"]),
  statusInfo: StatusInfoTypeSchema.nullish(),
});
type CertificateSignedResType = typeof CertificateSignedResSchema;

class CertificateSignedOcppMessage extends OcppMessage<
  CertificateSignedReqType,
  CertificateSignedResType
> {
  resHandler = async (
    _vcp: VCP,
    _call: OcppCall<z.infer<CertificateSignedReqType>>,
    _result: OcppCallResult<z.infer<CertificateSignedResType>>,
  ): Promise<void> => {
    // NOOP
  };
}

export const certificateSignedOcppMessage = new CertificateSignedOcppMessage(
  "CertificateSigned",
  CertificateSignedReqSchema,
  CertificateSignedResSchema,
);
