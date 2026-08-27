import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import { connectFleet } from "./orchestrate";
import type { Station } from "./station";

function fakeStation(): {
  station: Station;
  connect: ReturnType<typeof mock.fn>;
} {
  const connect = mock.fn();
  return { station: { connect } as unknown as Station, connect };
}

describe("connectFleet", () => {
  test("calls connect() on every station within [0, staggerSeconds*1000]ms", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const fakes = [fakeStation(), fakeStation(), fakeStation()];
      connectFleet(
        fakes.map((f) => f.station),
        10,
      );

      for (const fake of fakes) {
        assert.equal(fake.connect.mock.calls.length, 0);
      }

      mock.timers.tick(10_000);

      for (const fake of fakes) {
        assert.equal(fake.connect.mock.calls.length, 1);
      }
    } finally {
      mock.timers.reset();
    }
  });

  test("never calls connect() once isShuttingDown() is true", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const fakes = [fakeStation(), fakeStation()];
      connectFleet(
        fakes.map((f) => f.station),
        10,
        () => true,
      );

      mock.timers.tick(10_000);

      for (const fake of fakes) {
        assert.equal(fake.connect.mock.calls.length, 0);
      }
    } finally {
      mock.timers.reset();
    }
  });
});
