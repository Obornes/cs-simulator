import assert from "node:assert/strict";
import { test } from "node:test";
import QuitCommand from "./quit";

test("QuitCommand calls context.shutdown() and exposes exit/q as aliases", () => {
  const command = new QuitCommand();
  let called = false;

  command.execute([], {
    stations: [],
    shutdown: () => {
      called = true;
    },
  });

  assert.equal(called, true);
  assert.deepEqual(command.aliases, ["exit", "q"]);
});
