import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../src/logger";
import { Command } from "./command";

const SKIP_FILES = new Set(["command.ts", "index.ts"]);

/**
 * docs/fleet-loader-spec.md §7.6 — scans `dir` (defaults to this module's own directory,
 * i.e. qa/commands/ in production; overridable in tests), dynamically imports every command
 * file, and registers each one's instance under its `name` and every entry in `aliases`.
 * A file that fails to produce a valid `Command` subclass is logged and skipped — it never
 * takes down the rest of the registry (same "degrade, don't crash" stance as the rest of
 * qa/'s loaders).
 */
export async function loadCommands(
  dir: string = __dirname,
): Promise<Map<string, Command>> {
  const commands = new Map<string, Command>();
  const files = await readdir(dir);

  for (const file of files) {
    if (
      SKIP_FILES.has(file) ||
      !file.endsWith(".ts") ||
      file.endsWith(".test.ts")
    ) {
      continue;
    }

    const mod = (await import(join(dir, file))) as { default?: unknown };
    const CommandClass = mod.default as (new () => Command) | undefined;
    if (
      typeof CommandClass !== "function" ||
      !(CommandClass.prototype instanceof Command)
    ) {
      logger.error(
        `qa/commands/${file} does not default-export a Command subclass — skipping`,
      );
      continue;
    }

    const instance = new CommandClass();
    for (const key of [instance.name, ...(instance.aliases ?? [])]) {
      commands.set(key, instance);
    }
  }

  return commands;
}
