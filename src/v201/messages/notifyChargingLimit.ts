import { z } from "zod";
import { OcppCall, OcppCallResult, OcppMessage } from "../../ocppMessage";
import { VCP } from "../../vcp";

const NotifyChargingLimitReqSchema = z.object({
  evseId: z.number().int().nullish(),
  chargingLimit: z.object({
    chargingLimitSource: z.enum(["EMS", "Other", "SO", "CSO"]),
    isGridCritical: z.boolean().nullish(),
  }),
  chargingSchedule: z
    .array(
      z.object({
        id: z.number().int(),
        startSchedule: z.string().datetime().nullish(),
        duration: z.number().int().nullish(),
        chargingRateUnit: z.enum(["W", "A"]),
        chargingSchedulePeriod: z.array(
          z.object({
            startPeriod: z.number().int(),
            limit: z.number(),
            numberPhases: z.number().int().nullish(),
            phaseToUse: z.number().int().nullish(),
          }),
        ),
        minChargingRate: z.number().nullish(),
        salesTariff: z
          .object({
            id: z.number().int(),
            salesTariffEntry: z.array(
              z.object({
                relativeTimeInterval: z.object({
                  start: z.number().int(),
                  duration: z.number().int().nullish(),
                }),
                ePriceLevel: z.number().int().nullish(),
                consumptionCost: z
                  .array(
                    z.object({
                      startValue: z.number(),
                      cost: z.number(),
                      type: z
                        .enum(["Carbon", "Relative", "RenewableEnergy"])
                        .nullish(),
                    }),
                  )
                  .nullish(),
              }),
            ),
          })
          .nullish(),
      }),
    )
    .nullish(),
});

type NotifyChargingLimitReqType = typeof NotifyChargingLimitReqSchema;

const NotifyChargingLimitResSchema = z.object({
  statusInfo: z
    .object({
      reasonCode: z.string().max(20),
      additionalInfo: z.string().max(512).nullish(),
    })
    .nullish(),
});

type NotifyChargingLimitResType = typeof NotifyChargingLimitResSchema;

class NotifyChargingLimitOcppMessage extends OcppMessage<
  NotifyChargingLimitReqType,
  NotifyChargingLimitResType
> {
  resHandler = async (
    _vcp: VCP,
    _call: OcppCall<z.infer<NotifyChargingLimitReqType>>,
    _result: OcppCallResult<z.infer<NotifyChargingLimitResType>>,
  ): Promise<void> => {
    // NOOP
  };
}

export const notifyChargingLimitOcppMessage =
  new NotifyChargingLimitOcppMessage(
    "NotifyChargingLimit",
    NotifyChargingLimitReqSchema,
    NotifyChargingLimitResSchema,
  );
