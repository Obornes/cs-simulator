import { z } from "zod";
import { OcppCall, OcppMessage } from "../../ocppMessage";
import { VCP } from "../../vcp";
import {
  ComponentTypeSchema,
  StatusInfoTypeSchema,
  VariableTypeSchema,
} from "./_common";

const GetMonitoringReportReqSchema = z.object({
  requestId: z.number().int(),
  monitoringCriteria: z
    .array(
      z.enum(["ThresholdMonitoring", "DeltaMonitoring", "PeriodicMonitoring"]),
    )
    .max(3)
    .nullish(),
  componentVariable: z
    .array(
      z.object({
        component: ComponentTypeSchema,
        variable: VariableTypeSchema.nullish(),
      }),
    )
    .nullish(),
});
type GetMonitoringReportReqType = typeof GetMonitoringReportReqSchema;

const GetMonitoringReportResSchema = z.object({
  status: z.enum(["Accepted", "Rejected", "NotSupported", "EmptyResultSet"]),
  statusInfo: StatusInfoTypeSchema.nullish(),
});
type GetMonitoringReportResType = typeof GetMonitoringReportResSchema;

class GetMonitoringReportOcppMessage extends OcppMessage<
  GetMonitoringReportReqType,
  GetMonitoringReportResType
> {
  reqHandler = async (
    vcp: VCP,
    call: OcppCall<z.infer<GetMonitoringReportReqType>>,
  ): Promise<void> => {
    vcp.respond(this.response(call, { status: "Accepted" }));
  };
}

export const getMonitoringReportOcppMessage =
  new GetMonitoringReportOcppMessage(
    "GetMonitoringReport",
    GetMonitoringReportReqSchema,
    GetMonitoringReportResSchema,
  );
