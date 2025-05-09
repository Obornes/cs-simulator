import { z } from "zod";
import { OcppCall, OcppMessage } from "../../ocppMessage";
import { VCP } from "../../vcp";

const CertificateSignedReqSchema = z.object({
  certificateChain: z.string().max(10000),
});
type CertificateSignedReqType = typeof CertificateSignedReqSchema;

const CertificateSignedResSchema = z.object({
  status: z.enum(["Accepted", "Rejected"]),
});
type CertificateSignedResType = typeof CertificateSignedResSchema;

class CertificateSignedOcppMessage extends OcppMessage<
  CertificateSignedReqType,
  CertificateSignedResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<CertificateSignedReqType>>,
  ): Promise<void> => {
    vcp.respond(this.response(call, { status: "Accepted" }));
  };
}

export const certificateSignedOcppMessage = new CertificateSignedOcppMessage(
  "CertificateSigned",
  CertificateSignedReqSchema,
  CertificateSignedResSchema,
);
