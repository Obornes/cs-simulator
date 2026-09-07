import { Command, type CommandContext } from "../command";

export default class PongCommand extends Command {
  readonly name = "pong";
  readonly aliases = ["pg"];
  readonly usage = "pong — fixture command for loadCommands() tests";
  execute(_args: string[], _context: CommandContext): void {}
}
