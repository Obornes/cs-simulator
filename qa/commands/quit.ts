import { Command, type CommandContext } from "./command";

// docs/fleet-loader-spec.md §7.3's `quit`/`exit`/`q` row — needed to make the already-
// documented `--exec "..." --exec "quit"` one-shot pattern (§7.2) actually terminate.
export default class QuitCommand extends Command {
  readonly name = "quit";
  readonly aliases = ["exit", "q"];
  readonly usage = "quit — gracefully shut down the fleet runner";

  execute(_args: string[], context: CommandContext): void {
    context.shutdown();
  }
}
