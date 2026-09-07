# `qa/` List Command & Console Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a minimal `qa/` console (readline REPL + repeatable `--exec` CLI flag) with exactly two working commands — `list` (filterable by connection status, connector status, pool id, and protocol) and `quit`/`exit`/`q` — built on an auto-discovering command registry so future commands need zero central-map edits.

**Architecture:** A `Command` abstract base class (`qa/commands/command.ts`) plus a `CommandContext` (`{ stations: Station[], shutdown: () => void }`) that every command's `execute(args, context)` receives. `qa/commands/index.ts` scans its own directory at startup, dynamically imports every command file, and builds a `name -> Command` (and `alias -> Command`) registry — no hand-maintained map. `qa/console.ts` tokenizes a line and routes it through that registry (`dispatch`), reused identically for `--exec` CLI values, piped/scripted stdin, and the interactive `fleet>` prompt. `qa/run.ts` wires it all together, replacing its current "just keep the process alive" loop.

**Deviations from the spec doc, and why:**
- The spec (`docs/fleet-loader-spec.md` §7.2/§7.6/§9) illustrates the registry as `Map<string, Station>` passed directly to commands. The **actual, already-shipped** `qa/run.ts`/`qa/orchestrate.ts`/`qa/stats.ts` all use a plain `Station[]` (there is no `Map<string, Station>` anywhere in the real code — that was spec prose written before `qa/run.ts` existed in its current form). This plan follows the real, shipped pattern: `CommandContext.stations: Station[]`. `list` doesn't need id lookup; a future `status <stationId>`/`connect <stationId>` command can do `stations.find(s => s.id === id)`.
- `CommandContext` (a small object, not a bare positional param) is introduced so that adding a capability future commands need (e.g. `shutdown` here, later maybe "add a station to the fleet" for `spawn`) never requires changing `Command`'s abstract signature or touching every existing command file.
- This plan also implements the minimal `quit`/`exit`/`q` command (§7.3's table row), even though the spec's status block says only `list` is implemented this iteration. It's required to make the already-documented `--exec "list ..." --exec "quit"` one-shot pattern (§7.2) actually work, and it's tiny. Every other §7.3 command remains design-only.
- `--protocol=<v,...>` filter values match `OcppVersion`'s real enum strings (`OCPP_1.6`, `OCPP_2.0.1`, `OCPP_2.1`) — the exact values already on `StationSpec.ocppVersion` — not the lowercase `ocpp1.6` shorthand from the original (pre-this-iteration) §7.3 table row, which predates any real implementation and was never pinned down precisely enough to build against.

**Tech Stack:** TypeScript via `tsx` (no build step), Zod for schema validation, `node:test`/`node:assert/strict` for tests, only Node built-ins for the new code (`node:util`'s `parseArgs`, `node:readline`, `node:fs/promises`'s `readdir`) — no new npm dependencies.

**Spec:** `docs/fleet-loader-spec.md` — specifically §4b (`chargingPool`), §5.1 (`StationSpec.pool`), §7.2 (`--exec`), §7.3/§7.3.1 (`list`'s filters/output), §7.6 (command auto-discovery), §9 (file layout).

## Global Constraints

- `npm run check` (lint + format:check + typecheck + test) must pass after every task — run it (or at least the targeted test file) before each commit.
- Tests: `node:test` + `node:assert/strict`, files named `*.test.ts` living next to the code they cover (see `qa/station.test.ts` for the house style — `describe`/`test`, plain object-builder helpers, no mocking framework).
- No new npm dependencies — everything needed (`node:util`'s `parseArgs`, `node:readline`, `node:fs/promises`) is a Node built-in already implicitly available.
- Never call `station.connect()` in a test unless the test is specifically about connection behavior — it starts real timers (heartbeat/reconnect) that must be cleaned up via `station.destroy()` in a `finally`/`afterEach`, or the test process hangs (see root `CLAUDE.md`'s warning about this exact failure mode). None of the tests in this plan call `.connect()` — stations are constructed and their public `.state`/`.connectors` fields are set directly instead.
- Filter flag values are comma-separated within one flag occurrence (`--connector-status=charging,preparing`), never a repeated flag.

---

### Task 1: `StationSpec.pool` field

**Files:**
- Modify: `qa/manifest.ts`
- Test: `qa/manifest.test.ts`

**Interfaces:**
- Produces: `PoolSpecSchema` (not exported — internal to `qa/manifest.ts`), and `StationSpec.pool?: { id: string; name?: string }` on the existing `StationSpec` type. Every later task that reads `station.spec.pool` relies on this exact shape.

- [ ] **Step 1: Write the failing tests**

Add to `qa/manifest.test.ts` (alongside the existing `describe("StationSpecSchema", ...)` block — match its existing style):

```ts
test("accepts an optional pool with id and name", () => {
  const result = StationSpecSchema.parse({
    id: "SIM-0001",
    ocppVersion: OcppVersion.OCPP_1_6,
    connectorCount: 1,
    pool: { id: "SITE-42", name: "Site 42" },
  });
  assert.deepEqual(result.pool, { id: "SITE-42", name: "Site 42" });
});

test("accepts a pool with only an id (no name)", () => {
  const result = StationSpecSchema.parse({
    id: "SIM-0002",
    ocppVersion: OcppVersion.OCPP_1_6,
    connectorCount: 1,
    pool: { id: "SITE-42" },
  });
  assert.deepEqual(result.pool, { id: "SITE-42" });
});

test("pool is absent (not just undefined) from the parsed result when not given", () => {
  const result = StationSpecSchema.parse({
    id: "SIM-0003",
    ocppVersion: OcppVersion.OCPP_1_6,
    connectorCount: 1,
  });
  assert.equal("pool" in result, false);
});

test("rejects a pool with an empty id", () => {
  assert.throws(() =>
    StationSpecSchema.parse({
      id: "SIM-0004",
      ocppVersion: OcppVersion.OCPP_1_6,
      connectorCount: 1,
      pool: { id: "" },
    }),
  );
});
```

(These need `OcppVersion` and `assert`/`StationSpecSchema` already imported at the top of `qa/manifest.test.ts` — check the existing imports; they're already there for the other `StationSpecSchema` tests in that file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test qa/manifest.test.ts`
Expected: FAIL — `pool` isn't a recognized key yet (Zod's `StationSpecInputSchema` doesn't define it, so `result.pool` is `undefined` and the `deepEqual` assertions fail; the empty-id rejection test may also fail since an unrecognized extra key doesn't currently cause a parse error).

- [ ] **Step 3: Add the `pool` field to the schema**

In `qa/manifest.ts`, add a `PoolSpecSchema` right after `EvseSpecSchema`, and add a `pool` field to `StationSpecInputSchema`'s object:

```ts
const PoolSpecSchema = z.object({
  id: z.string().min(1), // chargingPool.id from the CPMS (§4b) — opaque grouping key, not OCPP
  name: z.string().optional(), // chargingPool.name — display only
});

const StationSpecInputSchema = z
  .object({
    id: z.string().min(1), // ocppChargingStationId — used verbatim as CP_ID
    ocppVersion: z.nativeEnum(OcppVersion),
    connectorCount: z.number().int().positive().optional(), // shorthand — see docs/fleet-loader-spec.md §5.1
    evses: z.array(EvseSpecSchema).min(1).optional(), // explicit real topology
    pool: PoolSpecSchema.optional(), // §4b for ONCE-sourced stations; hand-authored in a manifest, or omitted
  })
  .merge(BehaviorOverridesSchema)
  // ...(rest of the .refine() calls unchanged)
```

No change needed to the `.transform()` below it — `pool` passes through via `...rest` automatically since it's not destructured out like `connectorCount` is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test qa/manifest.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full check and commit**

Run: `npm run check`
Expected: all green

```bash
git add qa/manifest.ts qa/manifest.test.ts
git commit -m "feat(qa): add optional pool field to StationSpec"
```

---

### Task 2: Map ONCE's `chargingPool` into `StationSpec.pool`

**Files:**
- Modify: `qa/onceProvider.ts`
- Test: `qa/onceProvider.test.ts`

**Interfaces:**
- Consumes: `StationSpec.pool?: { id: string; name?: string }` (Task 1).
- Produces: `fetchOnceFleet()`'s returned `StationSpec[]` now carries `pool` when the raw CPMS response includes `chargingPool`.

**Critical gotcha — read before writing code:** Zod does **not** add a key to a parsed object for an absent optional field, but it **does** add the key (with value `undefined`) if you explicitly pass `pool: undefined` in the input object you hand to `.safeParse(...)`. Every existing test in `qa/onceProvider.test.ts` does `assert.deepEqual(result, [...])` against full `StationSpec` objects that have no `pool` key at all — if `mapStation` unconditionally writes `pool: raw.chargingPool` (which is `undefined` for every existing fixture, since none of them include `chargingPool`), those objects will end up with an explicit `pool: undefined` own-property and **every existing test in this file will start failing** on the `deepEqual` key-set mismatch. The fix: only add the `pool` key via conditional spread when `raw.chargingPool` is actually present.

- [ ] **Step 1: Write the failing test**

Add to `qa/onceProvider.test.ts`, alongside the existing `"maps a single page..."` test:

```ts
test("maps chargingPool into StationSpec.pool when present", async () => {
  mockFetch(() =>
    jsonResponse(200, {
      data: [
        {
          ocppChargingStationId: "SIM-0001",
          ocppVersion: "OCPP_2_0_1",
          chargingPoints: [
            { ocppEvseId: 1, connectors: [{ ocppConnectorId: 1 }] },
          ],
          chargingPool: { id: "SITE-42", name: "Site 42" },
        },
      ],
      pagination: { next: null },
    }),
  );

  const result = await fetchOnceFleet();

  assert.deepEqual(result[0].pool, { id: "SITE-42", name: "Site 42" });
});

test("leaves pool unset when chargingPool is absent (existing behavior, unchanged)", async () => {
  mockFetch(() =>
    jsonResponse(200, {
      data: [
        {
          ocppChargingStationId: "SIM-0001",
          ocppVersion: "OCPP_2_0_1",
          chargingPoints: [
            { ocppEvseId: 1, connectors: [{ ocppConnectorId: 1 }] },
          ],
        },
      ],
      pagination: { next: null },
    }),
  );

  const result = await fetchOnceFleet();

  assert.equal("pool" in result[0], false);
});
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `npx tsx --test qa/onceProvider.test.ts`
Expected: the new "maps chargingPool..." test FAILS (`result[0].pool` is `undefined`); the "leaves pool unset..." test and all pre-existing tests already PASS (nothing broken yet, since no code changed).

- [ ] **Step 3: Add `chargingPool` to the schema and map it**

In `qa/onceProvider.ts`, add a schema for the pool right after `OnceChargingPointSchema`, add it (optional) to `OnceChargingStationSchema`, and use it conditionally in `mapStation`:

```ts
const OnceChargingPoolSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
});

const OnceChargingStationSchema = z.object({
  ocppChargingStationId: z.string().min(1),
  ocppVersion: z.string().optional(),
  chargingPoints: z.array(OnceChargingPointSchema),
  // Always present on the real CPMS response (confirmed non-optional in
  // ChargingStationWithChargingPoolDto), but kept optional here defensively so a station
  // missing it in some edge case degrades to "no pool" rather than being skipped outright.
  chargingPool: OnceChargingPoolSchema.optional(),
});
```

Then in `mapStation`, change the `StationSpecSchema.safeParse({...})` call to conditionally include `pool`:

```ts
function mapStation(raw: OnceChargingStation): StationSpec | null {
  // ...(unchanged ocppVersion/evses resolution above)...

  const result = StationSpecSchema.safeParse({
    id: raw.ocppChargingStationId,
    ocppVersion,
    evses,
    // Conditional spread, not `pool: raw.chargingPool` — see this task's header gotcha:
    // explicitly passing `pool: undefined` would add an own `pool` key to the parsed
    // result even when chargingPool is absent, breaking every deepEqual test that expects
    // no pool key at all.
    ...(raw.chargingPool ? { pool: raw.chargingPool } : {}),
  });
  if (!result.success) {
    logger.warn(
      `Skipping ONCE station ${raw.ocppChargingStationId}: ${result.error}`,
    );
    return null;
  }
  return result.data;
}
```

- [ ] **Step 4: Run the tests to verify they pass, including all pre-existing ones**

Run: `npx tsx --test qa/onceProvider.test.ts`
Expected: PASS — all tests, old and new.

- [ ] **Step 5: Run the full check and commit**

Run: `npm run check`
Expected: all green

```bash
git add qa/onceProvider.ts qa/onceProvider.test.ts
git commit -m "feat(qa): map ONCE's chargingPool into StationSpec.pool"
```

---

### Task 3: `Command` base class + auto-discovering registry

**Files:**
- Create: `qa/commands/command.ts`
- Create: `qa/commands/index.ts`
- Create (fixtures, not real commands): `qa/commands/__fixtures__/pingCommand.ts`, `qa/commands/__fixtures__/pongCommand.ts`, `qa/commands/__fixtures__/notACommand.ts`, `qa/commands/__fixtures__/ignored.test.ts`
- Test: `qa/commands/index.test.ts`

**Interfaces:**
- Consumes: `Station` (`qa/station.ts`, already exists).
- Produces: `export interface CommandContext { stations: Station[]; shutdown: () => void }`, `export abstract class Command { abstract readonly name: string; abstract readonly usage: string; readonly aliases?: string[]; abstract execute(args: string[], context: CommandContext): void | Promise<void>; }` (`qa/commands/command.ts`), and `export async function loadCommands(dir?: string): Promise<Map<string, Command>>` (`qa/commands/index.ts`) — every later task's command files and `qa/console.ts`/`qa/run.ts` depend on these exact names/signatures.

- [ ] **Step 1: Create the base class**

`qa/commands/command.ts`:

```ts
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
```

- [ ] **Step 2: Create fixture command files (not real commands — test-only)**

`qa/commands/__fixtures__/pingCommand.ts`:

```ts
import { Command, type CommandContext } from "../command";

export default class PingCommand extends Command {
  readonly name = "ping";
  readonly usage = "ping — fixture command for loadCommands() tests";
  execute(_args: string[], _context: CommandContext): void {}
}
```

`qa/commands/__fixtures__/pongCommand.ts`:

```ts
import { Command, type CommandContext } from "../command";

export default class PongCommand extends Command {
  readonly name = "pong";
  readonly aliases = ["pg"];
  readonly usage = "pong — fixture command for loadCommands() tests";
  execute(_args: string[], _context: CommandContext): void {}
}
```

`qa/commands/__fixtures__/notACommand.ts` (deliberately does NOT extend `Command` — proves `loadCommands` skips it instead of crashing):

```ts
export default class NotACommand {
  name = "not-a-command";
}
```

`qa/commands/__fixtures__/ignored.test.ts` (proves `loadCommands` skips `*.test.ts` files; also runs harmlessly as its own no-op test since it matches `npm run test`'s `qa/**/*.test.ts` glob):

```ts
import { test } from "node:test";

// Fixture only — proves loadCommands() skips *.test.ts files when scanning a commands
// directory (qa/commands/index.test.ts). Also a valid no-op test in its own right, since
// this file's name matches npm run test's glob.
test("fixture placeholder — not a real test", () => {});
```

- [ ] **Step 3: Write the failing test for `loadCommands`**

`qa/commands/index.test.ts`:

```ts
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadCommands } from "./index";

const FIXTURES_DIR = join(__dirname, "__fixtures__");

describe("loadCommands", () => {
  test("registers valid commands by name and alias, skips invalid/test files", async () => {
    const commands = await loadCommands(FIXTURES_DIR);

    assert.deepEqual(Array.from(commands.keys()).sort(), ["pg", "ping", "pong"]);
    assert.equal(commands.get("ping")?.name, "ping");
    assert.equal(commands.get("pong"), commands.get("pg")); // same instance, two keys
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx tsx --test qa/commands/index.test.ts`
Expected: FAIL — `./index` (i.e. `qa/commands/index.ts`) doesn't exist yet.

- [ ] **Step 5: Implement `loadCommands`**

`qa/commands/index.ts`:

```ts
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
    if (SKIP_FILES.has(file) || !file.endsWith(".ts") || file.endsWith(".test.ts")) {
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
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx tsx --test qa/commands/index.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full check and commit**

Run: `npm run check`
Expected: all green (the fixture `.test.ts` file will show up in the overall `npm run test` output as one extra passing "fixture placeholder" test — expected, not a regression)

```bash
git add qa/commands/command.ts qa/commands/index.ts qa/commands/index.test.ts qa/commands/__fixtures__
git commit -m "feat(qa): add Command base class and auto-discovering command registry"
```

---

### Task 4: `list` command

**Files:**
- Create: `qa/commands/list.ts`
- Test: `qa/commands/list.test.ts`

**Interfaces:**
- Consumes: `Command`, `CommandContext` (Task 3); `Station`, `ConnectorRuntime` (`qa/station.ts`, unchanged); `StationSpec.pool` (Task 1); `OcppVersion` (`src/ocppVersion.ts`, unchanged).
- Produces: default export `ListCommand`, `name: "list"` — registered automatically by `loadCommands()` (Task 3) once this file exists in `qa/commands/`.

- [ ] **Step 1: Write the failing tests**

`qa/commands/list.test.ts`:

```ts
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { OcppVersion } from "../../src/ocppVersion";
import type { CommandContext } from "./command";
import type { StationSpec } from "../manifest";
import { Station } from "../station";
import ListCommand from "./list";

function spec(overrides: Partial<StationSpec> = {}): StationSpec {
  return {
    id: "SIM-0001",
    ocppVersion: OcppVersion.OCPP_1_6,
    evses: [{ id: 1, connectorIds: [1] }],
    ...overrides,
  };
}

function context(stations: Station[]): CommandContext {
  return { stations, shutdown: () => {} };
}

describe("ListCommand", () => {
  let originalLog: typeof console.log;
  let lines: string[];
  const command = new ListCommand();

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

  test("prints one row per connector, EVSE=N/A for 1.6, POOL=N/A when unset", () => {
    const station16 = new Station(
      spec({ id: "SIM-0007", evses: [{ id: 1, connectorIds: [1, 2] }] }),
    );
    const station201 = new Station(
      spec({
        id: "MULTI-0001",
        ocppVersion: OcppVersion.OCPP_2_0_1,
        evses: [{ id: 3, connectorIds: [1] }],
        pool: { id: "SITE-42", name: "Site 42" },
      }),
    );
    const stationPoolIdOnly = new Station(
      spec({
        id: "POOL-ID-ONLY",
        ocppVersion: OcppVersion.OCPP_2_0_1,
        evses: [{ id: 1, connectorIds: [1] }],
        pool: { id: "SITE-99" },
      }),
    );

    command.execute([], context([station16, station201, stationPoolIdOnly]));

    const body = lines.slice(1); // drop the header row
    assert.equal(body.length, 4); // 2 connectors on SIM-0007 + 1 each on the other two

    assert.match(body[0], /SIM-0007\s+N\/A\s+1\s+disconnected\s+available\s+OCPP_1\.6\s+N\/A/);
    assert.match(body[1], /SIM-0007\s+N\/A\s+2\s+disconnected\s+available\s+OCPP_1\.6\s+N\/A/);
    assert.match(body[2], /MULTI-0001\s+3\s+1\s+disconnected\s+available\s+OCPP_2\.0\.1\s+Site 42/);
    assert.match(body[3], /POOL-ID-ONLY\s+1\s+1\s+disconnected\s+available\s+OCPP_2\.0\.1\s+SITE-99/);
  });

  test("--connection-status filters out non-matching stations entirely", () => {
    const connected = new Station(spec({ id: "CONNECTED-ONE" }));
    connected.state = "connected";
    const disconnected = new Station(spec({ id: "DISCONNECTED-ONE" }));

    command.execute(
      ["--connection-status=connected"],
      context([connected, disconnected]),
    );

    const body = lines.slice(1);
    assert.equal(body.length, 1);
    assert.match(body[0], /CONNECTED-ONE/);
  });

  test("--connector-status accepts comma-separated values (OR within the flag)", () => {
    const station = new Station(
      spec({ id: "MULTI-CONN", evses: [{ id: 1, connectorIds: [1, 2, 3] }] }),
    );
    station.connectors.get("1:1")!.status = "charging";
    station.connectors.get("1:2")!.status = "preparing";
    station.connectors.get("1:3")!.status = "available";

    command.execute(
      ["--connector-status=charging,preparing"],
      context([station]),
    );

    const body = lines.slice(1);
    assert.equal(body.length, 2);
    assert.ok(body.every((line) => !/available/.test(line)));
  });

  test("combines connection-status and connector-status with AND", () => {
    const disconnectedButChargingStale = new Station(spec({ id: "STALE" }));
    disconnectedButChargingStale.connectors.get("1:1")!.status = "charging";
    // station.state stays "disconnected" — a charging connector on a disconnected station

    const connectedAndCharging = new Station(spec({ id: "LIVE" }));
    connectedAndCharging.state = "connected";
    connectedAndCharging.connectors.get("1:1")!.status = "charging";

    command.execute(
      ["--connection-status=connected", "--connector-status=charging"],
      context([disconnectedButChargingStale, connectedAndCharging]),
    );

    const body = lines.slice(1);
    assert.equal(body.length, 1);
    assert.match(body[0], /LIVE/);
  });

  test("--pool-id filters by pool id; a pool-less station never matches an active filter", () => {
    const withPool = new Station(
      spec({
        id: "HAS-POOL",
        ocppVersion: OcppVersion.OCPP_2_0_1,
        pool: { id: "SITE-42" },
      }),
    );
    const withoutPool = new Station(spec({ id: "NO-POOL" }));

    command.execute(["--pool-id=SITE-42"], context([withPool, withoutPool]));

    const body = lines.slice(1);
    assert.equal(body.length, 1);
    assert.match(body[0], /HAS-POOL/);
  });

  test("an unknown flag prints a usage error and produces no rows", () => {
    const station = new Station(spec());

    command.execute(["--bogus=1"], context([station]));

    assert.equal(lines.length, 1);
    assert.match(lines[0], /Unknown flag "--bogus"/);
    assert.match(lines[0], new RegExp(command.usage.replace(/[[\]]/g, "\\$&")));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test qa/commands/list.test.ts`
Expected: FAIL — `./list` doesn't exist yet.

- [ ] **Step 3: Implement `ListCommand`**

`qa/commands/list.ts`:

```ts
import { OcppVersion } from "../../src/ocppVersion";
import { Command, type CommandContext } from "./command";

const FLAG_NAMES = [
  "connection-status",
  "connector-status",
  "pool-id",
  "protocol",
] as const;
type FlagName = (typeof FLAG_NAMES)[number];
type ParsedFilters = Record<FlagName, string[]>;

function parseFilters(args: string[]): ParsedFilters | { error: string } {
  const filters: ParsedFilters = {
    "connection-status": [],
    "connector-status": [],
    "pool-id": [],
    protocol: [],
  };

  for (const arg of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) {
      return { error: `Unrecognized argument "${arg}"` };
    }
    const [, flag, value] = match;
    if (!(FLAG_NAMES as readonly string[]).includes(flag)) {
      return { error: `Unknown flag "--${flag}"` };
    }
    filters[flag as FlagName] = value.split(",");
  }

  return filters;
}

function matchesFilter(values: string[], actual: string): boolean {
  return values.length === 0 || values.includes(actual);
}

const COLUMNS = [
  "STATION",
  "EVSE",
  "CONNECTOR",
  "CONN-STATUS",
  "CONNECTOR-STATUS",
  "PROTOCOL",
  "POOL",
];

function printTable(rows: string[][]): void {
  const widths = COLUMNS.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i].length)),
  );
  const formatRow = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] + 2)).join("");

  console.log(formatRow(COLUMNS));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

// docs/fleet-loader-spec.md §7.3.1 — the only implemented console command this iteration.
export default class ListCommand extends Command {
  readonly name = "list";
  readonly usage =
    "list [--connection-status=<v,...>] [--connector-status=<v,...>] [--pool-id=<v,...>] [--protocol=<v,...>]";

  execute(args: string[], context: CommandContext): void {
    const filters = parseFilters(args);
    if ("error" in filters) {
      console.log(`${filters.error}\nUsage: ${this.usage}`);
      return;
    }

    const rows: string[][] = [];
    for (const station of context.stations) {
      const poolIdForFilter = station.spec.pool?.id ?? "";
      const stationMatches =
        matchesFilter(filters.protocol, station.spec.ocppVersion) &&
        matchesFilter(filters["connection-status"], station.state) &&
        matchesFilter(filters["pool-id"], poolIdForFilter);
      if (!stationMatches) {
        continue;
      }

      for (const connector of station.connectors.values()) {
        if (!matchesFilter(filters["connector-status"], connector.status)) {
          continue;
        }
        const evseDisplay =
          station.spec.ocppVersion === OcppVersion.OCPP_1_6
            ? "N/A"
            : String(connector.evseId);
        const poolDisplay =
          station.spec.pool?.name ?? station.spec.pool?.id ?? "N/A";
        rows.push([
          station.id,
          evseDisplay,
          String(connector.connectorId),
          station.state,
          connector.status,
          station.spec.ocppVersion,
          poolDisplay,
        ]);
      }
    }

    printTable(rows);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test qa/commands/list.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full check and commit**

Run: `npm run check`
Expected: all green

```bash
git add qa/commands/list.ts qa/commands/list.test.ts
git commit -m "feat(qa): add the list console command with filter/output support"
```

---

### Task 5: `quit`/`exit`/`q` command

**Files:**
- Create: `qa/commands/quit.ts`
- Test: `qa/commands/quit.test.ts`

**Interfaces:**
- Consumes: `Command`, `CommandContext` (Task 3).
- Produces: default export `QuitCommand`, `name: "quit"`, `aliases: ["exit", "q"]`.

- [ ] **Step 1: Write the failing test**

`qa/commands/quit.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import QuitCommand from "./quit";

test("QuitCommand calls context.shutdown() and exposes exit/q as aliases", () => {
  const command = new QuitCommand();
  let called = false;

  command.execute([], { stations: [], shutdown: () => { called = true; } });

  assert.equal(called, true);
  assert.deepEqual(command.aliases, ["exit", "q"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test qa/commands/quit.test.ts`
Expected: FAIL — `./quit` doesn't exist yet.

- [ ] **Step 3: Implement `QuitCommand`**

`qa/commands/quit.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test qa/commands/quit.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full check and commit**

Run: `npm run check`
Expected: all green

```bash
git add qa/commands/quit.ts qa/commands/quit.test.ts
git commit -m "feat(qa): add the quit/exit/q console command"
```

---

### Task 6: Console dispatcher (`qa/console.ts`)

**Files:**
- Create: `qa/console.ts`
- Test: `qa/console.test.ts`

**Interfaces:**
- Consumes: `Command`, `CommandContext` (Task 3).
- Produces: `export function dispatch(line: string, context: CommandContext, commands: Map<string, Command>): Promise<void>`, `export function runExecLines(lines: string[], context: CommandContext, commands: Map<string, Command>): Promise<void>`, `export function startInteractiveConsole(context: CommandContext, commands: Map<string, Command>): readline.Interface` — `qa/run.ts` (Task 7) calls all three.

**Testing note:** `startInteractiveConsole` only wires up `readline` (prompt/line/pause/resume plumbing) — it contains no branching logic of its own, so it is verified manually in Task 7 rather than by an automated test (driving a real TTY reliably inside `node:test` isn't practical). `dispatch` and `runExecLines`, which hold all the actual logic, are fully unit tested here.

- [ ] **Step 1: Write the failing tests**

`qa/console.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test qa/console.test.ts`
Expected: FAIL — `./console` doesn't exist yet.

- [ ] **Step 3: Implement `qa/console.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test qa/console.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full check and commit**

Run: `npm run check`
Expected: all green

```bash
git add qa/console.ts qa/console.test.ts
git commit -m "feat(qa): add the console dispatcher (dispatch, runExecLines, startInteractiveConsole)"
```

---

### Task 7: Wire `qa/run.ts` — `--exec` flag, command registry, console startup

**Files:**
- Modify: `qa/run.ts`

**Interfaces:**
- Consumes: `loadCommands` (Task 3), `runExecLines`/`startInteractiveConsole` (Task 6), `CommandContext` (Task 3).
- No automated test for this file — see the "No test for `qa/run.ts`" note below. Verified manually (Step 4).

**Note — no automated test for `qa/run.ts`:** this file is the process entry point; it calls `main().catch(...)` at module scope, so merely importing it in a test would try to actually run it (spawn timers, register `SIGINT` handlers, potentially `process.exit`). No test exists for it today for the same reason — this plan follows that existing convention rather than introducing one.

- [ ] **Step 1: Read the current file**

Open `qa/run.ts` and confirm it still matches the version this plan was written against (imports of `CONFIG`/`resolveStaggerSeconds`/`loadFleetFromConfig`/`connectFleet`/`Station`/`logInfo`/`printProgress`, a `main()` with an early `return` when `specs.length === 0`, and a `shutdown` closure defined near the bottom). If it has diverged significantly, stop and re-plan this task instead of guessing.

- [ ] **Step 2: Rewrite `main()`**

Replace the full contents of `qa/run.ts` with:

```ts
import { parseArgs } from "node:util";
import { loadCommands } from "./commands";
import type { CommandContext } from "./commands/command";
import { CONFIG, resolveStaggerSeconds } from "./config";
import { runExecLines, startInteractiveConsole } from "./console";
import { loadFleetFromConfig } from "./loadFleetFromConfig";
import { connectFleet } from "./orchestrate";
import { Station } from "./station";
import { logInfo, printProgress } from "./stats";

const PROGRESS_INTERVAL_MS = 15_000;

let shuttingDown = false;

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { exec: { type: "string", multiple: true, default: [] } },
    strict: false,
  });
  const execLines = values.exec as string[];

  const specs = await loadFleetFromConfig();
  if (specs.length === 0) {
    logInfo(
      "qa",
      "No stations to simulate — configure MANIFEST_FILE and/or ONCE_API_URL/ONCE_API_KEY.",
    );
  }

  const stations = specs.map((spec) => new Station(spec));
  const staggerSeconds = resolveStaggerSeconds(stations.length);

  logInfo(
    "qa",
    `Starting ${stations.length} station(s), staggered over 0-${staggerSeconds}s (WS_URL=${CONFIG.wsUrl})...`,
  );
  connectFleet(stations, staggerSeconds, () => shuttingDown);

  const progressTimer = setInterval(
    () => printProgress(stations),
    PROGRESS_INTERVAL_MS,
  );

  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(progressTimer);
    logInfo("qa", "Shutting down...");
    for (const station of stations) {
      station.destroy();
    }
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const commands = await loadCommands();
  const context: CommandContext = { stations, shutdown };
  await runExecLines(execLines, context, commands);
  startInteractiveConsole(context, commands);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Note the one behavior change from the current file, called out explicitly: the early `return` after the "No stations to simulate" log is **removed** — the function now falls through to console startup with an empty `stations` array. This is deliberate: it's what makes `npx tsx qa/run.ts --exec "list" --exec "quit"` runnable with zero configured stations (Step 4 below), and an empty-fleet `list`/console session is harmless (an empty table, `quit` still works).

- [ ] **Step 3: Run the full check**

Run: `npm run check`
Expected: all green (typecheck in particular — this step has no dedicated automated test, so `tsc` catching a signature mismatch here is the safety net)

- [ ] **Step 4: Manually verify the wiring end-to-end**

Run (no `.env`/`MANIFEST_FILE`/`ONCE_API_URL` needed for this check):

```bash
npx tsx qa/run.ts --exec "list" --exec "quit"
```

Expected output: a log line `[qa] No stations to simulate — configure MANIFEST_FILE and/or ONCE_API_URL/ONCE_API_KEY.`, then a `list` table with just the header row (no data rows, since there are zero stations), then the process exits cleanly (no hang, no error) within ~1 second (the `quit` command's `shutdown()` schedules `process.exit(0)` after 500ms).

Also verify an unknown command doesn't crash the run:

```bash
npx tsx qa/run.ts --exec "bogus" --exec "quit"
```

Expected: prints `Unknown command "bogus". Available: exit, list, q, quit` (alphabetically sorted, since `dispatch` sorts the key list), then still runs `quit` and exits cleanly.

- [ ] **Step 5: Commit**

```bash
git add qa/run.ts
git commit -m "feat(qa): wire --exec, the command registry, and console startup into run.ts"
```

---

## Final Verification

- [ ] Run `npm run check` one more time from a clean `git status` (nothing uncommitted) to confirm the whole sequence of commits leaves the repo green end-to-end.
- [ ] Re-run both manual commands from Task 7 Step 4 one more time as a final smoke test.
