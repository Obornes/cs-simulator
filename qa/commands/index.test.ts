import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadCommands } from "./index";

const FIXTURES_DIR = join(__dirname, "__fixtures__");

describe("loadCommands", () => {
  test("registers valid commands by name and alias, skips invalid/test files", async () => {
    const commands = await loadCommands(FIXTURES_DIR);

    assert.deepEqual(Array.from(commands.keys()).sort(), [
      "pg",
      "ping",
      "pong",
    ]);
    assert.equal(commands.get("ping")?.name, "ping");
    assert.equal(commands.get("pong"), commands.get("pg")); // same instance, two keys
  });
});
