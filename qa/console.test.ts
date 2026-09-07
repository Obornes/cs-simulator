import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Command, type CommandContext } from "./commands/command";
import { dispatch, runExecLines, startInteractiveConsole } from "./console";

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

class ThrowingCommand extends Command {
  readonly name = "boom";
  readonly usage = "boom";
  execute(): void {
    throw new Error("kaboom");
  }
}

describe("startInteractiveConsole", () => {
  test("a throwing command does not crash the console or wedge the prompt", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    const originalStdout = Object.getOwnPropertyDescriptor(process, "stdout");
    Object.defineProperty(process, "stdin", {
      value: input,
      configurable: true,
    });
    Object.defineProperty(process, "stdout", {
      value: output,
      configurable: true,
    });

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (err: unknown): void => {
      unhandledRejections.push(err);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    const originalLog = console.log;
    const logged: string[] = [];
    console.log = (line: string) => {
      logged.push(line);
    };

    let promptCount = 0;
    const secondPrompt = new Promise<void>((resolve) => {
      output.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("fleet> ")) {
          promptCount += 1;
          if (promptCount === 2) {
            resolve();
          }
        }
      });
    });

    const rl = startInteractiveConsole(
      context(),
      new Map([["boom", new ThrowingCommand()]]),
    );
    try {
      input.write("boom\n");
      await secondPrompt; // resolves only if the console reprompts after the throw
      // give the pending microtasks (including any stray unhandledRejection) a chance to fire
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandledRejections, []);
      assert.ok(logged.some((line) => line.includes("Command failed")));
    } finally {
      console.log = originalLog;
      rl.close();
      process.off("unhandledRejection", onUnhandledRejection);
      Object.defineProperty(
        process,
        "stdin",
        originalStdin as PropertyDescriptor,
      );
      Object.defineProperty(
        process,
        "stdout",
        originalStdout as PropertyDescriptor,
      );
    }
  });
});
