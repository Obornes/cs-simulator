import type { VCP } from "./vcp";
import { meterValuesOcppMessage } from "./v16/messages/meterValues";
import { chargingProfileManager } from "./v16/chargingProfileManager";

const METER_VALUES_INTERVAL_SEC = 15;
const DEFAULT_POWER_WATTS = 11000;

interface TransactionState {
  transactionId: number;
  idTag: string;
  accumulatedEnergyWh: number;
  startedAt: Date;
  connectorId: number;
  meterValuesTimer?: NodeJS.Timer;
  lastUpdateTime: Date;
}

export class TransactionManager {
  transactions: Map<string, TransactionState> = new Map();

  canStartNewTransaction(connectorId: number) {
    return !Array.from(this.transactions.values()).some(
      (transaction) => transaction.connectorId === connectorId,
    );
  }

  startTransaction(
    vcp: VCP,
    transactionId: number,
    connectorId: number,
    idTag: string,
  ) {
    const startTime = new Date();
    const transactionState: TransactionState = {
      transactionId: transactionId,
      idTag: idTag,
      accumulatedEnergyWh: 0,
      startedAt: startTime,
      connectorId: connectorId,
      lastUpdateTime: startTime,
    };

    const meterValuesTimer = setInterval(() => {
      const currentTimestamp = new Date();
      const timeDiffHours =
        (currentTimestamp.getTime() - transactionState.lastUpdateTime.getTime()) /
        (1000 * 60 * 60);

      const powerLimit = chargingProfileManager.getPowerLimit(
        connectorId,
        transactionId,
        currentTimestamp,
      );

      let powerInWatts: number;
      if (powerLimit !== null) {
        powerInWatts = powerLimit;
      } else {
        powerInWatts = DEFAULT_POWER_WATTS;
      }

      if (powerInWatts > 0 && timeDiffHours > 0) {
        const energyIncrementWh = powerInWatts * timeDiffHours;
        transactionState.accumulatedEnergyWh += energyIncrementWh;
      }

      const currentEnergyKwh = transactionState.accumulatedEnergyWh / 1000;

      vcp.send(
        meterValuesOcppMessage.request({
          connectorId: connectorId,
          transactionId: transactionId,
          meterValue: [
            {
              timestamp: currentTimestamp.toISOString(),
              sampledValue: [
                {
                  value: powerInWatts.toString(),
                  measurand: "Power.Active.Import",
                  unit: "W",
                },
                {
                  value: currentEnergyKwh.toString(),
                  measurand: "Energy.Active.Import.Register",
                  unit: "kWh",
                },
              ],
            },
          ],
        }),
      );

      transactionState.lastUpdateTime = currentTimestamp;
    }, METER_VALUES_INTERVAL_SEC * 1000);

    transactionState.meterValuesTimer = meterValuesTimer;
    this.transactions.set(transactionId.toString(), transactionState);
  }

  stopTransaction(transactionId: number) {
    const transaction = this.transactions.get(transactionId.toString());
    if (transaction?.meterValuesTimer) {
      clearInterval(transaction.meterValuesTimer);
    }
    this.transactions.delete(transactionId.toString());
  }

  getMeterValue(transactionId: number) {
    const transaction = this.transactions.get(transactionId.toString());
    if (!transaction) {
      return 0;
    }
    return transaction.accumulatedEnergyWh;
  }
}

export const transactionManager = new TransactionManager();
