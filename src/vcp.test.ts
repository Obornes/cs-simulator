import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { OcppVersion } from "./ocppVersion";
import { VCP } from "./vcp";

describe("VCP evse topology", () => {
  test("defaults to a single EVSE with a single connector when none is given", () => {
    const vcp = new VCP({
      ocppVersion: OcppVersion.OCPP_2_0_1,
      endpoint: "ws://localhost",
      chargePointId: "TEST-1",
    });

    assert.deepEqual(vcp.evses, [{ id: 1, connectorIds: [1] }]);
  });

  test("uses the provided evse topology when given", () => {
    const evses = [
      { id: 1, connectorIds: [1] },
      { id: 2, connectorIds: [1, 2] },
    ];
    const vcp = new VCP({
      ocppVersion: OcppVersion.OCPP_2_0_1,
      endpoint: "ws://localhost",
      chargePointId: "TEST-1",
      evses,
    });

    assert.deepEqual(vcp.evses, evses);
  });
});
