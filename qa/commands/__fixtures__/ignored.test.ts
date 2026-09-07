import { test } from "node:test";

// Fixture only — proves loadCommands() skips *.test.ts files when scanning a commands
// directory (qa/commands/index.test.ts). Also a valid no-op test in its own right, since
// this file's name matches npm run test's glob.
test("fixture placeholder — not a real test", () => {});
