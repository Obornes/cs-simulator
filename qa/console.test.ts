import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Command, type CommandContext } from "./commands/command";
import { dispatch, runExecLines } from "./console";

class RecordingCommand extends Command {
  readonly name = "record";
  readonly usage = "record";
  calls: string[][] = [];
  execute(args: string[]): void {
    this.calls.push(args);
  }
}

function context(): CommandContext {
  return { stations: [], shutdown: () => {} };
}

describe("dispatch", () => {
  let originalLog: typeof console.log;
  let lines: string[];

  beforeEach(() => {
    originalLog = console.log;
    lines = [];
    console.log = (line: string) => {
      lines.push(line);
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test("routes a line to the matching command with tokenized args", async () => {
    const command = new RecordingCommand();
    await dispatch("record foo bar", context(), new Map([["record", command]]));
    assert.deepEqual(command.calls, [["foo", "bar"]]);
  });

  test("prints an unknown-command message and does not throw", async () => {
    await assert.doesNotReject(() => dispatch("nope", context(), new Map()));
    assert.match(lines[0], /Unknown command "nope"/);
  });

  test("ignores a blank line", async () => {
    const command = new RecordingCommand();
    await dispatch("   ", context(), new Map([["record", command]]));
    assert.deepEqual(command.calls, []);
  });
});

describe("runExecLines", () => {
  test("dispatches every line in order", async () => {
    const command = new RecordingCommand();
    await runExecLines(
      ["record 1", "record 2"],
      context(),
      new Map([["record", command]]),
    );
    assert.deepEqual(command.calls, [["1"], ["2"]]);
  });
});
