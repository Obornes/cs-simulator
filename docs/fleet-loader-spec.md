# Fleet Loader & Console — Spec (`qa/`)

Status: draft. Consolidates a design discussion. Implemented so far:
- §4 (both sources, unioned, plus the regex include/exclude pass) and §5.1/§5.2 (schemas) —
  `qa/manifest.ts`, `qa/onceProvider.ts`, `qa/regexFilter.ts`, `qa/fleetSource.ts`, `qa/config.ts`.
  `loadFleet()` takes optional `cliIncludePatterns`/`cliExcludePatterns` (§8.3's CLI-flag side) as
  parameters rather than reading `process.argv` itself — the `--include`/`--exclude` CLI flags
  themselves still aren't wired up in `qa/run.ts`.
- §6.1's connector-aware `Station` and its boot sequence, and §6.2's staggered connection
  fan-out/failure isolation/progress reporting — `qa/station.ts`, `qa/orchestrate.ts`, `qa/stats.ts`,
  `qa/run.ts`. **Not yet implemented**: any charging-session logic (§6.1's `tick()`,
  `startChargingSession`, `disconnectCheck`) or charge-point-initiated command handling
  (`RemoteStart/StopTransaction`, `RequestStart/StopTransaction` — every incoming Call is currently
  answered with a `NotImplemented` CallError so the CSMS doesn't hang).
- §7's own first scoped-down iteration: a minimal console — `node:readline` wiring plus the `--exec`
  CLI flag (`parseArgs` in `qa/run.ts`, §7.2), quitting cleanly via `quit`/`exit`/`q` (§7.3) before
  ever starting the interactive prompt — an auto-discovering command registry (§7.6,
  `qa/commands/index.ts`'s `loadCommands()`), and exactly two real commands: `list`, with its
  `--connection-status`/`--connector-status`/`--pool-id`/`--protocol` filters (§7.3.1) and the new
  `StationSpec.pool` field it depends on (§5.1), and `quit`/`exit`/`q` (`qa/commands/quit.ts`) to
  terminate the process. `qa/run.ts` wires it all together: load the fleet, connect it, run any
  `--exec` lines through the dispatcher, then start the interactive console (skipped if `quit` already
  fired during `--exec`).

All with tests (`npm run check`). Every OTHER command in §7.3's table (`status`, `stats`, `connect`,
`disconnect`, `reset`, `start`, `stop`, `scenario`, `spawn`, `remove`) remains design-only, as does
`qa/scenarios.ts` and the rest of §9's unimplemented files.

Lives in a new, independent top-level `qa/` directory — not inside `demo/`. `demo/` is left
untouched: it keeps serving its original purpose (broad network/chaos load testing). `qa/` is a
separate tool, modeled after `demo/`'s patterns (single-process, in-memory, lightweight `Station`)
but built fresh for connector-aware, manifest/CPMS-driven, console-controlled scenarios — see §9.

## 1. Problem

Today, a simulation scenario in this repo is a hand-written `index_xxx.ts` file: one hardcoded
`VCP`, one hardcoded message sequence. Adding a new scenario means duplicating a file
(`index_16.ts`, `index_16_2_connectors.ts`, `index_16_stress.ts`, ...). `demo/` improves on this
for large-fleet load testing (env-var-driven, spawns up to thousands of `Station` objects in one
process), but its station IDs are locally generated (`demo/station.ts:generateStationId`) and its
per-station behavior is hardcoded to a single connector.

We want to:
- describe a fleet of stations to simulate from **data**, not from a new source file per scenario,
  either as an explicit list or fetched **directly from the CPMS** (ONCE / `obornes-cpo-backbone`);
- narrow either source with **regex-based include/exclude filters** — e.g. "only stations matching
  `^SIM-`" or "everything except these 3 test-bench stations" — rather than hand-maintaining exact ID
  lists;
- drive the fleet **interactively** (console/REPL) in addition to unattended scripted scenarios,
  reusing the same running instances instead of only firing HTTP admin commands one-off.

## 2. Goals

- A fleet description that combines an explicit static list *and* a live CPMS query (both always
  active, unioned — §4), plus regex include/exclude filters, without changing the runtime station
  model.
- Adopt the same single-process, in-memory `Station` model `demo/` pioneered (cheap, easy to
  introspect/console into) rather than the one-process-per-VCP model (`index_*.ts` + HTTP admin
  API) — but as an **independent implementation in `qa/`**, not by modifying `demo/` itself (§9).
- A console/CLI that operates on the **same in-memory registry** the fleet runner already holds —
  no HTTP round-trip needed for local scripting or manual interaction.

## 3. Non-goals (for this iteration)

- Replacing `index_*.ts` scenarios — they stay as minimal, self-contained repro scripts.
- Building a station-provisioning tool for the CPMS (creating stations server-side). This spec only
  covers *reading* the existing fleet, never writing it.
- Solving the OCPP-proxy identity-aliasing idea explored earlier (routing N simulated IDs to one
  real CPMS identity via `rename` in `obornes-ocpp-proxy`) — rejected: real CSMS/CPMS treat a
  chargingStationId connection as 1:1, so concurrent renamed connections would just evict each
  other. The correct multiplexing axis is connectors-per-station (§6), not identity aliasing.

## 4. Source of truth for "what to simulate"

**All three mechanisms below are always active at the same time — this isn't "pick one source",
it's "gather from both, then filter."** `qa/fleetSource.ts` always: (1) reads the explicit-list file
if one is configured, (2) fetches from the CPMS if credentials are configured, (3) unions the two
into one `StationSpec[]`, then (4) runs that union through the include/exclude regex pass. Each of
the three pieces degrades to a safe no-op when unconfigured, rather than erroring — see the
"if unconfigured" callout in each subsection.

### 4a. Explicit list

A JSON file, Zod-validated (consistent with the rest of this repo), listing station specs directly
(§5.2) — same `StationSpec[]` shape the CPMS source produces (§4b), so both can be unioned without
the runtime caring which one a given entry came from.

**If unconfigured:** no manifest file path given → contributes an empty list. Not an error — this is
the expected shape for "CPMS-only, no explicit list."

### 4b. CPMS-fetched

Fetched from `obornes-cpo-backbone`'s public API. Contract confirmed by reading the source:

- **Route:** `POST /_external/api/v1/charging-stations/rsql-list?page=1&limit=1000`
  (`src/public-api/api/charging-infrastructure/charging-stations/rsql-list/charging-station-rsql.controller.ts`
  in `obornes-cpo-backbone`). `limit` is capped at 1000 (`PaginationDto`) — loop pages for larger fleets.
- **Auth:** header `x-api-key: <key>` (legacy `Authorization` header also accepted, but marked
  backwards-compat only in `PublicApiGuard`). The key needs the `ChargingStation.Read` permission.
  If the target environment has multitenancy on, also send `X-Tenant-Id: <slug>`.
- **Body** (`RsqlFilterBodyDto`): the full paginated list is fetched with no `ocppChargingStationId`
  filter in the request body — station selection now happens client-side via regex (§4c), not
  server-side RSQL, since RSQL can't express arbitrary regex (see the note below). Non-id filters
  (e.g. `status == 'ONLINE'`) can still optionally be added to `filter` as a server-side narrowing
  step before the regex pass, if useful.
- **Response:** `PaginatedResult<PublicChargingStationListItemDto>` →
  `{ data: [...], pagination: { page, limit, totalPages, totalCount, offset, previous, next } }`
  (`src/common/pagination/paginated-result.dto.ts` — corrected from an earlier `meta` assumption;
  `meta`/`MetaResponse` is only used on the non-RSQL backoffice listing endpoint, not this one).
  Relevant fields per item (`ChargingStationDto` / `ChargingStationWithChargingPoolDto`):
  - `ocppChargingStationId: string` — use verbatim as `CP_ID` / the WS path segment.
  - `status: ChargingStationStatus`
  - `ocppVersion: string`
  - `chargingPoints: ChargingPointDto[]` — each has `ocppEvseId: number` and `connectors: [...]`.
  - `chargingPool: ChargingPoolDto` — **always present, never optional** (confirmed by reading
    `ChargingStationWithChargingPoolDto` in `obornes-cpo-backbone`). Only `id`/`name` are used here,
    mapped into `StationSpec.pool` (§5.1) — the rest of `ChargingPoolDto` (address, GPS, tags, ...) is
    out of scope for this loader.

**If unconfigured:** the CPMS source requires **both** `ONCE_API_URL` and `ONCE_API_KEY` (§8.1) to
make a call at all — if either is missing, this source contributes an empty list, no request is
attempted, and it's not an error (the expected shape for "explicit-list-only, no CPMS").
`ONCE_API_TENANT_ID` stays independently optional per §8.1 and never gates this on its own — a
single-tenant environment legitimately has `ONCE_API_URL`/`ONCE_API_KEY` set and no tenant id, and
that still fetches normally.

### 4c. Regex include/exclude filters (§8.3) — applied after unioning both sources

Once §4a's and §4b's contributions are unioned into one list, two optional regex pattern lists
narrow it down further, applied in order:

1. **Include** — if given, keep only stations whose `id` matches *at least one* pattern (e.g. only
   `^SIM-` stations). **If no include patterns are configured, this step is a no-op — every station
   from the union passes through.**
2. **Exclude** — if given, drop any station whose `id` matches *any* pattern (e.g. "these 3 stations
   are wired to a physical test bench, never simulate them"), applied last. **If no exclude patterns
   are configured, this step is also a no-op.**

So with nothing configured at all across all three mechanisms, the result is simply an empty fleet
— not an error, just nothing to simulate, which is a reasonable default for "you haven't told the
loader where to get stations from yet."

**Why client-side, not RSQL:** `STANDARD_STRING_OPERATORS` (`src/rsql-validator/operators.ts` in
`obornes-cpo-backbone`) covers equality, `=in=`/`=out=`, and prefix/suffix/contains — no general
regex operator. Pushing arbitrary regex server-side isn't possible, so `qa/fleetSource.ts` fetches
the (optionally status/version-narrowed) full list and applies both regex passes itself, trading a
larger transfer for genuinely arbitrary patterns instead of being limited to RSQL's fixed operator
set.

#### Known gotcha: `ocppVersion` enum format mismatch

`cpo-backbone` uses `OCPP_1_6` / `OCPP_2_0_1` / `OCPP_2_1` (underscores). This repo's
`src/ocppVersion.ts` uses `"OCPP_1.6"` / `"OCPP_2.0.1"` / `"OCPP_2.1"` (dots). The CPMS provider
**must** map one to the other explicitly — `resolveMessageHandler()` throws on an unrecognized
value if this is skipped.

#### Known gotcha: connector topology

Per `obornes-cpo-backbone`'s own README (`npm run seed:load-tests` section): in their seed data,
`ocppConnectorId === ocppEvseId` of the parent `ChargingPoint` — an acknowledged simplification
(tracked as `IBC-2888`), not real OCPP 2.0.1 topology, done specifically so the node VCP can consume
it. Practical consequence for this loader: **the number of `chargingPoints` on a station is the
number of independently-usable connectors/EVSEs** we can simulate concurrently on it (see §6).

## 5. Station spec shape (provider-agnostic)

> ⚠️ **To revisit.** `BehaviorOverridesSchema` below only expresses *probabilistic* behavior
> (`chargeProbability`, `disconnectProbability`, random session durations) — there's currently no way
> for a `StationSpec` to declare a **deterministic, precisely-timed** scenario (e.g. "this station
> starts a session on connector 2 at exactly T+30s", not "rolls a probability every tick"). §7's
> console/script commands (`start`, `sleep`, `scenario`) can express precise timing, but only at the
> console/script level, not as part of the fleet description itself. Both modes are wanted — this
> section needs another pass to decide whether that's a third optional field on `StationSpec` (e.g. a
> `schedule` list of timed actions), or stays entirely out of the manifest and is left to §7's script
> layer. Not resolved yet; don't treat the schema below as final.

Both providers (§4a, §4b) resolve to a `StationSpec[]`, Zod-validated like every payload elsewhere in
this repo (`src/v16/messages/*.ts`'s pattern of a schema + inferred type).

### 5.1 `StationSpec` schema (`qa/manifest.ts`)

A station's topology is a list of EVSEs, each owning one or more connectors — the real OCPP
2.0.1/2.1 shape, and the same shape `chargingPoints: ChargingPointDto[]` already carries per station
in the CPMS response (§4b: each item has `ocppEvseId` and nested `connectors`). Two input forms are
accepted, normalized to one canonical shape at parse time so nothing downstream has to care which was
used:

- **`connectorCount`** — shorthand for the common single-EVSE case: a virtual EVSE `id: 1` owning
  connectors `1..N`. Convenient to hand-write in a manifest (§5.2) or for OCPP 1.6, which has no EVSE
  concept on the wire at all (connectors are numbered sequentially `1..N` per charge point, `0`
  reserved for whole-charge-point messages) — `evseId` there is purely an internal grouping label,
  never sent.
- **`evses`** — the explicit, real topology: an array of `{ id, connectorIds }`. Required for a
  station with more than one EVSE, and what `qa/onceProvider.ts` (§4b) always produces, since the CPMS
  response already carries the real per-EVSE connector list — nothing is discarded on that path.

Exactly one of the two must be given; the schema's `.transform()` normalizes `connectorCount` into the
same `evses: EvseSpec[]` shape immediately, so `qa/station.ts`, `qa/scenarios.ts`, etc. only ever see
`evses` (§6).

```ts
import { z } from "zod";
import { OcppVersion } from "../src/ocppVersion";

const BehaviorOverridesSchema = z
  .object({
    chargeProbability: z.number().min(0).max(1),
    disconnectProbability: z.number().min(0).max(1),
    sessionMinMinutes: z.number().positive(),
    sessionMaxMinutes: z.number().positive(),
  })
  .partial()
  .refine(
    (b) =>
      b.sessionMinMinutes === undefined ||
      b.sessionMaxMinutes === undefined ||
      b.sessionMaxMinutes >= b.sessionMinMinutes,
    { message: "sessionMaxMinutes must be >= sessionMinMinutes", path: ["sessionMaxMinutes"] },
  );

const EvseSpecSchema = z.object({
  id: z.number().int().positive(), // ocppEvseId — internal-only label for OCPP 1.6, on-wire for 2.0.1/2.1
  connectorIds: z.array(z.number().int().positive()).min(1),
});

const PoolSpecSchema = z.object({
  id: z.string().min(1), // chargingPool.id from the CPMS (§4b) — opaque grouping key, not OCPP
  name: z.string().optional(), // chargingPool.name — display only
});

const StationSpecInputSchema = z
  .object({
    id: z.string().min(1), // ocppChargingStationId — used verbatim as CP_ID
    ocppVersion: z.nativeEnum(OcppVersion), // reuses this repo's enum directly — no duplicated literals
    connectorCount: z.number().int().positive().optional(), // shorthand — see above
    evses: z.array(EvseSpecSchema).min(1).optional(), // explicit real topology — see above
    pool: PoolSpecSchema.optional(), // §4b for ONCE-sourced stations; hand-authored in a manifest, or omitted entirely
  })
  .merge(BehaviorOverridesSchema)
  .refine((s) => (s.connectorCount === undefined) !== (s.evses === undefined), {
    message: "Specify exactly one of connectorCount or evses",
  });

export const StationSpecSchema = StationSpecInputSchema.transform((s) => {
  const { connectorCount, ...rest } = s;
  return {
    ...rest,
    evses:
      s.evses ??
      [{
        id: 1,
        connectorIds: Array.from({ length: connectorCount as number }, (_, i) => i + 1),
      }],
  };
});

export type StationSpec = z.infer<typeof StationSpecSchema>;
```

Behavior knobs are optional and stay `undefined` when absent — §8.4's fallback to `qa/config.ts`'s
`CONFIG` happens at the point `qa/station.ts` reads them, not inside this schema (the schema's job is
only "is this shape valid", not "what's the effective value").

`pool` is optional for the same reason §4a's provider has no natural source for it: a hand-written
manifest entry can set `pool: { id: "SITE-42", name: "Test bench A" }` to group its own stations for
filtering (§7.3.1), or omit it entirely. `qa/onceProvider.ts` (§4b) always sets it, since
`chargingPool` is never absent on the CPMS response — every ONCE-sourced `StationSpec` carries a real
`pool.id`. A station with no `pool` set (manifest-only, no override) reports `N/A` for its pool column
in `list`'s output (§7.3.1) and never matches an active `--pool-id` filter.

### 5.2 Manifest file format (`qa/manifest.ts`, static provider §4a)

Plain JSON, matching the rest of this repo (no YAML parser dependency exists here, unlike
`obornes-ocpp-proxy`'s `config.yml` — nothing in this spec needs YAML's extra features like comments,
so it isn't worth the added dependency). A wrapping object, not a bare array, so manifest-level
defaults can be added later without a breaking shape change:

```ts
export const ManifestFileSchema = z.object({
  defaults: BehaviorOverridesSchema.optional(), // applied to every station that doesn't override it
  stations: z.array(StationSpecSchema).min(1),
});
export type ManifestFile = z.infer<typeof ManifestFileSchema>;
```

Example `qa/manifests/example.json`:

```json
{
  "defaults": {
    "chargeProbability": 0.1,
    "sessionMinMinutes": 5,
    "sessionMaxMinutes": 20
  },
  "stations": [
    { "id": "SIM-0007", "ocppVersion": "OCPP_1.6", "connectorCount": 2 },
    { "id": "SIM-0008", "ocppVersion": "OCPP_2.0.1", "connectorCount": 1 },
    { "id": "ACE-0003", "ocppVersion": "OCPP_1.6", "connectorCount": 4, "chargeProbability": 0.5 },
    {
      "id": "MULTI-0001",
      "ocppVersion": "OCPP_2.0.1",
      "evses": [
        { "id": 1, "connectorIds": [1] },
        { "id": 2, "connectorIds": [1, 2] }
      ]
    }
  ]
}
```

`ACE-0003` overrides `chargeProbability` for itself only; the other stations inherit `defaults`, which
themselves fall back further to `qa/config.ts`'s env-driven `CONFIG` for any knob neither specifies
(§8.4) — a three-level cascade: per-station override → manifest `defaults` → global `CONFIG`.
`MULTI-0001` shows the explicit `evses` form: a real 2-EVSE station where EVSE 2 has two connectors —
`connectorCount` couldn't express this shape at all, since it always yields exactly one EVSE (§5.1).

### 5.3 Include/exclude filter file format (§4c, §8.3)

Same reasoning as §5.2 — plain JSON array of regex pattern strings, not a bespoke text format, so it
goes through the same Zod-validation path as everything else instead of custom parsing. Each string
is compiled with `new RegExp(pattern)` — not auto-anchored, so `SIM-` matches anywhere in the id
unless the pattern itself anchors with `^`/`$`:

```ts
export const RegexFilterListSchema = z.array(z.string().min(1));
```

Include file (`qa/manifests/include.json`) — keep only ids matching one of these:

```json
["^SIM-", "^ACE-\\d{4}$"]
```

Exclude file (`qa/manifests/exclude.json`) — drop ids matching any of these, applied last:

```json
["^SIM-00\\d{2}$"]
```

Merged with any `--include <regex,...>` / `--exclude <regex,...>` CLI values (§8.3) into one
deduplicated pattern list per side before the client-side filter pass runs (§4c).

## 6. Runtime model: multi-connector stations

`qa/` gets its own `Station` class — not a copy-then-migrate of `demo/station.ts`, a fresh
implementation designed connector-aware from the start, since `demo/` stays untouched (§9). It's
still worth walking through *why* via `demo/station.ts`'s current design: it hardcodes
`connectorId: 1` everywhere (`sendStatusNotification`, `startSession16`/`startSession201` in
`demo/charging.ts`), which is exactly the mistake `qa/station.ts` avoids from day one.

Per §3's rejected identity-aliasing idea, the correct way to run more concurrent sessions than
registered stations is: **one real station, N connectors, N concurrent transactions** — already the
supported model in `src/transactionManager.ts` (`canStartNewTransaction(evseId, connectorId)` allows
one transaction per `(evseId, connectorId)` pair, many connectors per VCP, across many EVSEs — see §10
for the `evseId` parameter, added alongside this spec to fix a real hardcoding bug, and
`index_16_2_connectors.ts` for the minimal single-EVSE 2-connector example). `qa/station.ts`'s session
model is connector-aware natively: `session` keyed by `(evseId, connectorId)` from the start, and
`tick()`/`disconnectCheck()` looping over connectors rather than assuming one.

### 6.1 The design, explained via `demo/`'s (unmodified) current model

**`demo/station.ts` today** (reference/inspiration only — this file is not touched): one
`session: ChargingSession | null` field on `Station`, and one `state: StationState` that conflates
two different things — the WebSocket connection lifecycle (`disconnected`/`connecting`) *and* the
single session's lifecycle (`available`/`preparing`/`charging`/`finishing`). That conflation is
exactly what would break with multiple connectors: a station can be connected while connector 1 is
`charging` and connector 2 is `available` at the same time — there's no single "station state" that
captures both.

```ts
// demo/station.ts — existing, unmodified, shown for contrast only
class Station {
  state: StationState = "disconnected"; // connection AND session state, mixed
  session: ChargingSession | null = null;
  ...
}
```

**`qa/station.ts` (new)** — split connection state from per-connector state, and key sessions by the
full `(evseId, connectorId)` identity from the outset, built directly from `StationSpec.evses` (§5.1)
— never re-deriving or assuming a `1..N` layout at this layer:

```ts
// qa/station.ts — new file
type ConnectionState = "disconnected" | "connecting" | "connected";
type ConnectorStatus = "available" | "preparing" | "charging" | "finishing";

// "1:1" for OCPP 1.6 (evseId is an internal label, never sent) — see §5.1
function connectorKey(evseId: number, connectorId: number): string {
  return `${evseId}:${connectorId}`;
}

interface ConnectorRuntime {
  evseId: number;
  connectorId: number;
  status: ConnectorStatus;
  session: ChargingSession | null; // non-null only while status !== "available"
}

class Station {
  state: ConnectionState = "disconnected";            // connection lifecycle only, unchanged in spirit
  connectors: Map<string, ConnectorRuntime>;           // keyed by connectorKey(evseId, connectorId), built from StationSpec.evses
  ...
}
```

Wire-level calls stay version-aware: OCPP 1.6's `StatusNotification`/`StartTransaction` only ever
carry `connectorId` (no `evseId` field exists in those schemas — `src/v16/messages/_common.ts`), while
2.0.1/2.1's do carry both (`src/v201/messages/statusNotification.ts`,
`src/v201/messages/meterValues.ts`, ...). `qa/station.ts`'s send helpers branch on
`StationSpec.ocppVersion` and simply omit `evseId` on the wire for 1.6, exactly like the schemas
already require — the `ConnectorRuntime.evseId` field itself stays populated in both cases purely as
the in-memory grouping key.

Consequences that follow directly from this split — each is a small, mechanical piece of logic,
mirroring what `demo/`'s equivalent does for its single hardcoded connector, just looped:

- **Boot sequence** (`sendBootNotification`): `demo/station.ts` sends a single `StatusNotification`
  for connector 1. `qa/station.ts`: loop
  `for (const c of connectors.values()) sendStatusNotification(c.evseId, c.connectorId, "Available")`
  (1.6 stations drop `evseId` on the wire, per the version branch above) — same call, once per
  connector, exactly like `index_16_2_connectors.ts` (in `src/`/repo root) already does by hand for its
  fixed 2 connectors.
- **`tick()`**: `demo/`'s version checks one `session`/`state` pair. `qa/`'s: loop over
  `connectors.values()` and roll `chargeProbability` independently *per connector* — a station with
  4 connectors gets 4 independent rolls per tick, not one.
- **`startChargingSession(idTag?, evseId, connectorId)`**: `demo/charging.ts`'s version already takes a
  `connectorId` parameter but ignores it for the session-guard check (`if (station.session || ...)`).
  `qa/charging.ts`'s version: look up `station.connectors.get(connectorKey(evseId, connectorId))`,
  guard on `connector.status === "available"`, and write the session onto `connector.session` instead
  of a station-wide field. Mirrors `TransactionManager.canStartNewTransaction(evseId, connectorId)` in
  `src/transactionManager.ts`, which enforces this one-session-per-connector rule the same way for
  `index_*.ts` scenarios (both keyed on the same `(evseId, connectorId)` pair, so a station with two
  EVSEs each using `connectorId: 1` can't collide — see §10's src/ fix).
- **`RemoteStartTransaction`/`RemoteStopTransaction`/`RequestStart...`/`RequestStop...` handlers**
  (`handleIncomingCall`): `demo/`'s version already reads `connectorId`/`transactionId` out of the
  incoming payload, but checks it against a single `this.session`. `qa/`'s version: look up
  `this.connectors.get(connectorKey(evseId, connectorId))` and check *that* connector's session, so two
  connectors can each be mid-transaction and answer independently to a remote command targeting one of
  them. For 2.0.1/2.1's `RequestStartTransaction`, which names only an `evseId` (never a
  `connectorId`) and lets the charge point pick a free connector under it, `qa/`'s handler picks the
  first connector in that EVSE's `connectorIds` with an available `ConnectorRuntime` — the same
  resolution `src/v201/messages/requestStartTransaction.ts` now does against `vcp.evses` (§10).
- **`disconnectCheck()`** stays station-level (a network disruption affects the whole WebSocket, not
  one connector) — but must abort *every* connector's active session, not a single one: loop
  `connectors.values()` and call `abortSession` per connector with an active session, rather than
  `demo/`'s single `abortSession(this)`.
- **`abortSession`/`stopChargingSession`**: same per-session logic as `demo/charging.ts`, just
  invoked once per active connector instead of once per station.

No new concepts are introduced here — every point above is "the same operation `demo/` already does
for its one hardcoded connector, looped over connectors instead of assumed singular."

### 6.2 Fleet startup orchestration (`qa/run.ts`)

This is the part that actually turns a `StationSpec[]` (already fetched from ONCE and/or the static
manifest, unioned and regex-filtered by `fleetSource.ts` — §4) into N live, connected, multi-EVSE
stations. §4 covers *getting the data*; this section covers *using it to boot the fleet* — the gap
the file-layout table (§9) only gestured at ("wires `fleetSource.ts` → spawns `Station`s →
starts `console.ts`").

`qa/run.ts`'s job, in order:

```ts
const specs = await loadFleet();          // qa/fleetSource.ts — §4, already filtered
const registry = new Map<string, Station>();
for (const spec of specs) {
  registry.set(spec.id, new Station(spec)); // qa/station.ts — §6.1, connectors built from spec.evses
}
await connectFleet(registry, CONFIG.staggerSeconds); // this section
startConsole(registry);                    // qa/console.ts — §7
```

#### CPMS authentication/authorization failures (`loadFleet()`, before any station connects)

This happens once, inside `qa/fleetSource.ts`'s call into `qa/onceProvider.ts` (§4b) — *before*
`qa/run.ts` even builds the `Station` registry, let alone starts connecting anything. It's a
categorically different failure from the per-station WS failures below: one credential drives one
paginated REST fetch, so an auth failure there takes out the *entire* CPMS-sourced contribution to
the fleet in one shot, not one station out of many.

Confirmed against `obornes-cpo-backbone`'s actual guard/middleware source
(`src/public-api/guard/public-api.guard.ts`, `src/multitenancy/middleware/tenant-context.middleware.ts`)
— exact response shapes below, not guessed:

| Cause | HTTP status | Body |
|---|---|---|
| `ONCE_API_KEY` missing/empty | 401 | empty |
| Key not found in DB (typo, wrong environment, revoked) | 401 | empty |
| Key expired | 401 | empty — the server also soft-deletes the key row on this call (`deletedAt` set), so every subsequent retry with the same key gets the identical 401, not just the first |
| Key valid but lacks `ChargingStation.Read` | 403 | `{ message, error: { message: "Missing required permission: ChargingStation.Read", requiredPermission } }` |
| Multitenant environment (`MULTITENANCY_REJECT_ON_MISSING_TENANT=true`) and no `ONCE_API_TENANT_ID` sent | 400 | `"Missing X-Tenant-Id header"` |
| `ONCE_API_TENANT_ID` set to an unknown slug, or a tenant that exists but isn't `ACTIVE` | 401 | empty — deliberately the *same* shape as a bad key: `TenantContextMiddleware`'s own doc comment calls this anti-enumeration, so the response never reveals whether the slug exists |

All six are **terminal, not retryable** — none are fixed by trying again, unlike a mid-pagination
network blip (transient, worth the bounded retry §8.2's loop already implies).
`qa/onceProvider.ts` must treat any 4xx from this endpoint as terminal for the current run and stop
paginating immediately — it must not loop back into `fetchPage` for the next page after any 4xx.

Because the API deliberately returns an identical 401 for "bad key", "expired key", and "unknown/
inactive tenant" (anti-enumeration — confirmed in the middleware's own comments), `qa/onceProvider.ts`
cannot disambiguate those three from the HTTP response alone. The operator-facing message must say so
rather than guessing which one it is:

```
[qa] CPMS fetch failed: 401 Unauthorized from ONCE_API_URL.
     Check ONCE_API_KEY (unset / wrong / expired) and, if this environment has multitenancy
     enabled, ONCE_API_TENANT_ID (unset / wrong slug / tenant not ACTIVE) — the CPMS API
     returns an identical 401 for all of these on purpose, to avoid leaking which one it is.
```

The 403 and 400 cases are unambiguous and get a precise message instead, built from the response body
(`error.requiredPermission` for the 403, the literal string for the 400):

```
[qa] CPMS fetch failed: 403 Forbidden — ONCE_API_KEY lacks the "ChargingStation.Read" permission.
[qa] CPMS fetch failed: 400 Bad Request — "Missing X-Tenant-Id header". This CPMS environment
     requires ONCE_API_TENANT_ID to be set.
```

**Not the same case as §4b's "if unconfigured" no-op.** §4b already says a *missing*
`ONCE_API_URL`/`ONCE_API_KEY` makes the CPMS source silently contribute an empty list, no request
attempted, no error — that's the expected shape for "this operator only wants the static manifest."
An auth failure is the opposite situation: credentials **are** configured, and the CPMS actively
rejected them. Silently falling through to an empty CPMS contribution here would look identical to
the intentional no-op case in the resulting fleet size, which is exactly the confusing outcome to
avoid — an operator staring at a suspiciously small or empty fleet with no idea whether they simply
didn't configure CPMS, or configured it wrong. So `qa/fleetSource.ts` logs the failure at error level
(loud, `C.red`/`C.bold`-styled the same way `demo/`'s `Shutting down`/`Reset requested` banners are —
`qa/stats.ts` defines its own copy of `demo/stats.ts`'s `C` palette, independent file per §9) — never
silently swallowed like the genuinely-unconfigured case.

**Does not abort the whole run.** Consistent with §4's "each source degrades independently" and this
section's own failure-isolation stance for station connections: if a static manifest (§4a) is *also*
configured, `qa/run.ts` still starts and connects those stations normally — only the CPMS-sourced
portion of the fleet is missing, with the loud error above explaining why, so the operator can keep
working against their manifest while fixing the credential. If CPMS was the *only* configured source,
the union is empty and the fleet is empty — same terminal state §4c already describes for "nothing
configured", but now reached via the error-level log above instead of silently, so it's
distinguishable in the startup output.

#### Connection fan-out: staggered, not simultaneous

Opening `specs.length` WebSocket connections in one tick (`Promise.all(specs.map(s => s.connect()))`)
is exactly what `demo/config.ts`'s `STAGGER_SECONDS` / `demo/simulate-network.ts`'s per-station random
delay already exist to avoid — a connection storm against the CSMS/CPMS's OCPP endpoint, and
(worse here, since ONCE-sourced fleets can be considerably larger than a hand-written manifest — §4b's
`limit: 1000` per page, looped) a thundering herd of simultaneous `BootNotification`s. `qa/run.ts`
reuses the identical pattern, unchanged in shape:

```ts
// qa/run.ts — modeled directly on demo/simulate-network.ts's stagger loop
async function connectFleet(registry: Map<string, Station>, staggerSeconds: number): Promise<void> {
  const stations = Array.from(registry.values());
  for (const station of stations) {
    const delay = Math.random() * staggerSeconds * 1000;
    setTimeout(() => {
      if (!shuttingDown) station.connect();
    }, delay);
  }
}
```

Each `station.connect()` is fire-and-forget and self-contained (own `WebSocket`, own retry loop —
§6.1's `ConnectionState`) — the loop above never `await`s a connection succeeding before starting the
next station's timer, so one station's slow TLS handshake or CPMS-side auth hiccup can't delay any
other station's connection attempt. This is the same reasoning §4's "each source degrades to a safe
no-op" and §6.1's "per-connector, not per-station, session state" follow: no single slow/failing part
of the fleet should block or corrupt any other part.

`staggerSeconds` follows `demo/config.ts`'s convention exactly — default scales with fleet size
(`max(10, ceil(stationCount * 0.09))`, i.e. roughly 9% of the fleet connects per second at the default
rate) rather than a fixed constant, since a 5-station manifest and a 3000-station ONCE-sourced fleet
need very different spread — configurable via `STAGGER_SECONDS` in `qa/config.ts` (§8.4), overridable
per run the same way `demo/`'s is.

#### Per-station boot sequence: connect → `BootNotification` → one `StatusNotification` per connector

Mirrors `demo/station.ts`'s existing `connect()` → `ws.on("open")` → `sendBootNotification()` chain
(`demo/station.ts:83-98,388`), extended from "one connector" to "loop `station.connectors.values()`"
per §6.1's boot-sequence bullet:

```ts
// qa/station.ts — connect(), same shape as demo/station.ts:connect(), connector loop is the only delta
connect(): void {
  if (this.destroyed) return;
  this.state = "connecting";
  this.ws = new WebSocket(`${CONFIG.wsUrl}/${this.spec.id}`, [protocolFor(this.spec.ocppVersion)]);
  this.ws.on("open", async () => {
    await this.sendBootNotification();               // single call, station-wide
    for (const c of this.connectors.values()) {
      await this.sendStatusNotification(c.evseId, c.connectorId, "Available"); // §6.1, omits evseId on 1.6
    }
    this.state = "connected";
  });
  this.ws.on("close", () => { this.cleanup(); if (!this.destroyed && !this.intentionalDisconnect) this.scheduleReconnect(); });
  this.ws.on("error", () => { /* close fires after error, same as demo/station.ts:112-114 */ });
}
```

A station only reports `"connected"` once every connector's boot `StatusNotification` has been sent —
`status <stationId>` (§7.3) reflects `"connecting"` for a station still mid-boot, which is expected and
normal during the stagger window, not an error state.

#### Failure isolation: one station's connect failure never aborts the fleet

`connectFleet` above deliberately never `Promise.all`s station connections to completion, for the same
reason `demo/station.ts:scheduleReconnect` exists per-station: a CPMS-sourced fleet can legitimately
contain a station that's currently offline/decommissioned in the real world (its ONCE record still
exists, but nothing accepts the WebSocket) — that one entry retrying forever with jittered backoff
(`demo/station.ts`'s existing `randomBetween(CONFIG.reconnectMinMs, CONFIG.reconnectMaxMs)`, reused
as-is in `qa/station.ts`) must never prevent the other N-1 stations from booting or the console from
starting. `qa/run.ts` starts `qa/console.ts` (§7) immediately after scheduling all connection timers,
not after awaiting them — `list`/`status` simply show `"connecting"`/`"disconnected"` for stations
still mid-retry, which is live, correct information, not a startup gate.

#### Progress/readiness reporting

`qa/stats.ts` (§9) tracks and periodically prints (same cadence idea as
`demo/simulate-network.ts:142-147`'s first-stats-after-stagger-period print) a connected-vs-total
count — `connected: 847/1000 (312 EVSEs, 1189 connectors booted)` — so a large ONCE-sourced fleet's
ramp-up is observable without polling every station individually via `status`. This is purely
informational (log output), not a blocking readiness gate: there's no "wait until N are connected"
step anywhere in `qa/run.ts` — the console (§7) and any script's `sleep`/scenario commands are always
free to run against a partially-connected fleet, exactly as `demo/`'s hotkeys already are during its
own stagger window today.

## 7. Console / CLI

Goal: script fleet operations or drive them by hand, against the **same live objects** the fleet
runner holds (no HTTP hop), while keeping the existing `admin/` HTTP-based flow for external/
one-shot use untouched.

### 7.1 What `demo/` does today, and its gap (motivation, not something being modified)

`demo/scenarios.ts` already has an interactive input path (`setupInteractiveInput`) and a scenario
model (`Scenario.execute(stations: Station[])`) — `qa/` adopts the same scenario-list idea (its own
`qa/scenarios.ts`, adapted for `qa/station.ts`'s connector-aware type) but not its input mechanism,
which only supports:
- single-keystroke hotkeys (`b`, `p`, `t`, `r`, `n`, `s`, `h`, `q`) via raw-mode stdin — no arguments,
  so no way to target one specific station or connector;
- fleet-wide scenario execution only — every `Scenario.execute` operates on the whole `stations[]`
  array (optionally filtering/sampling inside itself), never a caller-specified subset;
- no introspection command (no "show me station X's state" or "list stations currently charging");
- no manual, single-connector session control — sessions only start via the random `tick()` roll or
  a `RemoteStartTransaction`/`RequestStartTransaction` call from the CSMS side.

Raw-mode single-keystroke input also can't carry arguments, so it's a dead end for anything beyond
today's fixed hotkey set. The console needs line-buffered input (Node's `readline`) instead.

### 7.2 One command surface, two entry points

A single parser/dispatcher (`parseCommand(line: string) -> Command`, `execute(command, registry)`)
is shared by:
- **Interactive mode** — a `readline` prompt (`fleet> `) while the runner is live, in `qa/console.ts`.
  `demo/`'s hotkey letters keep working as aliases (typing `b` + Enter == `scenario blackout`), so
  muscle memory from `demo/README.md` carries over even though it's a different tool.
- **Scripted mode** — a file of the same command lines, one per line, executed in order
  (`npx tsx qa/run.ts --script scenario.txt`, or piped via stdin so it also works as
  `cat scenario.txt | npx tsx qa/run.ts`). `sleep`/`repeat` (below) let a script pace itself instead
  of firing everything at once.
- **`--exec "<line>"`** — a third, repeatable way to feed the exact same dispatcher, this time straight
  from the process's own `argv` rather than a file or stdin: `--exec "list --connector-status=charging"
  --exec "spawn 5"` runs both, in the order given, before anything else described below. No new command
  syntax — each `--exec` value is just one line, parsed and dispatched exactly as if it had been typed
  at the `fleet>` prompt or read from a script file.

Neither mode re-implements fleet logic — all three just feed lines into the same dispatcher, which
talks directly to the in-memory `Map<stationId, Station>` registry the runner already holds.

#### What happens after `--exec` finishes — no `--repl`/`--exit` flag needed

Once every `--exec` line has run, `qa/run.ts` falls straight through into the console startup code
below, completely unchanged — no branching on "did `--exec` run" anywhere. What the operator sees next
is entirely a function of stdin's real state at that point, which was already true before `--exec`
existed:

- **stdin is a TTY** — the `fleet> ` prompt appears and stays interactive, same as running with no
  flags at all. Handy default: `--exec "list --connector-status=charging"` from an interactive
  terminal runs the query, then hands control straight to the prompt.
- **stdin is a pipe/file with more lines left** — those lines keep feeding the dispatcher as scripted
  commands (already-documented "piped mode" above), `--exec` lines having simply run first.
- **stdin is already at EOF** (`< /dev/null`, or nothing piped in) — `readline`'s `"close"` event fires
  immediately, without ever prompting. Nothing breaks; there's just no more console input to read.

None of this needs a `--repl` flag — it's the existing, already-specified console startup behavior,
reused as-is. It also doesn't make the process exit on its own: the fleet's live WebSocket connections
and timers keep Node running regardless of whether stdin has anything left to give. For a genuine
one-shot invocation (run a query, then terminate — e.g. from a CI script), no `--exit` flag is needed
either: just make the last `--exec` line one of the already-specified `quit`/`exit`/`q` commands
(§7.3), which triggers the existing graceful-shutdown path:

```bash
npx tsx qa/run.ts --exec "list --connector-status=charging" --exec "quit"
```

#### Why `readline`, not the current raw-mode input

`demo/scenarios.ts:setupInteractiveInput` reads stdin in raw mode (`process.stdin.setRawMode(true)`)
— one keystroke, no `Enter`, no arguments. It also bails out entirely when stdin isn't a TTY:

```ts
if (!process.stdin.setRawMode) return; // not a TTY
```

`setRawMode` only exists on a real terminal, so today, piping or redirecting anything into stdin
silently disables interactive input — the opposite of what scripting needs. Node's `readline`
module works identically whether stdin is a TTY or a pipe/file, via the same `"line"` event, so
switching to it is what makes "interactive" and "scripted" the same code path instead of two:

```ts
import * as readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "fleet> ",
});

rl.prompt();
rl.on("line", async (line) => {
  rl.pause();                       // see gotcha below
  await dispatch(line, registry);   // same function for both modes
  rl.prompt();
  rl.resume();
});
```

- **Typed live** (a TTY): `rl.prompt()` shows `fleet> `, the user types a line and hits Enter,
  `dispatch()` runs it against the in-memory registry.
- **Piped/redirected** (`< scenario.txt` or `cat scenario.txt | ...`): no visible prompt (no TTY to
  print it to), but the exact same `"line"` events fire for each line of the file, in order.
- **`--script <path>`** (alternative to piping): read the file ourselves and feed lines into
  `dispatch()` in a `for...of` loop with `await` between each — gives more control (e.g. stop the
  whole run on the first failing command) than relying on stdin's own pacing.

#### Gotcha: pacing `sleep`/`repeat` when a whole file arrives at once

Piping a file (`cat scenario.txt | ...`) can deliver its entire content to Node in one chunk, so
`readline` may fire several `"line"` events back to back before any `await` inside `dispatch()` has
resolved. Without `rl.pause()`/`rl.resume()` around the `await`, a `sleep 30000` command would have
no real effect in piped mode: every line would already have been dispatched before the first sleep
finished waiting. Pausing before `dispatch()` and resuming only once it resolves forces strictly
sequential processing — the second line is only read once the first command (including any sleep
inside it) has fully completed, in both interactive and scripted mode.

Free side effect of moving to `readline`: command history (up-arrow) and tab-completion (via the
`completer` option) become available in interactive mode, neither of which exist with today's
raw-mode single-keystroke input.

### 7.3 Command table

| Command | Args | Effect |
|---|---|---|
| `list [--connection-status=<v,...>] [--connector-status=<v,...>] [--pool-id=<v,...>] [--protocol=<v,...>]` | optional filters, all combinable | Print one line per matching `(station, connector)` — see §7.3.1 for filter/output semantics. **Implemented this iteration**; every other command below is still design-only. |
| `status <stationId>` | station ID | Full state dump: protocol, connection state, one line per connector (idle / session id, idTag, elapsed, energy so far) |
| `stats` | — | Aggregate counters — `qa/stats.ts`, modeled after `demo/stats.ts`'s existing tracked stats |
| `connect <stationId>` | station ID | Force-(re)connect a specific station |
| `disconnect <stationId>` | station ID | Force-disconnect a specific station (intentional, no auto-reconnect scheduled) |
| `reset <stationId>` | station ID | Same as an OCPP `Reset` from the CSMS side: disconnect + reconnect |
| `start <stationId> <connectorId> [--evse=<evseId>] [idTag]` | station, connector, optional EVSE (default: the station's first/only EVSE — see §5.1), optional idTag | Manually start a charging session on that `(evseId, connectorId)` (random idTag if omitted) — currently impossible: only `tick()` or a remote command can start one. `--evse` only needed for a multi-EVSE station (§5.1's explicit `evses` form); omitted entirely for 1.6, which has no EVSE concept |
| `stop <stationId> <connectorId> [--evse=<evseId>] [reason]` | station, connector, optional EVSE (same default), optional reason | Manually stop the session on that `(evseId, connectorId)` |
| `scenario <name>` | scenario name from `qa/scenarios.ts` | Run a named fleet-wide scenario on demand (superset of the hotkey trigger) |
| `spawn <count>` | integer | Add `count` new stations to the running fleet (ad hoc version of the `surge` scenario, any count) |
| `remove <stationId>` | station ID | Destroy and drop one station from the registry |
| `sleep <ms>` | milliseconds | Script-only: pause before the next line |
| `repeat <n> <command...>` | count + inline command | Script-only: run `<command>` `n` times |
| `help` | — | Print this table |
| `quit` / `exit` / `q` | — | Graceful shutdown (existing `shutdownFn`) |

Unknown commands or bad arguments print a usage error and continue (a typo in a script shouldn't
kill the whole run).

### 7.3.1 `list`: filter and output semantics

Three station/connector attributes are filterable, each via its own flag, each accepting a
comma-separated list of values (no spaces): `--connection-status=<v,...>`,
`--connector-status=<v,...>`, `--pool-id=<v,...>`. The pre-existing `--protocol=<v,...>` (§7.3) is a
fourth, same shape. Combination rule, stated plainly:

- **Within one flag: OR.** `--connector-status=charging,preparing` keeps a connector if it's in
  *either* state.
- **Across flags: AND.** `--connection-status=connected --connector-status=charging` keeps only rows
  where the station is connected *and* that specific connector is charging — a `charging` connector on
  a `disconnected` station's stale state (§6.1: connectors don't reset just because the socket
  dropped) does **not** match.
- **Omitted flag: no-op**, exactly like §4c's include/exclude filters — a flag that isn't given never
  excludes anything, it simply doesn't participate in the AND.
- With no flags at all, `list` prints every connector of every station.

**Why comma-separated values, not repeated flags:** `--connector-status=charging,preparing` was chosen
over `--connector-status=charging --connector-status=preparing` — one flag occurrence per dimension
keeps a line easy to scan, and matches §8.3's existing `--include <regex,...>` convention.

**Why `--connection-status`/`--connector-status`/`--pool-id`, not shorter names:** verbose over terse,
specifically so future filters read as a consistent family —`--connector-id=<v,...>`,
`--pool-name=<v,...>`, `--evse-id=<v,...>` are the obvious next additions, and the
`--<entity>-<attribute>` shape leaves no ambiguity about which entity a new flag filters on before it's
ever implemented.

**Output — one line per `(station, connector)`, fixed columns regardless of protocol:**

```
STATION       EVSE  CONNECTOR  CONN-STATUS  CONNECTOR-STATUS  PROTOCOL     POOL
SIM-0007      N/A   1          connected    charging          OCPP_1.6     N/A
SIM-0007      N/A   2          connected    available         OCPP_1.6     N/A
MULTI-0001    1     1          connecting   available         OCPP_2.0.1   N/A
MULTI-0001    2     1          connecting   available         OCPP_2.0.1   N/A
MULTI-0001    2     2          connecting   available         OCPP_2.0.1   N/A
ONCE-0042     3     1          connected    preparing         OCPP_2.0.1   Site 42
```

`SIM-0007` and `MULTI-0001` are exactly the §5.2 manifest examples (all 3 of `MULTI-0001`'s connectors
shown, one row each) — neither sets `pool`, hence `N/A`. `ONCE-0042` illustrates an ONCE-sourced station
(§4b), whose `pool.name` (`"Site 42"`) is always populated by `qa/onceProvider.ts`.

Every row has every column — no conditional layout per protocol. `EVSE` is `N/A` for OCPP 1.6 stations
(§5.1: `evseId` is an internal label there, never real topology) rather than printing the placeholder
`1` every `connectorCount`-shorthand station gets internally, which would look like real data it isn't.
`POOL` is `N/A` for any station whose `StationSpec.pool` is unset (manifest-only stations that didn't
opt in — see §5.1). Prints the pool's `name` when set, falling back to `id` when a manifest supplied
only an `id`.

### 7.4 Example script

```text
# scenario.txt — ramp up, hit two specific stations, then chaos
spawn 200
sleep 30000
start SIM-0007 1
start SIM-0007 2
sleep 5000
status SIM-0007
scenario peak-hour
sleep 300000
scenario blackout
```

### 7.5 Non-goals for the command language

No pipes, variables, or conditionals — this is a flat command list, not a shell. If a scenario needs
real branching logic, that belongs in a new `qa/scenarios.ts` entry (TypeScript), not the command
script. The parser is intentionally simple: whitespace-tokenize a line, validate args per command
with the same Zod-first convention used elsewhere in this repo.

### 7.6 Command extensibility — one file per command, auto-discovered

Mirrors this repo's existing pattern for OCPP actions (`CLAUDE.md`: "one file per action... register it
in the appropriate map") rather than growing one large `switch` in a dispatcher — same shape, applied
to console commands instead of OCPP messages:

- **`qa/commands/command.ts`** — an abstract base class every command extends:
  ```ts
  export interface CommandContext {
    stations: Station[];
    shutdown: () => void;
  }

  export abstract class Command {
    abstract readonly name: string;   // the word typed at the prompt, e.g. "list"
    abstract readonly usage: string;  // one-line help text, printed by the `help` command
    readonly aliases?: string[];      // extra words that route to the same command, e.g. "exit"/"q" -> "quit"
    abstract execute(args: string[], context: CommandContext): void | Promise<void>;
  }
  ```
  Deviates from an earlier draft of this section, which passed a bare `registry: Map<string, Station>`
  directly: a plain `Station[]` matches what `qa/run.ts`/`qa/orchestrate.ts`/`qa/stats.ts` already use
  (none of them key stations by a `Map`), and wrapping it in `CommandContext` leaves room to add more
  capabilities later — like `shutdown` — without changing `Command`'s abstract `execute` signature
  again for every future addition.
- **`qa/commands/list.ts`** (this iteration), and later `qa/commands/status.ts`,
  `qa/commands/connect.ts`, etc. — one file per command, each a single class extending `Command`,
  default-exported.
- **`qa/commands/index.ts`** — no hand-maintained map. At startup it reads its own directory
  (`node:fs`'s `readdirSync(__dirname)`), dynamically `import()`s every file except `command.ts`
  itself, and instantiates each file's default export, keyed by its `.name`:
  ```ts
  const COMMANDS: Record<string, Command> = {};
  for (const file of readdirSync(__dirname)) {
    if (file === "command.ts" || file === "index.ts") continue;
    const { default: CommandClass } = await import(`./${file}`);
    const instance = new CommandClass();
    COMMANDS[instance.name] = instance;
  }
  ```
  `dispatch(line, registry)` (§7.2) tokenizes the line and looks up `COMMANDS[firstToken]` — the direct
  analogue of `resolveMessageHandler`'s map lookup for OCPP actions.

**Adding a command is then exactly one step:** drop a new file in `qa/commands/` extending `Command`.
No edit to `index.ts`, `console.ts`, or any switch statement — the directory scan picks it up on the
next run.

**Trade-off, stated explicitly:** unlike the hand-written `ocppIncomingMessages`/`ocppOutgoingMessages`
maps, "does this file actually export a valid `Command`" is checked at runtime (an `instanceof Command`
assertion when instantiating), not at compile time by `tsc` — a malformed command file surfaces as a
startup error, not a type error. Accepted for this feature: the alternative (decorators self-registering
into a static array) doesn't actually remove the equivalent manual step, since a decorator only runs if
its file is imported somewhere — that import list would just replace the map entry it was meant to
avoid, while also introducing this repo's first use of decorators and requiring `experimentalDecorators`
(currently disabled in `tsconfig.json`).

## 8. Decisions (formerly open questions)

### 8.1 API key / tenant slug source

Env vars, following this repo's existing `.env`/`start.sh` convention (same pattern as `WS_URL`,
`CP_ID`, `PASSWORD`). Each answers a different question the CPMS provider (§4b) needs to make its
`POST /_external/api/v1/charging-stations/rsql-list` call:

- **`ONCE_API_URL`** — *where* to send the request. Base URL up to and including `/_external/api/v1`
  (e.g. `https://<host>/_external/api/v1`), so the provider just appends
  `/charging-stations/rsql-list`. Changes per environment (local / sandbox / a given client's CPMS) —
  never hardcoded, exactly like `WS_URL` isn't hardcoded for the OCPP connection today.
- **`ONCE_API_KEY`** — *with what authorization*. Sent as the `x-api-key` header on every request.
  Without it, `PublicApiGuard` on the `obornes-cpo-backbone` side rejects the call with
  `401 Unauthorized` before it does anything else (see the guard's own checks: key present → key
  found in DB → not expired → carries the `ChargingStation.Read` permission). This is a *separate*
  credential from the OCPP `PASSWORD` this repo already uses — one authenticates the WebSocket/OCPP
  session with a charge point identity, the other authenticates a REST call against the CPMS's own
  API, as two unrelated systems.
- **`ONCE_API_TENANT_ID`** — *for which tenant*. Sent as the `X-Tenant-Id` header. Optional: only
  required when the target `obornes-cpo-backbone` environment has `MULTITENANCY_SUPPORT_ENABLED=true`
  (its `CLAUDE.md` documents this flag) — a single CPMS deployment can serve several
  tenants/operators, each with its own station registry, so the API needs to know which one to query.
  Irrelevant and safely omitted against a single-tenant environment.

All three only matter for the CPMS provider (§4b) — the static-manifest provider (§4a) needs none of
them, so they stay optional/unset for offline or CI use.

### 8.2 Pagination strategy — resolved from the actual DTO

`PaginatedResult` (`obornes-cpo-backbone`, `src/common/pagination/paginated-result.dto.ts`) returns:

```ts
{
  data: T[],
  pagination: { page, limit, totalPages, totalCount, offset, previous: string | null, next: string | null },
}
```

(Not `meta` — that field only exists on the non-RSQL backoffice listing endpoint, not the RSQL one
this loader uses.) So the loop is unambiguous:

```ts
let page = 1;
const all: PublicChargingStationListItemDto[] = [];
while (true) {
  // `filter` here is an optional, non-id RSQL narrowing (e.g. status == 'ONLINE') — §4b/§4c note
  // why id-based selection is done client-side via regex instead of an RSQL clause.
  const res = await fetchPage(page, /* limit */ 1000, filter);
  all.push(...res.data);
  if (!res.pagination.next) break;
  page += 1;
}
```

Use `limit: 1000` (the API's max) throughout to minimize round-trips.

### 8.3 Include/exclude filters: files, with additive CLI flags

Primary mechanism is two files of regex patterns (§5.3) — `qa/manifests/include.json` and
`qa/manifests/exclude.json` by default, or `CPMS_INCLUDE_FILE`/`CPMS_EXCLUDE_FILE` /
`--include-file <path>`/`--exclude-file <path>` to point elsewhere. Files are the repeatable,
diffable, shareable form (e.g. an exclude file committed alongside a scenario for "these 3 stations
are physically wired to a real test bench, never simulate them").

`--include <regex,...>` / `--exclude <regex,...>` CLI flags are **additive** on top of their
respective file (extra one-off patterns for a single run), not a replacement for it — each side's
file patterns and CLI patterns are merged into one deduplicated list before the client-side regex
pass runs (§4c).

### 8.4 Default behavior profile — one `CONFIG`, modeled after `demo/config.ts`, don't duplicate

CPMS-sourced stations that don't override a behavior knob in the manifest fall back to a `CONFIG`
object in `qa/config.ts`, following the same env-var-driven pattern `demo/config.ts` already
established (`CHARGE_PROBABILITY`, `DISCONNECT_PROBABILITY`, `SESSION_MIN_MINUTES`,
`SESSION_MAX_MINUTES`, ...) — an independent file, not a shared import from `demo/`, consistent with
§9. This keeps exactly one
place that defines "default simulated behavior" — the manifest (static or CPMS-derived) only carries
*identity and topology* (`id`, `ocppVersion`, `connectorCount`/`evses`) plus optional per-station overrides,
never a second parallel set of global defaults.

## 9. File layout

**A new, independent top-level `qa/` directory. `demo/` is not modified.** This is a deliberate
change from an earlier draft of this spec, which proposed extending `demo/` in place — rejected:
`qa/` is its own tool, so `demo/` keeps serving its original purpose (broad network/chaos load
testing) completely unaffected by anything below. `qa/` *adopts the same patterns* `demo/` pioneered
(single-process, in-memory, lightweight `Station`, one-file-per-concern layout) as a fresh,
independent implementation — designed connector-aware from day one (§6), not a migration of `demo/`'s
files.

**`qa/` files:**

| File | Role |
|---|---|
| `qa/station.ts` | The connector-aware `Station` class (§6.1) — new, not derived from `demo/station.ts` by import or inheritance. |
| `qa/charging.ts` | Per-connector session start/stop/abort logic (§6.1), same shape as `demo/charging.ts` but keyed by `connectorId` from the start. |
| `qa/manifest.ts` | Zod schema for `StationSpec` (§5) and the explicit-list provider (§4a) — parses/validates a JSON manifest into `StationSpec[]`. |
| `qa/onceProvider.ts` | The CPMS-fetched provider (§4b): builds the (optionally status/version-narrowed) RSQL request, paginates (§8.2), maps `ocppVersion`/`chargingPoints` into `StationSpec[]` (both gotchas from §4b) — always produces the explicit `evses` form (§5.1) from `chargingPoints[].ocppEvseId`/`.connectors`, never `connectorCount`, since the real topology is already on hand. No id-based filtering here, that's `regexFilter.ts`'s job. |
| `qa/regexFilter.ts` | The include/exclude regex pass (§4c, §5.3, §8.3) — loads/merges the include and exclude pattern lists (file + CLI), applies both to whatever `StationSpec[]` either source produced. |
| `qa/fleetSource.ts` | Always gathers from both sources (§4a, §4b — each independently empty if unconfigured, not an error), unions them, runs the union through `regexFilter.ts` (§4c), and returns a final `StationSpec[]`. Not a "pick one" switch — all three mechanisms (§4) run every time. |
| `qa/console.ts` | The `readline` REPL wiring (§7.2): prompt/line handling, `--exec`/`--script` intake, and `dispatch(line, registry)` — tokenizes a line and routes it through `qa/commands/index.ts`'s registry. Does not itself implement any command's behavior. |
| `qa/commands/command.ts` | Abstract `Command` base class (§7.6) every command extends: `name`, `usage`, `execute(args, context)`, plus the `CommandContext` interface (`{ stations, shutdown }`). |
| `qa/commands/list.ts` | The `list` command (§7.3.1) — first implemented command. |
| `qa/commands/quit.ts` | Second implemented command, and the one `--exec '... ' --exec 'quit'` needs to actually terminate the process — see §7.2's `--exec` write-up. |
| `qa/commands/index.ts` | Auto-discovers every file in `qa/commands/` (§7.6) and builds the `name -> Command` registry `dispatch()` consults. No hand-maintained map. |
| `qa/scenarios.ts` | Scenario definitions (`SCENARIOS`, `findScenario`) — same idea as `demo/scenarios.ts`, adapted to operate on `qa/station.ts`'s connector-aware `Station` type. Does not import from `demo/`. |
| `qa/config.ts` | Env-var-driven `CONFIG` + default behavior profile (§8.4) — same pattern as `demo/config.ts`, independent file. |
| `qa/stats.ts` | Aggregate counters / logging helpers — same pattern as `demo/stats.ts`, independent file. |
| `qa/types.ts` | `ConnectorRuntime`, `StationSpec`, and other shared runtime types (not command-related — `Command` itself lives in `qa/commands/command.ts`, §7.6). |
| `qa/run.ts` | Entry point — wires `fleetSource.ts` → spawns `Station`s → staggers connections → starts `console.ts` (§6.2). Analogous role to `demo/simulate-network.ts`. |
| `qa/README.md` | Documents the manifest format, `CPMS_API_*` env vars, and the console command table — same spirit as `demo/README.md`. |

**Non-code additions:** a `qa/manifests/` directory for example/sample manifest and include/exclude
filter files (not code) — same spirit as the repo-root `cert/` folder or `.env.example`: checked-in
examples, not something the runtime ships or requires.

**`demo/` stays exactly as it is today** — no file listed above touches it. Anything here that
resembles `demo/`'s code (the `Station` shape, the scenario list, the config pattern) is written
independently in `qa/`, not imported from or sharing state with `demo/`.

**Housekeeping, not part of this feature's code:** once implemented, the root `CLAUDE.md` needs a new
section for `qa/` (alongside its existing "Network simulator (`demo/`)" section) — noted here so it
isn't forgotten, not something to do as part of this spec.

## 10. Related fix: `connectorId`/`evseId` hardcoding in `src/` (already applied, independent of `qa/`)

While auditing this spec's own connector-topology handling (§5, §6), the same hardcoding pattern
turned up in already-shipped `src/` code, unrelated to whether `qa/` is ever built — worth fixing on
its own regardless of this feature's timeline, and applied ahead of `qa/`'s implementation:

- `src/v201/messages/requestStartTransaction.ts` and `src/v21/messages/requestStartTransaction.ts`
  (identical bug in both) resolved `evseId` from the CSMS's request correctly, but then hardcoded
  `connectorId = 1` unconditionally — wrong the moment a real request targets any EVSE other than the
  one whose sole connector happens to be `1`.
- `TransactionManager.canStartNewTransaction` (`src/transactionManager.ts`) was keyed on `connectorId`
  alone, so two different EVSEs both using `connectorId: 1` (a legal 2.0.1/2.1 topology) would
  collide — the second EVSE's connector would incorrectly read as already occupied.

Fix: `VCP` (`src/vcp.ts`) now takes an optional `evses: { id: number; connectorIds: number[] }[]`
construction option — defaulting to `[{ id: 1, connectorIds: [1] }]`, so every existing `index_*.ts`,
`admin/`, and `demo/` usage is unaffected. `canStartNewTransaction` now takes `(evseId, connectorId)`
and matches both. Both `requestStartTransaction.ts` handlers resolve the target EVSE from
`call.payload.evseId ?? vcp.evses[0].id`, then pick the first connector under it that
`canStartNewTransaction` reports free, rejecting only if the EVSE is unknown or every one of its
connectors is occupied.

This is the `src/`-level counterpart of §5/§6's `evses`-based `StationSpec`/`Station` model — `qa/`
will configure a real `VCP`-equivalent topology per station using the same shape once implemented, but
the `src/` fix itself doesn't depend on `qa/` existing.

## 11. Out of scope, revisit later

- Provisioning stations on the CPMS (creating them) — not covered here.
- `obornes-ocpp-proxy` routing-rule authoring (per-prefix targets) — orthogonal; this spec's fleet
  loader only needs *a* WS endpoint to connect to, however it's routed downstream.
