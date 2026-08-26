import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { call as ocppCall } from "../../messageFactory";
import type { OcppCallResult } from "../../ocppMessage";
import { OcppVersion } from "../../ocppVersion";
import { VCP } from "../../vcp";
import { requestStartTransactionOcppIncoming } from "./requestStartTransaction";

type StartResponse = OcppCallResult<{ status: "Accepted" | "Rejected" }>;

function spyVcp(evses: { id: number; connectorIds: number[] }[]) {
  const vcp = new VCP({
    ocppVersion: OcppVersion.OCPP_2_1,
    endpoint: "ws://localhost",
    chargePointId: "TEST-1",
    evses,
  });
  const responses: StartResponse[] = [];
  vcp.respond = ((result: StartResponse) => {
    responses.push(result);
  }) as VCP["respond"];
  vcp.send = (() => {}) as VCP["send"];
  return { vcp, responses };
}

// A real bug can leave `startTransaction`'s periodic-MeterValues interval
// uncleared, which would otherwise hang the whole test run instead of just
// failing this one test - always run this, even when an assertion above threw.
function stopAllTransactions(vcp: VCP) {
  for (const id of vcp.transactionManager.transactions.keys()) {
    vcp.transactionManager.stopTransaction(id);
  }
}

function requestStart(evseId?: number, remoteStartId = 1) {
  return ocppCall("RequestStartTransaction", {
    evseId,
    remoteStartId,
    idToken: { idToken: "TAG-1", type: "Central" as const },
  });
}

describe("RequestStartTransaction (v21) - EVSE/connector resolution", () => {
  test("does not collide across different EVSEs sharing the same connectorId", async () => {
    const { vcp, responses } = spyVcp([
      { id: 1, connectorIds: [1] },
      { id: 2, connectorIds: [1, 2] },
    ]);

    try {
      await requestStartTransactionOcppIncoming.reqHandler(
        vcp,
        requestStart(1, 1),
      );
      await requestStartTransactionOcppIncoming.reqHandler(
        vcp,
        requestStart(2, 2),
      );

      assert.equal(responses[0].payload.status, "Accepted");
      assert.equal(responses[1].payload.status, "Accepted");
    } finally {
      stopAllTransactions(vcp);
    }
  });

  test("rejects once every connector under the requested EVSE is occupied", async () => {
    const { vcp, responses } = spyVcp([{ id: 1, connectorIds: [1] }]);

    try {
      await requestStartTransactionOcppIncoming.reqHandler(
        vcp,
        requestStart(1, 1),
      );
      await requestStartTransactionOcppIncoming.reqHandler(
        vcp,
        requestStart(1, 2),
      );

      assert.equal(responses[0].payload.status, "Accepted");
      assert.equal(responses[1].payload.status, "Rejected");
    } finally {
      stopAllTransactions(vcp);
    }
  });

  test("rejects when evseId is unknown", async () => {
    const { vcp, responses } = spyVcp([{ id: 1, connectorIds: [1] }]);

    try {
      await requestStartTransactionOcppIncoming.reqHandler(
        vcp,
        requestStart(99, 1),
      );

      assert.equal(responses[0].payload.status, "Rejected");
    } finally {
      stopAllTransactions(vcp);
    }
  });

  test("defaults to the VCP's first EVSE when evseId is omitted", async () => {
    const { vcp, responses } = spyVcp([{ id: 1, connectorIds: [1] }]);

    try {
      await requestStartTransactionOcppIncoming.reqHandler(
        vcp,
        requestStart(undefined, 1),
      );

      assert.equal(responses[0].payload.status, "Accepted");
    } finally {
      stopAllTransactions(vcp);
    }
  });
});
