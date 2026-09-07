import type { Station } from "../station";

// docs/fleet-loader-spec.md §7.6 — every console command extends this, one file per
// command, auto-discovered by qa/commands/index.ts's loadCommands().

export interface CommandContext {
  stations: Station[];
  shutdown: () => void;
}

export abstract class Command {
  abstract readonly name: string;
  abstract readonly usage: string;
  readonly aliases?: string[];
  abstract execute(
    args: string[],
    context: CommandContext,
  ): void | Promise<void>;
}
