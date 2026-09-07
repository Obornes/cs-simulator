import * as readline from "node:readline";
import type { Command, CommandContext } from "./commands/command";

// docs/fleet-loader-spec.md §7.2 — one dispatcher, three entry points (--exec CLI values,
// piped/scripted stdin, the interactive fleet> prompt), all calling this same function.
export async function dispatch(
  line: string,
  context: CommandContext,
  commands: Map<string, Command>,
): Promise<void> {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }
  const [name, ...args] = trimmed.split(/\s+/);
  const command = commands.get(name);
  if (!command) {
    console.log(
      `Unknown command "${name}". Available: ${Array.from(commands.keys()).sort().join(", ")}`,
    );
    return;
  }
  await command.execute(args, context);
}

// §7.2 — the --exec CLI flag's job: replay each given line through the same dispatcher,
// in order, before anything else starts.
export async function runExecLines(
  lines: string[],
  context: CommandContext,
  commands: Map<string, Command>,
): Promise<void> {
  for (const line of lines) {
    await dispatch(line, context, commands);
  }
}

/**
 * §7.2's readline wiring, unchanged from the spec's own pseudocode: rl.pause()/rl.resume()
 * around the await forces strictly sequential processing even when a whole piped file
 * arrives in one chunk. Whether this ends up looking interactive (a TTY), scripted (a pipe
 * with more lines), or does effectively nothing (stdin already at EOF) depends entirely on
 * stdin's real state — no branching needed here for any of those cases.
 */
export function startInteractiveConsole(
  context: CommandContext,
  commands: Map<string, Command>,
): readline.Interface {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "fleet> ",
  });

  rl.prompt();
  rl.on("line", async (line) => {
    rl.pause();
    await dispatch(line, context, commands);
    rl.prompt();
    rl.resume();
  });

  return rl;
}
