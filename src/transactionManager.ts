import type { VCP } from "./vcp";

const METER_VALUES_INTERVAL_SEC = 15;

type TransactionId = string | number;

export interface TransactionState {
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

export class TransactionManager {
  static START_INTERVAL = true;

  transactions: Map<
    TransactionId,
    TransactionState & { meterValuesTimer: ReturnType<typeof setInterval> | null }
  > = new Map();

  canStartNewTransaction(connectorId: number) {
    return !Array.from(this.transactions.values()).some(
      (transaction) => transaction.connectorId === connectorId,
    );
  }

  startTransaction(_vcp: VCP, startTransactionProps: StartTransactionProps) {
    const meterValuesTimer = TransactionManager.START_INTERVAL
      ? setInterval(() => {
          const currentTransactionState = this.transactions.get(
            startTransactionProps.transactionId,
          );

          if (!currentTransactionState) {
            return;
          }

          const { meterValuesTimer: _timer, ...currentTransaction } =
            currentTransactionState;

          startTransactionProps.meterValuesCallback({
            ...currentTransaction,
            meterValue: this.getMeterValue(startTransactionProps.transactionId),
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

  restoreTransaction(transactionState: TransactionState) {
    const existing = this.transactions.get(transactionState.transactionId);

    if (existing?.meterValuesTimer) {
      clearInterval(existing.meterValuesTimer);
    }

    this.transactions.set(transactionState.transactionId, {
      ...transactionState,
      meterValuesTimer: null,
    });
  }

  stopTransaction(transactionId: TransactionId) {
    const transaction = this.transactions.get(transactionId);

    if (transaction?.meterValuesTimer) {
      clearInterval(transaction.meterValuesTimer);
    }

    this.transactions.delete(transactionId);
  }

  stopAllTransactions() {
    for (const transaction of this.transactions.values()) {
      if (transaction.meterValuesTimer) {
        clearInterval(transaction.meterValuesTimer);
      }
    }

    this.transactions.clear();
  }

  getTransactionByConnector(connectorId: number) {
    return Array.from(this.transactions.values()).find(
      (transaction) => transaction.connectorId === connectorId,
    );
  }

  hasTransaction(transactionId: TransactionId) {
    return this.transactions.has(transactionId);
  }

  getMeterValue(transactionId: TransactionId) {
    const transaction = this.transactions.get(transactionId);

    if (!transaction) {
      return 0;
    }

    return (new Date().getTime() - transaction.startedAt.getTime()) / 100;
  }
}