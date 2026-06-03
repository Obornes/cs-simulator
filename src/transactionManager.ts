import type { VCP } from "./vcp";
import { logger } from "./logger";

const METER_VALUES_INTERVAL_SEC = 15;

type TransactionId = string | number;

interface TransactionState {
  startedAt: Date;
  idTag: string;
  transactionId: TransactionId;
  meterValue: number;
  evseId?: number;
  connectorId: number;
}

interface StartTransactionProps {
  transactionId: TransactionId;
  idTag: string;
  evseId?: number;
  connectorId: number;
  meterValuesCallback: (transactionState: TransactionState) => Promise<void>;
}

type ManagedTransactionState = TransactionState & {
  meterValuesTimer: ReturnType<typeof setInterval> | null;
};

export class TransactionManager {
  static START_INTERVAL = true;

  transactions: Map<TransactionId, ManagedTransactionState> = new Map();

  canStartNewTransaction(connectorId: number) {
    return !Array.from(this.transactions.values()).some(
      (transaction) => transaction.connectorId === connectorId,
    );
  }

  startTransaction(vcp: VCP, startTransactionProps: StartTransactionProps) {
    /*
     * Avoid duplicate timers for the same transactionId if the backend/client
     * retries or if startTransaction is accidentally called twice.
     */
    this.stopTransaction(startTransactionProps.transactionId);

    const meterValuesTimer = TransactionManager.START_INTERVAL
      ? setInterval(() => {
          const currentTransactionState = this.transactions.get(
            startTransactionProps.transactionId,
          );

          if (!currentTransactionState) {
            return;
          }

          if (!vcp.isConnected()) {
            logger.info(
              `Stopping MeterValues interval for transaction ${startTransactionProps.transactionId}: VCP is not connected`,
            );
            this.stopTransaction(startTransactionProps.transactionId);
            return;
          }

          const { meterValuesTimer: _meterValuesTimer, ...currentTransaction } =
            currentTransactionState;

          void startTransactionProps
            .meterValuesCallback({
              ...currentTransaction,
              meterValue: this.getMeterValue(startTransactionProps.transactionId),
            })
            .catch((error) => {
              logger.error(
                `MeterValues callback failed for transaction ${startTransactionProps.transactionId}`,
                error,
              );
              /*
               * If sending MeterValues fails, stop this timer. Otherwise the
               * interval can keep firing forever and eventually crash/noise the
               * stress test.
               */
              this.stopTransaction(startTransactionProps.transactionId);
            });
        }, METER_VALUES_INTERVAL_SEC * 1000)
      : null;

    this.transactions.set(startTransactionProps.transactionId, {
      transactionId: startTransactionProps.transactionId,
      idTag: startTransactionProps.idTag,
      meterValue: 0,
      startedAt: new Date(),
      evseId: startTransactionProps.evseId,
      connectorId: startTransactionProps.connectorId,
      meterValuesTimer,
    });
  }

  stopTransaction(transactionId: TransactionId) {
    const transaction = this.transactions.get(transactionId);

    if (transaction?.meterValuesTimer) {
      clearInterval(transaction.meterValuesTimer);
    }

    this.transactions.delete(transactionId);
  }

  stopAllTransactions(reason?: string) {
    if (reason && this.transactions.size > 0) {
      logger.info(
        `Stopping ${this.transactions.size} active transaction timer(s). reason=${reason}`,
      );
    }

    for (const transactionId of Array.from(this.transactions.keys())) {
      this.stopTransaction(transactionId);
    }
  }

  getMeterValue(transactionId: TransactionId) {
    const transaction = this.transactions.get(transactionId);

    if (!transaction) {
      return 0;
    }

    return (new Date().getTime() - transaction.startedAt.getTime()) / 100;
  }
}
