import { Command, type CommandContext } from "../command";

export default class PingCommand extends Command {
  readonly name = "ping";
  readonly usage = "ping — fixture command for loadCommands() tests";
  execute(_args: string[], _context: CommandContext): void {}
}
