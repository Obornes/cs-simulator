import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TransactionManager } from "./transactionManager";
import type { VCP } from "./vcp";

// TransactionManager.startTransaction never actually uses its `vcp` param.
const dummyVcp = {} as VCP;

describe("TransactionManager.canStartNewTransaction", () => {
  test("returns true when there are no transactions", () => {
    const manager = new TransactionManager();
    assert.equal(manager.canStartNewTransaction(1, 1), true);
  });

  test("returns false for a connector that already has a transaction on the same evseId", () => {
    const manager = new TransactionManager();
    manager.startTransaction(dummyVcp, {
      transactionId: "tx-1",
      idTag: "TAG-1",
      evseId: 1,
      connectorId: 1,
      meterValuesCallback: async () => {},
    });

    try {
      assert.equal(manager.canStartNewTransaction(1, 1), false);
    } finally {
      manager.stopTransaction("tx-1");
    }
  });

  test("does not collide across different EVSEs that happen to share a connectorId", () => {
    const manager = new TransactionManager();
    manager.startTransaction(dummyVcp, {
      transactionId: "tx-1",
      idTag: "TAG-1",
      evseId: 1,
      connectorId: 1,
      meterValuesCallback: async () => {},
    });

    try {
      // Same connectorId, different EVSE: a legal 2.0.1/2.1 topology that
      // must not read as "already occupied" - the bug this fixes.
      assert.equal(manager.canStartNewTransaction(2, 1), true);
    } finally {
      manager.stopTransaction("tx-1");
    }
  });

  test("OCPP 1.6 usage (evseId undefined) still detects a collision on connectorId alone", () => {
    const manager = new TransactionManager();
    manager.startTransaction(dummyVcp, {
      transactionId: "tx-1",
      idTag: "TAG-1",
      connectorId: 1,
      meterValuesCallback: async () => {},
    });

    try {
      assert.equal(manager.canStartNewTransaction(undefined, 1), false);
    } finally {
      manager.stopTransaction("tx-1");
    }
  });
});
