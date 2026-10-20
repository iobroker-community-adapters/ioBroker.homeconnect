/* global describe, it, before, after */
"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller,
//   drive it with fixtures covering EVERY device type the adapter supports
//   (feedFixtures), then dump every <adapter>.0.* object to
//   test/objects.inventory.json in the ioBroker object-structure bot's format.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is
//   set — pre-release.py exports the last tag's inventory): seed the previous
//   objects BEFORE start, start, feed, then assert that every object carries the
//   current common (every field) and object type, and that removed objects are gone.
// Suite "counterpart gone and back" (round 87): cut every counterpart, hold, bring it
//   back — the adapter shows it in OUTAGE_SHOWN, deletes and writes no object, changes
//   no other value (round 96), and logs nothing above debug.
// Suite "a name that is the adapter's own" (round 87): a device named `info` (feedReservedNames)
//   leaves `info` and everything below it as a fresh installation has it.
// Suites "chosen network address" / "missing network address" (round 87, only with a
//   `type: "ip"` field): the chosen address is the only one used and strangers get no
//   answer; a missing one falls back to every address with exactly one warning.
// Suite "diagnostics report" (round 97, only with a report): every device's report asked for the way the admin
//   card asks — no datapoint, no value and no file for a report, and no live read of an unconnected device.
//
// homeconnect: the fixtures cover EVERY appliance type Home Connect knows (test/fixtures/inventory/*.json, derived from
// the verbatim type source, thoukydides/homebridge-homeconnect src/api-value-types.ts — not the maintainer's own three
// appliances). The adapter is a pure cloud client, so the fixtures reach it through the ENVIRONMENT: the fixture hook
// test/inventory-fetch-hook.cjs replaces global fetch inside the adapter process and refuses every unknown address.
// The adapter has no test seam and knows nothing about this.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const { tests } = require("@iobroker/testing");

const ADAPTER_DIR = path.join(__dirname, "..");
const ADAPTER = require(path.join(ADAPTER_DIR, "io-package.json")).common.name;
const NS = `${ADAPTER}.0.`;
// An object is written at most three times in one start: created, its name refreshed, enriched once after
// discovery. More is churn — every write goes to the database and to every subscriber (round 60, measured
// 2026-09-28 over the fleet: 1-3 everywhere, 251 for an object whose stored key flipped on every resync).
const MAX_OBJECT_WRITES = 3;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
// Value dumps for the readable-values judge (`iobroker-adapter-checks values`, gate D08 + CI job): the states
// after the fixture run, and the objects once more from a run in a second system language. Generated, not
// committed (.gitignore) — timestamps and counters would make a golden file drift on every run.
const STATES_INVENTORY = path.join(__dirname, "states.inventory.json");
const OBJECTS_SECOND_LANGUAGE = path.join(__dirname, "objects.inventory.de.json");
const FIRST_LANGUAGE = "en";
const SECOND_LANGUAGE = "de";
const VOLATILE = ["ts", "from", "user", "acl"];
// Key order carries no meaning in an ioBroker object: extendObject keeps the key order an existing
// object already has, while adapter-core's I18n.getTranslatedObject builds its own — the same eleven
// texts in another order are the same name. Arrays keep their order.
const canonical = v =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map(k => [k, x[k]]),
        )
      : x,
  );
// How long the upgrade suite keeps watching after its verdict: a write in that window means the wait ended before
// the adapter did (round 61, measured 2026-09-29 over the fleet: none in 10 s at HEAD; parcelapp's old wait judged
// 5 ms before the first of 187 writes).
const SETTLE_MS = 10000;
const INSTANCE_OBJECTS = new Set(
  (require(path.join(ADAPTER_DIR, "io-package.json")).instanceObjects ?? []).map(o => `${NS}${o._id}`),
);
// Round 62: every adapter start loads test/resource-probe.js (fleet master) FIRST; at its exit it records what the
// adapter or one of its libraries left open after onUnload, and the run fails on any of it (the after() at the end).
const RESOURCE_PROBE = path.join(__dirname, "resource-probe.js");
const RESOURCE_DIR = fs.mkdtempSync(path.join(require("node:os").tmpdir(), `${ADAPTER}-resources-`));
// Round 62: the adapter's read-only states (`common.write: false`) — only the adapter writes them, so it compares them
// in memory; a database read of one in the quiet window after the verdict is a finding, and so is a single read of one at
// any time (Round 77) — the start fills the memory with one bulk getStatesAsync.
const READ_ONLY = new Set();
/**
 * The environment of every adapter start: the resource probe first, then the adapter's fixture hooks (FIXTURE_HOOKS,
 * round 113), its pacing hooks (PACING_HOOKS, round 123) unless the installation is one the limit tests judge, then the
 * fleet hooks of this start — NETWORK_HOOK always last. countThisInstallation (right after clearInstanceData in the three
 * limit suites) marks such an installation: `<time>.counted` next to its `<time>.install`.
 *
 * @param {...string} hooks the fleet hooks of this start (none, or NETWORK_HOOK)
 */
// Round 123: true while a suite runs whose installation the limit tests judge (`a restart right after the start`,
// `one counterpart hangs`, `one counterpart hangs mid-run` — countThisInstallation, their after() ends it).
let counting = false;
function adapterEnv(...hooks) {
  // round 123: a judged installation runs at the adapter's own pace (no PACING_HOOKS) and tells the fixture hooks so
  // (INVENTORY_COUNTED, for the account LIMIT_ACCOUNT announces); every other suite keeps both
  return {
    NODE_OPTIONS: [RESOURCE_PROBE, ...FIXTURE_HOOKS, ...(counting ? [] : PACING_HOOKS), ...hooks]
      .map(file => `--require ${file}`)
      .join(" "),
    RESOURCE_PROBE_DIR: RESOURCE_DIR,
    RESOURCE_PROBE_NS: NS,
    ...(counting ? { INVENTORY_COUNTED: "1" } : {}),
  };
}
function countThisInstallation() {
  counting = true;
  fs.writeFileSync(path.join(RESOURCE_DIR, `${Date.now()}.counted`), "");
}

// Round 87 (krobi 2026-10-02 23:26): the suite "counterpart gone and back" cuts every counterpart with
// test/network-hook.js (fleet master), the LAST hook of its starts; the switch is on while OUTAGE_FLAG exists.
const NETWORK_HOOK = path.join(__dirname, "network-hook.js");
const OUTAGE_FLAG = path.join(RESOURCE_DIR, "outage");
// How long the adapter may take to show the outage, and to show the return.
const OUTAGE_DEADLINE_MS = 300000;
// Once the adapter shows the outage, every counterpart stays gone at least this long and at least as long again as the
// adapter took to show it — several of its own cycles, so a deletion after N missed cycles falls inside the window.
const OUTAGE_HOLD_MS = 30000;
// Round 100 (krobi 2026-10-07 10:12: one device never blocks another): while HANG_FLAG names a host, the network hook lets
// that one counterpart hang — it takes nothing and answers nothing. How long the other counterparts may take to be reached.
const HANG_FLAG = path.join(RESOURCE_DIR, "hang");
// Round 104 (GV-28): how long a start with a taken port may take to stop with an error or to talk to something else.
const TAKEN_WINDOW_MS = 60000;
const HANG_DEADLINE_MS = 120000;
// Round 107 (W100-5): how long the adapter talks to its counterparts undisturbed before one of them begins to hang — long
// enough for its own rhythm to show (a cadence seen only in the start burst is no rhythm).
const HANG_WARMUP_MS = 90000;
// Round 113 (the limits count each installation on its own — two quick starts of one installation still count together):
// how long the suite "a restart right after the start" waits at most for the restarted process to fall quiet.
const RESTART_QUIET_DEADLINE_MS = 120000;
// Round 100 (krobi 2026-10-07 10:14: API limits are defined in the adapter and checked): the one place the adapter defines
// the limits of every counterpart it calls — it imports the file itself, and the suite counts every call against it.
const API_LIMITS = path.join(ADAPTER_DIR, "src", "lib", "api-limits.json");
// Round 101 (krobi 2026-10-07 15:54, GV-13 as the fleet rule: never `ack: true` unless the device confirmed): how long
// after the last command the suite waits — no counterpart answers in that time, so no command may be confirmed.
const COMMAND_WINDOW_MS = 30000;
// Round 87 (krobi 2026-10-03 00:27, 11:38): the address the user picks in the instance settings (jsonConfig `type: "ip"`)
// is the only one the adapter listens, sends and connects on — the cloud included; one the host does not carry falls back
// to every address with exactly one warning. ADDRESS_KEY is the native key of that field, undefined where the adapter
// offers no choice; CHOSEN_ADDRESS the first non-internal IPv4 of this machine (loopback is internal — several adapters
// treat it as missing); MISSING_ADDRESS one no machine carries (TEST-NET-1, RFC 5737).
const ADDRESS_KEY = (() => {
  const file = path.join(ADAPTER_DIR, "admin", "jsonConfig.json");
  const find = node => {
    for (const [key, value] of Object.entries(node?.items ?? {})) {
      if (value?.type === "ip") {
        return key;
      }
      const inner = find(value);
      if (inner) {
        return inner;
      }
    }
    return undefined;
  };
  return fs.existsSync(file) ? find(JSON.parse(fs.readFileSync(file, "utf8"))) : undefined;
})();
const CHOSEN_ADDRESS = Object.values(require("node:os").networkInterfaces())
  .flat()
  .find(i => (i.family === "IPv4" || i.family === 4) && !i.internal)?.address;
const MISSING_ADDRESS = "192.0.2.1";
// Round 97 (krobi 2026-10-06 19:07–19:14, page "Diagnosebericht — Flottenstandard"): an adapter with a diagnostics
// report carries the fleet master src/lib/diagnostics/report-jobs.ts; the card asks every REPORT_POLL_MS whether a
// started report is done, and gives up after REPORT_DEADLINE_MS.
const DIAGNOSTICS_REPORT = fs.existsSync(path.join(ADAPTER_DIR, "src", "lib", "diagnostics", "report-jobs.ts"));
const REPORT_POLL_MS = 2000;
const REPORT_DEADLINE_MS = 180000;

/**
 * Every object write of the adapter in this suite, and which of them changed nothing (round 61). An unchanged
 * rewrite still goes to the database and to every subscriber — the adapter writes only what differs. The FIRST
 * write of an `instanceObjects` entry is js-controller's own (`_createInstancesObjects` extends every entry before
 * `onReady`, 7.2.2) and not the adapter's choice. Called as the suite's first await, so the start is watched from
 * its first write; the known content comes from the database, a seed included.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function watchObjectWrites(harness) {
  const watch = { writes: new Map(), peak: new Map(), unchanged: [], deleted: [], times: [], unchangedStates: [] };
  const known = new Map();
  const roles = new Map();
  const states = new Map();
  const content = obj => {
    const { ts, from, user, ...rest } = obj;
    return canonical(rest);
  };
  harness.on("objectChange", (id, obj) => {
    if (!id.startsWith(NS)) {
      return;
    }
    if (!obj) {
      watch.deleted.push(id);
      known.delete(id);
      roles.delete(id);
      return;
    }
    roles.set(id, obj.common?.role);
    if (obj.type === "state" && obj.common?.write === false) {
      READ_ONLY.add(id);
    } else {
      READ_ONLY.delete(id);
    }
    const now = content(obj);
    if (obj.from === `system.adapter.${ADAPTER}.0`) {
      const n = (watch.writes.get(id) ?? 0) + 1;
      watch.writes.set(id, n);
      watch.peak.set(id, Math.max(watch.peak.get(id) ?? 0, n));
      watch.times.push([id, Date.now()]);
      if (known.get(id) === now && !(n === 1 && INSTANCE_OBJECTS.has(id))) {
        watch.unchanged.push(id);
      }
    }
    known.set(id, now);
  });
  // Round 62: an indicator state (`indicator.*`) is written only on a change (read-only: compared in memory,
  // writable: setStateChangedAsync) — a write that changes nothing is a finding. Compared is what js-controller
  // 7.2.2 compares in setStateChangedAsync: val strictly, ack, q, c; an object value always counts as changed.
  // Round 104 (krobi 2026-09-29: adapters waste no resources, GV-05): every state, not only `indicator.*`.
  harness.on("stateChange", (id, state) => {
    if (!id.startsWith(NS) || !state || state.from !== `system.adapter.${ADAPTER}.0`) {
      return;
    }
    const now =
      state.val !== null && typeof state.val === "object" ? null : canonical([state.val, state.ack, state.q, state.c]);
    if (now !== null && states.get(id) === now) {
      watch.unchangedStates.push(id);
    }
    states.set(id, now);
  });
  // Round 64: a restart the harness plays (playControllerRestarts) is a new start — the per-start counts begin again,
  // the known object content stays (it is the database's).
  watch.newStart = () => {
    watch.writes.clear();
    states.clear();
  };
  const list = await harness.objects.getObjectListAsync({ startkey: NS, endkey: `${NS}香` });
  for (const row of list.rows) {
    if (row.value) {
      known.set(row.id, content(row.value));
      roles.set(row.id, row.value.common?.role);
      if (row.value.type === "state" && row.value.common?.write === false) {
        READ_ONLY.add(row.id);
      }
    }
  }
  return watch;
}

/**
 * Adapter-specific: make the adapter create every object it can create.
 * A catalog-driven adapter needs nothing here (its objects appear at start).
 * A device/API-driven adapter feeds fixtures for EVERY device type here — a fake
 * device/cloud endpoint on localhost, MQTT messages, or a message via sendTo —
 * never only the maintainer's own devices.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function feedFixtures(harness) {
  await waitForEveryAppliance(harness);
}

const FIXTURE_DIR = path.join(__dirname, "fixtures", "inventory");
const APPLIANCE_COUNT = fs.readdirSync(FIXTURE_DIR).filter(f => f.endsWith(".json")).length;
// Round 123: the smaller account the fixture hook lists in an installation the limit tests judge (LIMIT_ACCOUNT) — the
// same file the hook reads.
const LIMIT_ACCOUNT_TYPES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "limit-account.json"), "utf8"));

/**
 * The appliances this installation's account lists: the smaller account while the limit tests count it, every fixture
 * type otherwise.
 */
function accountSize() {
  return counting ? LIMIT_ACCOUNT_TYPES.length : APPLIANCE_COUNT;
}

/**
 * The appliances that come online in this run: the account's, less the one the fixture hook lists as not connected
 * while the fleet suite "one device gone while the channel lives" sets INVENTORY_DROP_DEVICE. Counting the whole account
 * there left both waits in their deadline (Werkbank, round 132, measured 2026-10-20).
 */
function onlineTarget() {
  return accountSize() - (process.env.INVENTORY_DROP_DEVICE === "1" ? 1 : 0);
}
// The flag that makes the fixture hook list one more appliance, whose model is `info` (feedReservedNames). The adapter
// keeps it once set up, so the waits count at least every fixture appliance.
const RESERVED_FLAG = path.join(RESOURCE_DIR, "reserved-names");

/**
 * Wait for a STATE of the adapter, never for "the tree stopped growing": the per-appliance syncs are staggered, so a
 * quiet moment can mean "four appliances still only have their skeleton". The criterion is devicesOnline, not
 * devicesTotal: a start stamps every known appliance offline, and only THIS run's pass brings them online (devicesTotal is
 * written at start from the device objects already in the database). Since 1.20.0 the adapter spaces its requests 100 ms
 * apart (the API's 10/s) — against the instant fixture server that spacing IS the pass.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function waitForEveryAppliance(harness) {
  const deadline = Date.now() + 300000;
  for (;;) {
    const online = await harness.states.getStateAsync(`${NS}info.devicesOnline`);
    if (online && online.val >= onlineTarget()) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`only ${online ? online.val : 0} of ${onlineTarget()} appliances came online in this run`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  // Every appliance is known; now let the per-appliance resources settle.
  let previous = -1;
  for (;;) {
    const count = Object.keys(await dumpObjects(harness)).length;
    if (count === previous) {
      return;
    }
    previous = count;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/**
 * Adapter-specific: wait until the adapter has really DONE its work on top of the SEEDED tree.
 * Suite 2 only — suite 1 needs nothing beyond feedFixtures. Name it after the adapter's own cycle
 * (parcelapp: `waitForCompletedPoll`); what matters is the criterion, not the name.
 *
 * Suite 2 seeds the previous release's OBJECTS before the start, so a wait that looks for objects
 * — which is exactly what feedFixtures does in suite 1 — is satisfied on its first look, and the
 * assertions run before the adapter has written anything. Suite 1 has the same blind spot wherever
 * ALL objects come from `instanceObjects`: js-controller creates them before `ready` fires, so an
 * object wait proves nothing about the adapter; there suite 1 also waits for a value the adapter
 * itself writes (for example `info.connection`, acknowledged). Measured public-holidays 2026-09-25:
 * with the ready handler never registered, suite 1 stayed green on the object wait alone. Measured parcelapp
 * 2026-09-07 (its first upgrade run): the assertion fired 13 ms after `onReady`, and the adapter's
 * only poll attempt hit the fixture server AFTER `after()` had already closed it. The suite then
 * reported "desc still undefined" for the three datapoints whose description was new — which reads
 * exactly like an adapter that fails to reach existing objects, while in truth nothing had run yet.
 * A catalog adapter, whose feedFixtures is `void harness`, has NO wait here at all.
 *
 * The seed uses `setObjectAsync` — objects only, never a VALUE. State values are therefore the one
 * signal it cannot fake.
 *
 * ⚠️ Cover EVERY object area the suites check, and wait there for the value the cycle writes LAST.
 * The wait ends as soon as every id below has a state; whatever the cycle writes after the last waited
 * id is checked unwaited. Measured on parcelapp 2026-09-25 (CI run 36123917452): the wait watched
 * `.carrier` (written early, per package), `updateSummary` wrote the three `summary.*` values a few
 * milliseconds after the check, and the suite reported "desc still …" only there — green locally,
 * red in CI. A value counts as written once its state exists (`""` included where the adapter really
 * writes it — the seed never writes values).
 *
 * ⚠️ Pick ids the adapter writes UNCONDITIONALLY on every cycle. A value behind a condition hangs
 * the wait until the deadline: parcelapp's `lastUpdated` writes only when the tracking data really
 * changed, and `info.connection` is no substitute either — it flips right after the API call and
 * before the per-device states are written.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function waitForAdapterWork(harness) {
  // homeconnect: `info.devicesOnline` is flushed once at the end of the whole appliance pass (the start stamps every
  // appliance offline first), and `info.connection` turns true only after the pass, the subscription and the event
  // stream — the last step of the start chain. The fixture stream sends one keep-alive and nothing else, so nothing is
  // written after it.
  const deadline = Date.now() + 300000;
  for (;;) {
    const online = await harness.states.getStateAsync(`${NS}info.devicesOnline`);
    const connection = await harness.states.getStateAsync(`${NS}info.connection`);
    if (online && online.val >= onlineTarget() && connection && connection.val === true) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no completed start chain — ${online ? online.val : 0} of ${onlineTarget()} appliances online, ` +
          `connection ${connection ? connection.val : "unset"}`,
      );
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/**
 * Adapter-specific config the fixtures need. The values only ever reach the fake endpoint; the Client ID has the
 * portal's form (64 hexadecimal characters) — any other form draws a warning.
 */
const FIXTURE_NATIVE = {
  clientID: "F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7",
  clientSecret: "fixture-client-secret",
};
/**
 * Round 113 (krobi 2026-10-14 11:28, every copy improvised its own hook names before): adapter-specific — the `--require`
 * hooks that route the adapter to its fixtures inside its own process (a host, a device address or `fetch` sent to the
 * fixture; a DNS answer), each `path.join(__dirname, "<file>")`. adapterEnv puts them into EVERY start; no suite names
 * a hook of its own. Empty where the adapter reaches its fixtures through its settings alone.
 */
const FIXTURE_HOOKS = [path.join(__dirname, "inventory-fetch-hook.cjs")];
/**
 * Round 123 (homeconnect 2026-10-15: the fetch hook widened the request budget in every start, so the limit suites judged
 * a limiter that was switched off): adapter-specific — the `--require` hooks that change only the adapter's own pace (a
 * budget widened so a thousand fixture calls take seconds, not twenty minutes), each `path.join(__dirname, "<file>")`.
 * adapterEnv drops them from the installations the limit tests judge (countThisInstallation); the limit tests then judge
 * only those. B02 holds a fixture hook that sets an environment variable `src/` reads: it belongs here.
 */
const PACING_HOOKS = [path.join(__dirname, "inventory-pacing-hook.cjs")];
/**
 * Round 123: adapter-specific — true when the adapter's fixture hooks serve a smaller account in an installation the limit
 * tests judge (`process.env.INVENTORY_COUNTED === "1"`), because its full fixture account does not fit a declared limit
 * at its own pace; the inventory and every other suite keep the full account. The suite `one counterpart hangs` then
 * demands that a judged installation pressed every limit below a day — a smaller account that never reaches a limit
 * proves nothing.
 */
const LIMIT_ACCOUNT = true;
/**
 * Round 113: adapter-specific — the instance's native for one start: FIXTURE_NATIVE, or what this run computes (fixture
 * servers on ports chosen now, a device table built from them), plus what a suite asks for in `extra` (the chosen
 * address, an adapter's own knob). Every suite sets its native through this, nothing else.
 *
 * @param {Record<string, unknown>} [extra] what this suite sets on top
 * @returns {Promise<Record<string, unknown>>} the native for resetInstanceNative
 */
async function fixtureNative(extra = {}) {
  return { ...FIXTURE_NATIVE, ...extra };
}
/**
 * Round 66 (reported by dl-manager): every datapoint of the previous release this release moves under a new id —
 * previous full id → current full id (adapter-specific like FIXTURE_NATIVE, may be computed). The recording is the
 * user's and goes on with the moved datapoint (krobi 2026-09-02); the upgrade suite checks that it arrived there.
 */
// homeconnect: derived from the previous release's inventory with the adapter's own layout rules, so no id list is kept
// by hand — a run value under `options` (before decision 49) goes to its channel by `runValueChannel` + `layoutChannel`
// (`run`, `counters`; krobi 2026-10-16), a total or run value under `status` the same way, each door boolean to its own
// datapoint in `doors` (`doorOpen` → `door`, `doorLocked` → `doorLocked`, `door<Compartment>Open` → `<compartment>`), and
// the last run into the history (`lastRun.<x>` → `history.latest.<x>`, krobi 2026-10-20) — except where the history
// already had that datapoint (program, duration of a laundry appliance): there the old one goes and hands nothing on.
const MOVES = previousMoves(process.env.INVENTORY_PREVIOUS);

/**
 * homeconnect's moves from the previous release's inventory (see MOVES).
 *
 * @param {string | undefined} previousFile the previous release's inventory
 * @returns {Record<string, string>} previous full id → current full id
 */
function previousMoves(previousFile) {
  if (!previousFile || !fs.existsSync(previousFile)) {
    return {};
  }
  const { runValueChannel } = require("../build/lib/run-values.js");
  const { layoutChannel } = require("../build/lib/tree-layout.js");
  const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
  const moves = {};
  for (const [id, obj] of Object.entries(previous)) {
    const parts = id.split(".");
    if (obj.type !== "state" || parts.length !== 5) {
      continue;
    }
    const [, , device, channel, leaf] = parts;
    const at = (to, toLeaf = leaf) => `${parts[0]}.${parts[1]}.${device}.${to}.${toLeaf}`;
    const key = obj.native && typeof obj.native.bshKey === "string" ? obj.native.bshKey : undefined;
    let to;
    if (channel === "lastRun") {
      to = at("history.latest");
      if (to in previous) {
        continue;
      }
    } else if (channel === "status" && /^door(Open|Locked)$/.test(leaf)) {
      to = at("doors", leaf === "doorOpen" ? "door" : "doorLocked");
    } else if (channel === "status" && /^door[A-Z]\w*Open$/.test(leaf)) {
      const compartment = leaf.slice(4, -4);
      to = at("doors", compartment.charAt(0).toLowerCase() + compartment.slice(1));
    } else if (channel === "options" && key && runValueChannel(key)) {
      to = at(layoutChannel(runValueChannel(key), leaf));
    } else if (channel === "status") {
      to = at(layoutChannel("status", leaf));
    }
    if (to && to !== id) {
      moves[id] = to;
    }
  }
  return moves;
}
/**
 * Round 87: adapter-specific like FIXTURE_NATIVE — the states that show an outage of EVERY counterpart, each with the
 * value it takes then (ids without the namespace, e.g. `{ "info.connection": false }` plus each device's reachability).
 * The return is shown once each has its value from before the cut again. Keep the fixture's cycles short through
 * FIXTURE_NATIVE: the outage holds for several of them. Round 96: these are the ONLY states whose value may change while
 * the counterpart is gone — every state that shows the outage belongs here (each device's reachability, a rollup such as
 * `devicesOnline`, a cloud flag); every other value stays as it was.
 */
const OUTAGE_SHOWN = { "info.connection": false };

/**
 * Round 104: adapter-specific like FIXTURE_NATIVE — for an adapter with a diagnostics report, every value the fixtures
 * give that is the user's own and must never stand in a report in plain text: the names a user gives (DB-05, krobi
 * 2026-10-06 15:20: replace the input names a user sets, 17:21: the newer decision holds), account names, tokens and
 * serial numbers (DB-04, krobi 2026-09-22 19:42: the report keeps the privacy it promises). Each value stands in a fixture
 * file under test/ (B02 checks it), so the list cannot name something the run never sees.
 */
// homeconnect: the head of every fixture haId (SIEMENS-HCFIX<type>-0001 — the serial a real haId carries), the head of
// every appliance name the user gave in the app ("Fixture <type>"), and the account's tokens and sign-in code.
const REPORT_PERSONAL = [
  "SIEMENS-HCFIX",
  "Fixture ",
  "FIXTURE-ACCESS-TOKEN",
  "FIXTURE-REFRESH-TOKEN",
  "FIXTURE-DEVICE-CODE",
];

/**
 * Round 104: adapter-specific like FIXTURE_NATIVE — the writable states (ids below the namespace) that are the adapter's
 * own setting and never go to a counterpart, so `ack: true` right away is right for them. Every other writable state
 * stays unconfirmed while no counterpart answers (krobi 2026-10-07 15:54: never `ack: true` unless the device confirmed).
 * B02 checks each id is a writable state of the inventory.
 */
const LOCAL_STATES = [];
/**
 * Round 107 (krobi 2026-10-08 09:31, an exception to the fleet rule for one adapter: "in this particular case a small
 * exception"): adapter-specific like LOCAL_STATES — the writable states (ids below the namespace, `*` for one
 * segment) whose protocol has no answer from the device at all, so a command that went out without waiting for an answer
 * may be confirmed. Only what krobi granted: B02 checks every pattern against `commandConfirmation.sendOnly.states` in the
 * adapter's decision register (gate A14) and that it matches a writable state of the inventory; without that grant the
 * list stays empty.
 */
const SEND_CONFIRMED = [];
/**
 * Round 87 (krobi 2026-10-03 00:04: "KEIN adapter jemals darf info schreiben"): adapter-specific like feedFixtures —
 * make the adapter meet a device, account or entry whose name is `info`, and wherever the adapter builds an id from
 * something a device or service reports (a model, a type, a host), one that reports `info` there; the same way
 * feedFixtures feeds, and wait until the adapter has handled it. The suite "a name that is the adapter's own" then
 * checks that `info` and everything below it are still the adapter's own objects. Required wherever the manifest declares
 * an `info` object.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function feedReservedNames(harness) {
  // homeconnect builds an appliance's id from its model (vib) and the last characters of its haId. An appliance whose
  // model is `info` and whose haId carries no letter or digit would get exactly `info` without the adapter's guard. The
  // flag makes the fixture hook list it and send its PAIRED event on the open stream — the adapter reads the list again,
  // as for any newly paired appliance.
  fs.writeFileSync(RESERVED_FLAG, "");
  try {
    const deadline = Date.now() + 120000;
    for (;;) {
      const devices = Object.values(await dumpObjects(harness)).filter(
        o => o.type === "device" && o.native?.haId === "--",
      );
      const online = await harness.states.getStateAsync(`${NS}info.devicesOnline`);
      if (devices.length === 1 && online?.val === APPLIANCE_COUNT + 1) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `the appliance named info was not set up (${devices.length} device object(s), ${online?.val} online)`,
        );
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } finally {
    fs.rmSync(RESERVED_FLAG, { force: true });
  }
}

async function dumpObjects(harness) {
  // The range starts at "<adapter>.0." — the instance root object itself is not part of the tree.
  const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  const out = {};
  for (const row of list.rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const obj = { ...row.value };
    for (const key of VOLATILE) delete obj[key];
    out[row.id] = obj;
  }
  return out;
}

/**
 * Set the throwaway controller's system language — what the adapter reads from `system.config`.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {string} language an ioBroker language code
 */
async function setSystemLanguage(harness, language) {
  const config = await harness.objects.getObject("system.config");
  config.common.language = language;
  await harness.objects.setObject("system.config", config);
}

/**
 * Dump the value of every state of the instance: `{ "<id>": { val, ack } }`, sorted. The states client has no
 * `getKeysAsync` — `getKeys`/`getStates` (like `getObject`/`setObject`) return a promise without a callback.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function dumpStates(harness) {
  const keys = (await harness.states.getKeys(`${NS}*`)).sort();
  const values = await harness.states.getStates(keys);
  const out = {};
  keys.forEach((key, i) => {
    if (values[i]) out[key] = { val: values[i].val, ack: values[i].ack };
  });
  return out;
}

/**
 * The throwaway js-controller keeps its instance object between runs, and changeAdapterConfig only
 * EXTENDS native — a key that an older version of this adapter wrote would survive and trigger the
 * start-up key migration and with it a host restart (played since round 64) in every suite. Null every key the
 * fixture does not know, then apply the fixture (null is the post-migration state of a renamed key).
 * changeAdapterConfig encrypts the `encryptedNative` keys, but merges with alcalzone-shared `extend` (round 66, reported
 * by dl-manager): a list goes element-wise into the one already there (the old tail stays, an empty list resets
 * nothing), and under a new key it becomes an object with numeric keys. Every key but an encrypted one goes in again
 * as a whole.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {Record<string, unknown>} native the instance's native for this start (FIXTURE_NATIVE, or one computed per run)
 */
async function resetInstanceNative(harness, native) {
  const id = `system.adapter.${ADAPTER}.0`;
  const instance = await harness.objects.getObjectAsync(id);
  const stale = {};
  for (const key of Object.keys(instance?.native ?? {})) {
    if (!Object.hasOwn(native, key)) stale[key] = null;
  }
  await harness.changeAdapterConfig(ADAPTER, { native: { ...stale, ...native } });
  const written = await harness.objects.getObjectAsync(id);
  for (const [key, value] of Object.entries(native)) {
    if (!written.encryptedNative?.includes(key)) written.native[key] = value;
  }
  await harness.objects.setObjectAsync(id, written);
}

/**
 * Round 71 (reported by dl-manager): @iobroker/testing clears only the database and the log directory before a suite;
 * the instance's data folder (`utils.getAbsoluteInstanceDataDir`, `iobroker-data/<adapter>.0` under the test directory)
 * survives every suite and every run. A file the fresh-install suite wrote was still there when the upgrade suite
 * started, and hid the move of the seeded previous objects into that file — the suite stayed green without the move
 * ever running. A fresh installation has no data folder, so each suite starts without one; the second start of
 * `playControllerRestarts` keeps it, as a real host does. Round 113: it marks the new installation (`<time>.install`) —
 * the declared limits count each installation on its own (two fresh installations a minute apart cannot share a budget).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
function clearInstanceData(harness) {
  if (typeof harness.testDir !== "string") {
    throw new Error("the harness no longer carries testDir — clearInstanceData cannot find the instance data folder");
  }
  fs.rmSync(path.join(harness.testDir, "iobroker-data", `${ADAPTER}.0`), { recursive: true, force: true });
  fs.writeFileSync(path.join(RESOURCE_DIR, `${Date.now()}.install`), "");
}

/**
 * js-controller 7.2.2 restarts an instance on EVERY change of its instance object while it runs (controller main.ts,
 * objects `change` handler: `stopInstance`, then `startInstance` after `stopTimeout` + 2.5 s) — whoever wrote it, the
 * adapter's own settings migration or device table included. The harness has no host; this plays it (round 64): the
 * adapter's first own write while it runs stops it and starts it once more with the same hooks, so what the adapter did
 * after that write in the same start is cut off here as it is on a real host. An own write after that restart is a
 * finding: on a host the instance would restart again, for good. Only the adapter's own writes count (round 66): the
 * suite's resetInstanceNative writes before the start, but on a slow runner its event arrived after the start and
 * stopped a start midway. Each step has a deadline: a harness call that never settles is logged the moment it misses it,
 * and fails the suite in its own words where `await restarts.done` is the open wait (the upgrade suite's order).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {object | null} watch the suite's write watcher (watchObjectWrites), null in a suite without one
 * @param {...string} hooks the test hooks the suite starts the adapter with (as for adapterEnv)
 */
function playControllerRestarts(harness, watch, ...hooks) {
  const restarts = { count: 0, again: [], done: Promise.resolve() };
  harness.on("objectChange", (id, obj) => {
    if (
      id !== `system.adapter.${ADAPTER}.0` ||
      obj?.from !== `system.adapter.${ADAPTER}.0` ||
      !harness.isAdapterRunning()
    ) {
      return;
    }
    if (restarts.count > 0) {
      restarts.again.push(Date.now());
      return;
    }
    restarts.count++;
    restarts.done = restartAsTheHost(harness, watch, "after it changed its instance object", ...hooks);
    // Awaited by the suite later — a wait before that (feedFixtures) fails first on an adapter that hangs in its stop,
    // so a missed deadline is logged the moment it happens (and never counts as an unhandled rejection).
    restarts.done.catch(err => console.error(`restart play failed: ${err.message}`));
  });
  return restarts;
}

/**
 * Round 66: the promise's value, or an error naming what hung once the deadline has passed.
 *
 * @param {Promise<unknown> | undefined} promise the harness call
 * @param {number} ms the deadline
 * @param {string} what what did not happen, in the failure message
 */
async function withinDeadline(promise, ms, what) {
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} (deadline ${ms} ms)`)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Round 64, a helper since round 113: stop the running adapter and start it again as the host does after a change of its
 * instance object — the data folder stays, `alive` false, the start after RESTART_DELAY_MS. playControllerRestarts plays it
 * on the adapter's own write; the suite "a restart right after the start" plays it on purpose.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {{ newStart(): void } | undefined} watch what watchObjectWrites returned
 * @param {string} why when the restart comes, in the stop's failure message
 * @param {...string} hooks the test hooks of the start (as for adapterEnv)
 */
async function restartAsTheHost(harness, watch, why, ...hooks) {
  await withinDeadline(harness.stopAdapter(), STOP_DEADLINE_MS, `the adapter did not stop ${why}`);
  watch?.newStart();
  // What the host does when the process exits: `alive` false (a start that still sees it true ends with
  // ADAPTER_ALREADY_RUNNING, exit code 7), then the start after stopTimeout + 2.5 s.
  await harness.states.setState(`system.adapter.${ADAPTER}.0.alive`, {
    val: false,
    ack: true,
    from: "system.host.testing",
  });
  await new Promise(resolve => setTimeout(resolve, RESTART_DELAY_MS));
  // @iobroker/testing refuses a second start of one harness ("already been used"); the host starts the same
  // instance again — reset the exit marker, and fail loudly should the harness no longer keep it there.
  harness._adapterExit = undefined;
  assert.ok(!harness.didAdapterStop(), "@iobroker/testing changed its exit marker — the restart play needs a new form");
  await withinDeadline(
    harness.startAdapterAndWait(false, adapterEnv(...hooks)),
    START_DEADLINE_MS,
    "the adapter did not come back after the restart",
  );
}

/**
 * Round 113: wait until no call was counted for SETTLE_MS since `since` — the restarted process has done its start's work
 * (its state values exist from the first start, so waitForAdapterWork would end at once) — at most
 * RESTART_QUIET_DEADLINE_MS (an adapter with a steady poll never falls quiet).
 *
 * @param {number} since the moment of the restart
 */
async function waitForQuietCalls(since) {
  const deadline = Date.now() + RESTART_QUIET_DEADLINE_MS;
  for (;;) {
    const last =
      readCalls()
        .filter(c => c.t >= since)
        .at(-1)?.t ?? since;
    if (Date.now() - last >= SETTLE_MS || Date.now() > deadline) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/** Round 64: the host's wait before it starts a stopped instance again (controller main.ts, `stopTimeout || 500` + 2.5 s). */
const RESTART_DELAY_MS = (require(path.join(ADAPTER_DIR, "io-package.json")).common.stopTimeout || 500) + 2500;
/**
 * Round 66: the restart's deadlines — stopTimeout, the 500 ms the adapter gives pending writes, and the exit; then a start
 * as the harness waits for it (`alive` true). Both together stay far below the suites' before() timeout.
 */
const STOP_DEADLINE_MS = RESTART_DELAY_MS + 2500;
const START_DEADLINE_MS = 30000;
/** Round 64: the recording marker every seeded state carries in `common.custom`, naming the id it was seeded under. */
const RECORDING = "inventory-recording.0";

/**
 * Seed the previous release's objects before the start. Every state carries a recording marker (round 64): what hangs
 * on a datapoint is the user's — it goes on with the SAME datapoint (its id, or the one id a move gives it), never onto
 * a new datapoint, and never decides what the adapter creates, keeps or deletes (that shows up as a leftover or a
 * missing object against the committed inventory).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {Record<string, ioBroker.Object>} previous the previous release's inventory
 */
async function seedPrevious(harness, previous) {
  for (const [id, obj] of Object.entries(previous)) {
    const common =
      obj.type === "state"
        ? { ...obj.common, custom: { ...obj.common?.custom, [RECORDING]: { enabled: true, origin: id } } }
        : obj.common;
    await harness.objects.setObjectAsync(id, { ...obj, common });
  }
}

/** Round 67: the text a dump puts where the adapter stored a secret encrypted with its installation's secret. */
const ENCRYPTED_MARKER = "<encrypted with the installation secret>";

/**
 * Round 67 (reported by dl-manager): adapter-specific like feedFixtures. The previous release's dump carries
 * ENCRYPTED_MARKER wherever the adapter stored a secret encrypted with its installation's secret — no other controller
 * can read that cipher. Put a working secret back into every such seeded object, the fixture's value in the form the
 * adapter stores it (encrypted like the adapter does, e.g. with encryptPassword), so the upgrade starts on objects the
 * adapter can use. Empty where the dump masks nothing.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function restoreMaskedSecrets(harness) {}

/**
 * Round 75 (reported by dl-manager): adapter-specific like feedFixtures. The previous release's dump carries objects
 * only; what that release kept in the instance data folder (utils.getAbsoluteInstanceDataDir — a store file, a cache,
 * a credential file) is not in it, and clearInstanceData has just emptied the folder. Write here what the previous
 * release left there for the fixture setup, in its format, into the instance data folder under the harness test
 * directory (the same folder clearInstanceData empties), so the upgrade starts where a real installation stands.
 * Empty only where the adapter declares no common.dataFolder (it writes nothing there); with the declaration B02
 * requires a body.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {object} previous the previous release's dump
 */
async function seedInstanceData(harness, previous) {}

/**
 * Round 67: the objects of the namespace that still carry ENCRYPTED_MARKER — read raw from the database, never through
 * dumpObjects (an adapter's dump masks again). Checked right after the restore, before the start: later the adapter may
 * have rewritten or deleted the object, and a clean result would prove nothing about the seeded one.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function maskedSecretsLeft(harness) {
  const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  return list.rows.filter(row => JSON.stringify(row.value).includes(ENCRYPTED_MARKER)).map(row => row.id);
}

/**
 * Round 87: wait until every state named (ids without the namespace) holds the wanted value.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {Record<string, unknown>} wanted id → value
 * @param {string} what what did not happen, in the failure message
 */
async function waitForStates(harness, wanted, what) {
  const deadline = Date.now() + OUTAGE_DEADLINE_MS;
  for (;;) {
    const wrong = [];
    for (const [id, val] of Object.entries(wanted)) {
      const state = await harness.states.getStateAsync(`${NS}${id}`);
      if (state?.val !== val) {
        wrong.push(`${id} = ${JSON.stringify(state?.val)}, want ${JSON.stringify(val)}`);
      }
    }
    if (wrong.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`${what} (deadline ${OUTAGE_DEADLINE_MS} ms):\n${wrong.join("\n")}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/**
 * Round 87 (krobi 2026-10-02 23:26: no datapoint is deleted or emptied because a device is gone — the adapter shows
 * whether it is reachable): cut every counterpart, hold, bring it back. Returns when each phase began and the adapter's
 * own log lines of the outage and of the return. Round 96 (krobi 2026-10-06 17:55–17:56: nothing is reset either —
 * a value is a datapoint's content): it also returns every value of the namespace from before the cut, each state's
 * `def`, and every value the adapter wrote from the cut until the end of the return (`[id, value, time]`; a deleted or
 * expired state as `null`), and `back`, when the counterparts came back.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {{ deleted: string[] }} watch the suite's write watcher (watchObjectWrites)
 */
async function playOutage(harness, watch) {
  assert.ok(Object.keys(OUTAGE_SHOWN).length > 0, "OUTAGE_SHOWN names no state — nothing would show the outage");
  const before = {};
  for (const [id, val] of Object.entries(OUTAGE_SHOWN)) {
    before[id] = (await harness.states.getStateAsync(`${NS}${id}`))?.val;
    assert.notStrictEqual(before[id], val, `${id} already shows the outage before the cut`);
  }
  const values = new Map();
  const defs = new Map();
  const list = await harness.objects.getObjectListAsync({ startkey: NS, endkey: `${NS}香` });
  for (const row of list.rows) {
    if (row.value?.type === "state") {
      values.set(row.id, canonical((await harness.states.getStateAsync(row.id))?.val ?? null));
      defs.set(row.id, canonical(row.value.common?.def ?? null));
    }
  }
  const writes = [];
  const record = (id, state) => {
    if (id.startsWith(NS) && (!state || state.from === `system.adapter.${ADAPTER}.0`)) {
      writes.push([id, state ? canonical(state.val ?? null) : null, Date.now()]);
    }
  };
  harness.on("stateChange", record);
  const outage = {
    cut: Date.now(),
    deleted: watch.deleted.length,
    line: harness.getLogs().length,
    values,
    defs,
    writes,
    back: 0,
  };
  fs.writeFileSync(OUTAGE_FLAG, "");
  try {
    await waitForStates(harness, OUTAGE_SHOWN, "the adapter did not show the outage");
    const shown = Date.now();
    await new Promise(resolve => setTimeout(resolve, Math.max(OUTAGE_HOLD_MS, shown - outage.cut)));
  } finally {
    // A cut that stays on after a failed wait would cut every later suite of the run too.
    outage.back = Date.now();
    fs.rmSync(OUTAGE_FLAG, { force: true });
  }
  try {
    await waitForStates(harness, before, "the adapter did not show the return");
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
  } finally {
    harness.removeListener("stateChange", record);
  }
  outage.lines = harness
    .getLogs()
    .slice(outage.line)
    .filter(l => l.from === `${ADAPTER}.0`);
  return outage;
}

/** Round 100: every call the network hook counted so far (`<pid>.calls`), oldest first. */
function readCalls() {
  return fs
    .readdirSync(RESOURCE_DIR)
    .filter(f => f.endsWith(".calls"))
    .flatMap(f =>
      fs
        .readFileSync(path.join(RESOURCE_DIR, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map(l => ({ ...JSON.parse(l), pid: f.slice(0, -".calls".length) })),
    )
    .sort((a, b) => a.t - b.t);
}

/** Round 100: one channel to a counterpart — the kind of call, the host and the port. */
function channel(c) {
  return `${c.kind} ${c.host}:${c.port}`;
}

/**
 * Round 100 (krobi 2026-10-07 10:12: one device never blocks another): the counterpart the adapter reached first in the
 * starts before this suite hangs from the start of the next one — it takes the connection and never answers. The verdict
 * compares with `hang-idle`, the moment the adapter has no attempt at it open any more: a start loop that awaits the hung
 * device reaches the others only after that. A queue shared by every device AFTER their first contact is not seen here
 * (round 100, yamaha copy with one planted MusicCast queue: green) — the suite "one counterpart hangs mid-run" sees it
 * (round 107, playHangMidRun). Returns it
 * and every channel of the OTHER counterparts in those starts (a device reached over one channel can still wait on the hung
 * one over another); `hung` is null where there are fewer than two channels — the rule does not apply there. Round 113
 * (govee inv4): `usual` holds, per channel, the earliest it was reached in those starts, counted from its process's first
 * call — a channel whose first contact always comes later than the moment the adapter gives up on the hung one cannot
 * show a wait, and is not judged.
 */
function startHang() {
  const calls = readCalls().filter(c => !c.kind.startsWith("hang-"));
  const opened = new Map();
  const usual = {};
  for (const c of calls) {
    opened.set(c.pid, opened.get(c.pid) ?? c.t);
    usual[channel(c)] = Math.min(usual[channel(c)] ?? Infinity, c.t - opened.get(c.pid));
  }
  const hosts = [...new Set(calls.map(c => c.host))];
  if (hosts.length >= 2) {
    fs.writeFileSync(HANG_FLAG, hosts[0]);
    const others = [...new Set(calls.filter(c => c.host !== hosts[0]).map(channel))];
    return { hung: hosts[0], others, usual, since: Date.now() };
  }
  // Round 104: every counterpart on one host (fixtures on 127.0.0.1) — one CHANNEL hangs, the hook takes `<host> <port>`
  const ports = [...new Set(calls.map(c => `${c.host} ${c.port}`))];
  if (ports.length < 2) {
    return { hung: null, others: [], usual, since: Date.now() };
  }
  fs.writeFileSync(HANG_FLAG, ports[0]);
  const others = [...new Set(calls.filter(c => `${c.host} ${c.port}` !== ports[0]).map(channel))];
  return { hung: ports[0], others, usual, since: Date.now() };
}

/**
 * Round 100: wait until every other counterpart was reached, at most HANG_DEADLINE_MS, then let the hung one go. Returns
 * every call since the start; feedFixtures runs alongside, because it may wait for the hung counterpart too.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {{ hung: string | null, others: string[], usual: Record<string, number>, since: number }} hang what startHang chose
 */
async function playHang(harness, hang, restarts) {
  try {
    if (hang.hung === null) {
      return { ...hang, calls: [] };
    }
    const fed = feedFixtures(harness).then(
      () => undefined,
      err => err,
    );
    let calls = [];
    for (;;) {
      // A restart the host plays ends the process, and its hung connections close as if it gave up: only the process
      // started last is judged, its deadline counting from its own first call (a restart costs it nothing).
      await restarts.done;
      const all = readCalls().filter(c => c.t >= hang.since);
      const pid = [...new Set(all.map(c => c.pid))].at(-1);
      calls = all.filter(c => c.pid === pid);
      if (hang.others.every(k => calls.some(c => !c.kind.startsWith("hang-") && channel(c) === k))) {
        break;
      }
      if (Date.now() > (calls[0]?.t ?? hang.since) + HANG_DEADLINE_MS) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    void fed;
    return { ...hang, calls };
  } finally {
    fs.rmSync(HANG_FLAG, { force: true });
  }
}

/**
 * Round 113 (govee inv4: an app-version check called once at the start was chosen and never hung): the counterpart that
 * hangs mid-run is the one this process talked to last over a request or a connection, among those it reached at least
 * twice in the warm-up — a single contact never comes again. One that only gets datagrams never waits on an answer; a
 * host hangs as a whole where the requests go to two hosts or more, else one channel. Returns the word for the hang file
 * (null where none qualifies) and every channel of the others.
 *
 * @param {{ kind: string, host: string, port: number, t: number }[]} seen the warm-up's calls of one process, oldest first
 */
function midRunHang(seen) {
  const asked = seen.filter(c => c.kind !== "udp");
  const byHost = new Set(asked.map(c => c.host)).size >= 2;
  const wordOf = c => (byHost ? c.host : `${c.host} ${c.port}`);
  const count = new Map();
  for (const c of asked) {
    count.set(wordOf(c), (count.get(wordOf(c)) ?? 0) + 1);
  }
  const last = asked.filter(c => count.get(wordOf(c)) >= 2).at(-1);
  const word = last === undefined ? null : wordOf(last);
  const others = word === null ? [] : [...new Set(seen.filter(c => wordOf(c) !== word).map(channel))];
  return { word, others };
}

/**
 * Round 107 (W100-5, krobi 2026-10-07 10:12: one device never blocks another): the adapter first runs undisturbed for
 * HANG_WARMUP_MS (a restart the host plays starts the warm-up again), then the counterpart it talks to (midRunHang, round
 * 113) begins to hang while the adapter already talks to it — an open connection goes silent, every new contact
 * hangs — until HANG_DEADLINE_MS have passed. Returns the hung counterpart and every channel of the others, the calls of
 * that one process from the start of its warm-up, and the end.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {{ done: Promise<void> }} restarts the host play of the suite
 */
async function playHangMidRun(harness, restarts) {
  const since = Date.now();
  const fed = feedFixtures(harness).then(
    () => undefined,
    err => err,
  );
  let pid;
  let warm = since;
  for (;;) {
    await restarts.done;
    const calls = readCalls().filter(c => c.t >= since);
    const last = [...new Set(calls.map(c => c.pid))].at(-1);
    if (last !== pid) {
      pid = last;
      warm = calls.find(c => c.pid === pid)?.t ?? Date.now();
    }
    if (Date.now() >= warm + HANG_WARMUP_MS) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const seen = readCalls().filter(c => c.pid === pid && c.t >= warm && !c.kind.startsWith("hang-"));
  const { word, others } = midRunHang(seen);
  if (word === null) {
    console.log(
      "      no counterpart was reached twice over a request or a connection in the warm-up — nothing hangs mid-run",
    );
  }
  const hang = { hung: others.length > 0 ? word : null, others, since: Date.now() };
  if (hang.hung !== null) {
    fs.writeFileSync(HANG_FLAG, hang.hung);
  }
  try {
    while (hang.hung !== null && Date.now() < hang.since + HANG_DEADLINE_MS) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    void fed;
    return { ...hang, pid, end: Date.now(), calls: readCalls().filter(c => c.pid === pid && c.t >= warm) };
  } finally {
    fs.rmSync(HANG_FLAG, { force: true });
  }
}

/**
 * Round 100 (krobi 2026-10-07 10:14): the limits the adapter defines — `counterparts[]`, each with `name`, `match`
 * (`host`, `port`, `kind`: http, tcp, tcp-write or udp — every field given must fit; `tcp-write` is every write on a raw
 * connection of the adapter, round 104) and `limits[]` (`max` calls in `seconds`, `per`
 * account or host, and the `source`: a link to the documentation, a measurement with its date, or the adapter's own cap).
 */
function apiLimits() {
  assert.ok(
    fs.existsSync(API_LIMITS),
    "src/lib/api-limits.json is missing — the adapter defines no limit for the counterparts it calls",
  );
  return JSON.parse(fs.readFileSync(API_LIMITS, "utf8")).counterparts;
}

/** Round 100: whether a counted call belongs to a declared counterpart. */
function fits(call, match) {
  // round 107 (K18): `hostPattern`, an anchored regular expression, for a counterpart whose host differs per account
  return Object.entries(match).every(([key, value]) =>
    key === "hostPattern" ? new RegExp(value).test(String(call.host)) : call[key] === value,
  );
}

/**
 * Round 123: the counted calls of the installations the limit tests judge, each with its installation number — every
 * installation of the run where the adapter has no PACING_HOOKS (nothing changed its pace), otherwise only those
 * countThisInstallation marked; the others ran with a widened budget, the log says how many were left out.
 */
function judgedCalls() {
  const files = fs.readdirSync(RESOURCE_DIR);
  const installs = files.filter(f => f.endsWith(".install")).map(f => Number(f.slice(0, -".install".length)));
  const at = t => installs.filter(i => i <= t).length;
  const counted = new Set(
    files.filter(f => f.endsWith(".counted")).map(f => at(Number(f.slice(0, -".counted".length)))),
  );
  const judged = install => PACING_HOOKS.length === 0 || counted.has(install);
  const installOf = new Map();
  for (const c of readCalls().filter(c => !c.kind.startsWith("hang-"))) {
    installOf.set(c.pid, installOf.get(c.pid) ?? at(c.t));
  }
  const left = new Set([...installOf.values()].filter(i => !judged(i)));
  if (left.size > 0) {
    console.log(`      ${left.size} installation(s) ran with PACING_HOOKS — not judged against the limits`);
  }
  return readCalls()
    .filter(c => !c.kind.startsWith("hang-") && judged(installOf.get(c.pid)))
    .map(c => ({ ...c, install: installOf.get(c.pid) }));
}

/**
 * Round 123: the limits below a day that no judged installation pressed — with LIMIT_ACCOUNT the limiter is proven only
 * where one installation called a counterpart more often than such a limit allows in its window, so it had to spread the
 * calls. A day is no window of a run (the template's measured boundary).
 *
 * @param {{ install: number }[]} calls judgedCalls()
 * @param {{ name: string, match: object, limits: { max: number, seconds: number }[] }[]} counterparts apiLimits()
 */
function limitSlack(calls, counterparts) {
  const slack = [];
  for (const d of counterparts) {
    const per = new Map();
    for (const c of calls.filter(c => fits(c, d.match))) {
      per.set(c.install, (per.get(c.install) ?? 0) + 1);
    }
    const most = Math.max(0, ...per.values());
    for (const limit of d.limits.filter(l => l.seconds < 86400)) {
      if (most <= limit.max) {
        slack.push(
          `${d.name}: at most ${most} calls in one installation, never more than ${limit.max} in ${limit.seconds} s`,
        );
      }
    }
  }
  return slack;
}

/**
 * Round 101 (krobi 2026-10-07 15:54): a value the adapter can be told for a writable state — another entry of `states`,
 * the other boolean (a button: a press), a number inside min/max other than now, another colour, the current text.
 * Round 133 (govee CI 39408072351): every writable state gets one — D10 demands that each reaches the adapter's stateChange,
 * and null left 36 govee states without a command (an empty text, a list holding only the current key, min = max); then
 * the same key or number again, a colour or "command" for an empty text, the current value or an empty JSON otherwise.
 *
 * @param {Record<string, any>} common the state's common
 * @param {any} now its value now
 */
function commandValue(common, now) {
  if (common.states && typeof common.states === "object") {
    const keys = Array.isArray(common.states) ? common.states.map(String) : Object.keys(common.states);
    if (keys.length > 0) {
      const next = keys.find(k => k !== String(now)) ?? keys[0];
      return common.type === "number" ? Number(next) : common.type === "boolean" ? next === "true" : next;
    }
  }
  if (common.type === "boolean") {
    return String(common.role ?? "").startsWith("button") ? true : now !== true;
  }
  if (common.type === "number") {
    const min = typeof common.min === "number" ? common.min : 0;
    const max = typeof common.max === "number" ? common.max : min + 100;
    const step = typeof common.step === "number" && common.step > 0 ? common.step : 1;
    return now === min ? Math.min(max, min + step) : min;
  }
  if (common.type === "string") {
    if (typeof now === "string" && /^#[0-9a-f]{6}$/i.test(now)) {
      return now.toLowerCase() === "#123456" ? "#654321" : "#123456";
    }
    if (typeof now === "string" && now !== "") {
      return now;
    }
    return String(common.role ?? "").includes("color") ? "#123456" : "command";
  }
  if (now !== null && now !== undefined) {
    return now;
  }
  return common.type === "array" ? "[]" : common.type === "json" || common.type === "object" ? "{}" : "command";
}

/**
 * Round 101 (krobi 2026-10-07 15:54, GV-13 as the fleet rule for every adapter that talks to devices: never set ack true
 * unless the device confirmed it): every counterpart hangs and nothing reaches the adapter any more (the
 * network hook with `*` in HANG_FLAG), then every writable state of the adapter gets one command (commandValue), and the
 * suite waits COMMAND_WINDOW_MS. Returns the commands, every `ack: true` the adapter wrote on them, and every call the
 * hook counted with a command as its cause — the calls a command made, awaited or not.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
async function playCommands(harness) {
  const list = await harness.objects.getObjectListAsync({ startkey: NS, endkey: `${NS}香` });
  const writable = list.rows.map(r => r.value).filter(o => o?.type === "state" && o.common?.write !== false);
  const run = { writes: [], acks: [], since: Date.now() };
  const acknowledged = (id, state) => {
    if (id.startsWith(NS) && state?.ack === true && state.from === `system.adapter.${ADAPTER}.0`) {
      run.acks.push([id, state.ts]);
    }
  };
  fs.writeFileSync(HANG_FLAG, "*");
  harness.on("stateChange", acknowledged);
  try {
    for (const obj of writable) {
      const now = (await harness.states.getStateAsync(obj._id))?.val ?? null;
      const val = commandValue(obj.common, now);
      if (val !== null) {
        // round 134: a list whose only entry is the current one offers no command; D10 still hands the
        // write to stateChange, the confirmation leaves it out (until round 133 it got no write at all)
        const list = obj.common.states;
        const sole =
          typeof list === "object" && list !== null && Object.keys(list).length > 0 && String(val) === String(now);
        run.writes.push({ id: obj._id, val, t: Date.now(), sole });
        await harness.states.setStateAsync(obj._id, { val, ack: false });
      }
    }
    await new Promise(resolve => setTimeout(resolve, COMMAND_WINDOW_MS));
  } finally {
    harness.removeListener("stateChange", acknowledged);
    fs.rmSync(HANG_FLAG, { force: true });
  }
  run.calls = readCalls().filter(c => c.t >= run.since && c.cause !== undefined && !c.kind.startsWith("hang-"));
  return run;
}

/**
 * Round 107: a command to a state SEND_CONFIRMED grants may be confirmed once it went out — at least one call in its own
 * context, and every one of them a kind that waits for no answer (a UDP datagram, a write on a connection already open).
 * A request that waits (HTTP, fetch, a new connection) never gets its answer while everything hangs, so such a command
 * stays unconfirmed even for a granted state (krobi 09:31 / 09:39: sent without error, or the cloud's "success").
 *
 * @param {{ calls: { kind: string, cause?: string }[] }} command
 * @param {string} id
 */
function sentWithoutAnswer(command, id) {
  const rel = id.slice(NS.length).split(".");
  const granted = SEND_CONFIRMED.some(p => {
    const parts = p.split(".");
    return parts.length === rel.length && parts.every((s, i) => s === "*" || s === rel[i]);
  });
  const caused = command.calls.filter(c => c.cause === id);
  return granted && caused.length > 0 && caused.every(c => c.kind === "udp" || c.kind === "tcp-write");
}

/** Round 87: the network records (`<pid>.net`, test/network-hook.js) present now — a suite reads only the ones after. */
function networkFiles() {
  return new Set(fs.readdirSync(RESOURCE_DIR).filter(f => f.endsWith(".net")));
}

/**
 * Round 97: one `diagnostics` message to the adapter and its answer, as the admin card sends it.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {{ action: string }} message the message
 */
function askDiagnostics(harness, message) {
  const answer = new Promise(resolve => harness.sendTo(`${ADAPTER}.0`, "diagnostics", message, resolve));
  return withinDeadline(answer, REPORT_DEADLINE_MS, `no answer to the diagnostics message ${message.action}`);
}

/**
 * Round 97 (DB-01: a report is made and downloaded, never stored by the adapter): every file in the instance's data
 * folder and in the file store of its namespace, with size and modification time.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 */
function instanceFiles(harness) {
  const files = {};
  const walk = dir => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else {
        const stat = fs.statSync(file);
        files[path.relative(harness.testDir, file)] = `${stat.size} ${stat.mtimeMs}`;
      }
    }
  };
  const data = path.join(harness.testDir, "iobroker-data");
  walk(path.join(data, `${ADAPTER}.0`));
  walk(path.join(data, "files", `${ADAPTER}.0`));
  return files;
}

/**
 * Round 97 (krobi 2026-10-06, DB-01 to DB-13): ask for every device's report the way the admin card does — `list`, then
 * `start` and `result` every REPORT_POLL_MS until it is done — first with every counterpart there, then with every
 * counterpart gone (the outage switch, until OUTAGE_SHOWN shows it). Round 104 (krobi 2026-10-07 20:53, every fleet rule
 * complete and checked in the gate): between the two, every connected device's report once more while every
 * counterpart is silent (the hang file `*`) — a live read that really asks the device gets no answer then, one that
 * makes its answer up still says `read` (DB-02); the reports of one round run side by side in the adapter (the jobs keep
 * their state per device). Returns the devices and reports of the three rounds, the files, state keys, values and deletions before
 * and after, the window of the reports, and every value the adapter wrote while it made them.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness
 * @param {{ deleted: string[] }} watch the suite's write watcher (watchObjectWrites)
 */
async function playReports(harness, watch) {
  await harness.enableSendTo();
  // The jobs of one round run side by side in the adapter; the messages go one at a time — the harness keeps one
  // answer slot per message, two at once get each other's answer (measured round 104, yamaha copy: eight starts at once,
  // eight answers naming the first device).
  const fetchReports = async devices => {
    const jobs = [];
    for (const device of devices) {
      const started = await askDiagnostics(harness, { action: "start", device });
      assert.ok(
        typeof started?.job === "string",
        `start of the report for ${device} answered ${JSON.stringify(started)}`,
      );
      jobs.push({ device, job: started.job, deadline: Date.now() + REPORT_DEADLINE_MS });
    }
    const done = [];
    while (jobs.length > 0) {
      await new Promise(resolve => setTimeout(resolve, REPORT_POLL_MS));
      for (const job of [...jobs]) {
        const answer = await askDiagnostics(harness, { action: "result", job: job.job });
        if (!answer?.pending) {
          done.push({ device: job.device, answer });
          jobs.splice(jobs.indexOf(job), 1);
        } else {
          assert.ok(
            Date.now() < job.deadline,
            `the report for ${job.device} was not done (deadline ${REPORT_DEADLINE_MS} ms)`,
          );
        }
      }
    }
    return done;
  };
  const run = {
    files: instanceFiles(harness),
    keys: new Set(await harness.states.getKeys(`${NS}*`)),
    values: await dumpStates(harness),
    deleted: watch.deleted.length,
    start: Date.now(),
    writes: [],
    onlineWrites: [],
  };
  const recordInto = list => (id, state) => {
    if (id.startsWith(NS) && (!state || state.from === `system.adapter.${ADAPTER}.0`)) {
      list.push(id);
    }
  };
  const online = recordInto(run.onlineWrites);
  harness.on("stateChange", online);
  try {
    run.devices = (await askDiagnostics(harness, { action: "list" }))?.devices ?? [];
    run.reports = await fetchReports(run.devices.map(device => device.value));
  } finally {
    harness.removeListener("stateChange", online);
  }
  run.valuesAfterOnline = await dumpStates(harness);
  // past the gap a finished report keeps before the same device's next one
  await new Promise(resolve => setTimeout(resolve, REPORT_POLL_MS));
  fs.writeFileSync(HANG_FLAG, "*");
  try {
    run.silent = await fetchReports(run.devices.filter(d => d.connected).map(device => device.value));
  } finally {
    fs.rmSync(HANG_FLAG, { force: true });
  }
  // back to what showed the connection before the silence, before the outage round begins
  const before = Object.fromEntries(Object.keys(OUTAGE_SHOWN).map(id => [id, run.values[`${NS}${id}`]?.val]));
  await waitForStates(harness, before, "the adapter did not come back after the silent counterparts");
  const record = recordInto(run.writes);
  fs.writeFileSync(OUTAGE_FLAG, "");
  try {
    await waitForStates(harness, OUTAGE_SHOWN, "the adapter did not show the outage");
    // past the gap a finished report keeps before the same device's next one
    await new Promise(resolve => setTimeout(resolve, REPORT_POLL_MS));
    harness.on("stateChange", record);
    run.offlineDevices = (await askDiagnostics(harness, { action: "list" }))?.devices ?? [];
    run.offline = await fetchReports(run.offlineDevices.map(device => device.value));
  } finally {
    harness.removeListener("stateChange", record);
    run.end = Date.now();
    fs.rmSync(OUTAGE_FLAG, { force: true });
  }
  run.filesAfter = instanceFiles(harness);
  run.keysAfter = await harness.states.getKeys(`${NS}*`);
  return run;
}

/**
 * Round 87: what the adapter's processes since `seen` listened, bound, joined, sent and connected — a test hook's own
 * entries (`hook`) left out.
 *
 * @param {Set<string>} seen the record files before the suite's start (networkFiles)
 */
function networkUse(seen) {
  return fs
    .readdirSync(RESOURCE_DIR)
    .filter(f => f.endsWith(".net") && !seen.has(f))
    .flatMap(f =>
      fs
        .readFileSync(path.join(RESOURCE_DIR, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map(l => JSON.parse(l)),
    )
    .filter(r => !r.hook);
}

/**
 * Round 104 (krobi 2026-10-03 12:01, GV-28, his answer for every listener: fakeroku only warns because every Roku has a
 * port of its own; when the adapter cannot communicate at all, that is a fatal error): the ports another program may
 * hold before the adapter starts — every `primary` port of fleet.json
 * `listenPorts` and the first device's port of a `perDevice` entry, at the value the fixture gives it — and every other
 * port the adapter declares (`secondary`, the other devices), each a path it can still talk on. `shared` ports (SSDP)
 * are no path of their own. `declared` holds every port fleet.json names, at its fixture value (F6, round 104).
 */
function listenPortPlan() {
  const file = path.join(ADAPTER_DIR, "fleet.json");
  const fleet = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const native = { ...require(path.join(ADAPTER_DIR, "io-package.json")).native, ...FIXTURE_NATIVE };
  const taken = [];
  const others = [];
  const declared = new Set();
  for (const entry of fleet.listenPorts ?? []) {
    if (entry.role === "perDevice") {
      const [list, key] = String(entry.key).split("[].");
      const ports = (Array.isArray(native[list]) ? native[list] : []).map(d => Number(d?.[key])).filter(n => n > 0);
      taken.push(...ports.slice(0, 1).map(port => ({ protocol: entry.protocol, port })));
      others.push(...ports.slice(1));
      ports.forEach(port => declared.add(port));
    } else {
      const port = Number(entry.fixed ?? native[entry.key]);
      if (port > 0) {
        declared.add(port);
        if (entry.role === "primary") {
          taken.push({ protocol: entry.protocol, port });
        } else if (entry.role === "secondary") {
          others.push(port);
        }
      }
    }
  }
  return { taken, others, declared, address: native.bind || "0.0.0.0" };
}

/**
 * Round 104: hold each port the way another program would — a TCP server, an exclusive UDP socket — on the address the
 * adapter binds.
 *
 * @param {{ protocol: string, port: number }[]} ports the ports
 * @param {string} address the address
 */
async function takePorts(ports, address) {
  const held = [];
  for (const { protocol, port } of ports) {
    const holder =
      protocol === "udp"
        ? require("node:dgram").createSocket({ type: "udp4", reuseAddr: false })
        : require("node:net").createServer();
    await new Promise((resolve, reject) => {
      holder.once("error", reject);
      if (protocol === "udp") {
        holder.bind({ port, address, exclusive: true }, resolve);
      } else {
        holder.listen(port, address, resolve);
      }
    });
    held.push(holder);
  }
  return held;
}

/** Round 104 (DB-01): every file the adapter process wrote (`<pid>.files`, test/network-hook.js), with its time. */
function fileWrites() {
  return fs
    .readdirSync(RESOURCE_DIR)
    .filter(f => f.endsWith(".files"))
    .flatMap(f =>
      fs
        .readFileSync(path.join(RESOURCE_DIR, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map(l => JSON.parse(l)),
    );
}

/**
 * Round 104: every answer a counterpart sent (`<pid>.answers`, test/network-hook.js) from `from` until `until`, with the
 * adapter's own port it came in on (`local`).
 */
function readAnswers(from, until = Infinity) {
  return fs
    .readdirSync(RESOURCE_DIR)
    .filter(f => f.endsWith(".answers"))
    .flatMap(f =>
      fs
        .readFileSync(path.join(RESOURCE_DIR, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map(l => JSON.parse(l)),
    )
    .filter(a => a.t >= from && a.t < until);
}

/**
 * Round 87: every place the adapter used another address than `address` — a server on another address, a connection
 * from another source, a UDP socket on every address that joins no group on `address`, a group joined elsewhere, a
 * datagram that leaves from another address or, for multicast, through another interface.
 *
 * @param {object[]} use the records (networkUse)
 * @param {string} address the chosen address
 */
function offTheAddress(use, address) {
  const wrong = [];
  const sockets = new Map();
  for (const r of use) {
    if (r.kind === "listen" && r.host !== address) {
      wrong.push(`listens on ${r.host}:${r.port}`);
    }
    if (r.kind === "connect" && r.localAddress !== address) {
      wrong.push(`connects to ${r.host}:${r.port} from ${r.localAddress ?? "any address"}`);
    }
    // round 104: a fetch a fixture answers opens no socket — without a dispatcher of its own it is bound to nothing
    if (r.kind === "fetch" && !r.bound) {
      wrong.push(`fetches ${r.host}:${r.port} without a dispatcher on the chosen address`);
    }
    if (r.kind === "join" && r.iface !== address) {
      wrong.push(`joins ${r.group} on ${r.iface ?? "the default interface"}`);
    }
    if (r.id !== undefined) {
      const s = sockets.get(r.id) ?? { joins: 0, egress: [], sends: [] };
      if (r.kind === "bind") s.bind = r;
      if (r.kind === "join") s.joins++;
      if (r.kind === "egress") s.egress.push(r.iface);
      if (r.kind === "send") s.sends.push(r);
      sockets.set(r.id, s);
    }
  }
  for (const s of sockets.values()) {
    const bound = s.bind?.address;
    if (s.bind && bound !== address && s.joins === 0) {
      wrong.push(`UDP socket on ${bound}:${s.bind.port}`);
    }
    for (const t of s.sends) {
      const multicast = /^2(2[4-9]|3\d)\./.test(t.host);
      if (multicast ? !s.egress.includes(address) : bound !== address) {
        wrong.push(
          `sends to ${t.host}:${t.port} from ${multicast ? (s.egress.at(-1) ?? "the default interface") : (bound ?? "any address")}`,
        );
      }
    }
  }
  return [...new Set(wrong)];
}

/**
 * Round 87 (krobi 2026-10-02 23:52, F-05 of fakeroku as the fleet rule): a client from another network gets no answer —
 * every server and UDP port the adapter opened on `address` is asked once from 127.0.0.1. A TCP reply counts unless it is
 * an HTTP status of 400 or above; any UDP reply counts.
 *
 * @param {object[]} use the records (networkUse)
 * @param {string} address the chosen address
 */
async function askFromAnotherNetwork(use, address) {
  const answered = [];
  const asked = new Set();
  for (const r of use) {
    if (r.kind === "listen" && !asked.has(`tcp ${r.port}`)) {
      asked.add(`tcp ${r.port}`);
      const reply = await new Promise(resolve => {
        let data = "";
        const socket = require("node:net").connect({ host: address, port: r.port, localAddress: "127.0.0.1" });
        const wait = setTimeout(() => socket.destroy(), 1500);
        socket.on("connect", () => socket.write("GET / HTTP/1.0\r\n\r\n"));
        socket.on("data", d => (data += d));
        socket.on("error", () => {});
        socket.on("close", () => {
          clearTimeout(wait);
          resolve(data);
        });
      });
      const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(reply);
      if (reply && !(status && Number(status[1]) >= 400)) {
        answered.push(`TCP ${address}:${r.port} answered a client from 127.0.0.1`);
      }
    }
    if (r.kind === "bind" && r.port && !asked.has(`udp ${r.port}`)) {
      asked.add(`udp ${r.port}`);
      const reply = await new Promise(resolve => {
        const socket = require("node:dgram").createSocket("udp4");
        const wait = setTimeout(() => {
          socket.close();
          resolve(false);
        }, 1500);
        socket.on("message", () => {
          clearTimeout(wait);
          socket.close();
          resolve(true);
        });
        socket.bind(0, "127.0.0.1", () =>
          socket.send(
            'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n',
            r.port,
            address,
          ),
        );
      });
      if (reply) {
        answered.push(`UDP ${address}:${r.port} answered a sender from 127.0.0.1`);
      }
    }
  }
  return answered;
}

tests.integration(ADAPTER_DIR, {
  controllerVersion: "stable",
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      let watch;
      let restarts;
      let seen;
      before(async function () {
        this.timeout(120000);
        harness = getHarness();
        clearInstanceData(harness);
        watch = await watchObjectWrites(harness);
        await resetInstanceNative(harness, await fixtureNative());
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        seen = networkFiles();
        restarts = playControllerRestarts(harness, watch, NETWORK_HOOK);
        await harness.startAdapterAndWait(false, adapterEnv(NETWORK_HOOK));
        await feedFixtures(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
      });

      // Round 104 (krobi 2026-09-15 09:12: every listener, fixed ports included, F6): every port the adapter asks for
      // while it runs stands in fleet.json `listenPorts` — the package check reads the source, this the running process.
      it("listens only on the ports it declares", function () {
        const { declared } = listenPortPlan();
        const undeclared = [
          ...new Set(
            networkUse(seen)
              .filter(r => (r.kind === "listen" || r.kind === "bind") && r.asked > 0 && !declared.has(r.asked))
              .map(r => `${r.kind} ${r.asked}`),
          ),
        ];
        assert.deepStrictEqual(
          undeclared,
          [],
          `ports the adapter takes that fleet.json listenPorts does not declare:\n${undeclared.join("\n")}`,
        );
      });

      it("writes test/objects.inventory.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
      });

      it("writes test/states.inventory.json", async function () {
        this.timeout(30000);
        const states = await dumpStates(harness);
        assert.ok(Object.keys(states).length > 0, "no states written — fixtures did not reach the adapter");
        fs.writeFileSync(STATES_INVENTORY, `${JSON.stringify(states, null, 2)}\n`);
      });

      it("writes no object more than MAX_OBJECT_WRITES times", function () {
        const churn = [...watch.peak].filter(([, n]) => n > MAX_OBJECT_WRITES).map(([id, n]) => `${id} ×${n}`);
        assert.deepStrictEqual(churn, [], `objects written more than ${MAX_OBJECT_WRITES} times in one start`);
      });

      it("rewrites no object unchanged", function () {
        const idle = [...new Set(watch.unchanged)];
        assert.deepStrictEqual(idle, [], `objects written without a change:\n${idle.join("\n")}`);
      });

      it("rewrites no state unchanged", function () {
        const idle = [...new Set(watch.unchangedStates)];
        assert.deepStrictEqual(idle, [], `states written without a change:\n${idle.join("\n")}`);
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });
    });

    // The same run once more in a second system language: a label that stays the same in both was never
    // translated. A suite of its own — the harness starts an adapter only once per suite (a second
    // startAdapterAndWait in the same suite never resolves), and every suite gets a fresh database.
    suite("second system language", getHarness => {
      let harness;
      let restarts;
      before(async function () {
        this.timeout(120000);
        harness = getHarness();
        clearInstanceData(harness);
        await resetInstanceNative(harness, await fixtureNative());
        await setSystemLanguage(harness, SECOND_LANGUAGE);
        restarts = playControllerRestarts(harness, null);
        await harness.startAdapterAndWait(false, adapterEnv());
        await feedFixtures(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });

      it("writes test/objects.inventory.de.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(OBJECTS_SECOND_LANGUAGE, `${JSON.stringify(objects, null, 2)}\n`);
      });
    });

    // Round 87 (krobi 2026-10-02 23:26): every counterpart gone — a power cut, every network path of the adapter
    // process fails — and back. The adapter shows it in OUTAGE_SHOWN and does nothing else: no object is deleted or
    // written, and the log stays quiet (krobi 2026-10-03: an outage is a state, for a device and a cloud alike).
    suite("counterpart gone and back", getHarness => {
      let harness;
      let watch;
      let restarts;
      let outage;
      before(async function () {
        this.timeout(3 * OUTAGE_DEADLINE_MS + 120000);
        harness = getHarness();
        clearInstanceData(harness);
        watch = await watchObjectWrites(harness);
        await resetInstanceNative(harness, await fixtureNative());
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        restarts = playControllerRestarts(harness, watch, NETWORK_HOOK);
        await harness.startAdapterAndWait(false, adapterEnv(NETWORK_HOOK));
        await feedFixtures(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
        outage = await playOutage(harness, watch);
      });
      // Mocha may give up on before() while playOutage still waits — the next suite must not start cut.
      after(() => fs.rmSync(OUTAGE_FLAG, { force: true }));

      it("cuts every network path of the adapter", function () {
        const markers = fs.readdirSync(RESOURCE_DIR).filter(f => f.endsWith(".outage"));
        assert.ok(
          markers.length > 0,
          "the outage switch never went on in an adapter process — a start without NETWORK_HOOK as its last hook",
        );
        const replaced = markers.flatMap(f => JSON.parse(fs.readFileSync(path.join(RESOURCE_DIR, f), "utf8")).replaced);
        assert.deepStrictEqual(
          replaced,
          [],
          `patches of the outage switch a later hook replaced:\n${replaced.join("\n")}`,
        );
      });

      // Round 104 (krobi 2026-10-06 17:55, F1/GV-04): an outage shows only on reachability — OUTAGE_SHOWN may name
      // no other state, or a value reset by the outage would hide behind it
      it("shows the outage only on states that tell reachability", async function () {
        const roles = [
          "indicator.connected",
          "indicator.reachable",
          "indicator.alive",
          "indicator.maintenance.unreach",
        ];
        const other = [];
        for (const id of Object.keys(OUTAGE_SHOWN)) {
          const obj = await harness.objects.getObjectAsync(`${NS}${id}`);
          const role = String(obj?.common?.role ?? "");
          if (
            !roles.some(r => role === r || role.startsWith(`${r}.`)) &&
            !/(online|connect|reach|alive)/i.test(id.split(".").at(-1))
          ) {
            other.push(`${id} (role ${role || "none"})`);
          }
        }
        assert.deepStrictEqual(
          other,
          [],
          `OUTAGE_SHOWN names states that do not tell reachability:\n${other.join("\n")}`,
        );
      });

      it("deletes no object while its counterpart is gone", function () {
        const lost = [...new Set(watch.deleted.slice(outage.deleted))];
        assert.deepStrictEqual(lost, [], `objects deleted during the outage or the return:\n${lost.join("\n")}`);
      });

      it("writes no object while its counterpart is gone", function () {
        const written = [...new Set(watch.times.filter(([, t]) => t >= outage.cut).map(([id]) => id))];
        assert.deepStrictEqual(written, [], `objects written during the outage or the return:\n${written.join("\n")}`);
      });

      // Round 96 (krobi 2026-10-06 17:55–17:56): while the counterpart is gone no value changes but the ones that
      // show the outage; at the return fresh values are fine, a value emptied or set back to its default is not.
      // A thing the source itself reports as removed (a delivered parcel, a system taken out of the server) is not
      // an outage — this suite never plays that.
      it("keeps every value while its counterpart is gone", function () {
        const shown = new Set(Object.keys(OUTAGE_SHOWN).map(id => `${NS}${id}`));
        const empty = new Set([null, canonical(null), canonical("")]);
        const reset = outage.writes
          .filter(([id, val]) => !shown.has(id) && val !== outage.values.get(id))
          .filter(([id, val, t]) => t < outage.back || empty.has(val) || val === outage.defs.get(id))
          .map(
            ([id, val]) => `${id} = ${val === null ? "(deleted)" : val}, before ${outage.values.get(id) ?? "(none)"}`,
          );
        assert.deepStrictEqual(
          [...new Set(reset)],
          [],
          `values changed during the outage or reset at the return:\n${[...new Set(reset)].join("\n")}`,
        );
      });

      it("logs nothing above debug while its counterpart is gone", function () {
        const loud = outage.lines
          .filter(l => !["debug", "silly"].includes(l.level))
          .map(l => `${l.level}: ${l.message}`);
        assert.deepStrictEqual(loud, [], `log lines above debug during the outage or the return:\n${loud.join("\n")}`);
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });
    });

    // Round 113 (the limits count each installation on its own, rule 9 of the tool: what was blocked stays blocked): the
    // instance restarts right after its first start, the data folder kept as a host keeps it. An adapter that fetches
    // everything again on every start calls its account twice within a minute — the limit test of the next suite judges
    // this installation with both processes. Placed before `one counterpart hangs`, whose limit test reads it.
    suite("a restart right after the start", getHarness => {
      let harness;
      let watch;
      let restarts;
      let pids;
      before(async function () {
        this.timeout(
          120000 + STOP_DEADLINE_MS + RESTART_DELAY_MS + START_DEADLINE_MS + RESTART_QUIET_DEADLINE_MS + 60000,
        );
        harness = getHarness();
        clearInstanceData(harness);
        countThisInstallation();
        watch = await watchObjectWrites(harness);
        await resetInstanceNative(harness, await fixtureNative());
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        const since = Date.now();
        restarts = playControllerRestarts(harness, watch, NETWORK_HOOK);
        await harness.startAdapterAndWait(false, adapterEnv(NETWORK_HOOK));
        await feedFixtures(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
        const again = Date.now();
        await restartAsTheHost(harness, watch, "right after the start", NETWORK_HOOK);
        await feedFixtures(harness);
        await waitForQuietCalls(again);
        pids = new Set(
          readCalls()
            .filter(c => c.t >= since)
            .map(c => c.pid),
        );
      });
      after(() => {
        counting = false;
      });

      it("comes up again in the same installation", function () {
        assert.ok(
          pids.size >= 2,
          `${pids.size} counted process(es) after the restart — the limit test would judge one start only`,
        );
      });
    });

    // Round 100 (krobi 2026-10-07 10:12/10:14): one counterpart hangs from the start — the adapter reaches every other one
    // before it gives up on the hung one, so one device never blocks another. Every call of this run and the one before
    // goes to a counterpart the adapter declares in src/lib/api-limits.json, and stays within every limit there.
    suite("one counterpart hangs", getHarness => {
      let harness;
      let watch;
      let restarts;
      let hang;
      before(async function () {
        this.timeout(HANG_DEADLINE_MS + STOP_DEADLINE_MS + RESTART_DELAY_MS + START_DEADLINE_MS + 120000);
        harness = getHarness();
        clearInstanceData(harness);
        countThisInstallation();
        watch = await watchObjectWrites(harness);
        await resetInstanceNative(harness, await fixtureNative());
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        restarts = playControllerRestarts(harness, watch, NETWORK_HOOK);
        hang = startHang();
        await harness.startAdapterAndWait(false, adapterEnv(NETWORK_HOOK));
        hang = await playHang(harness, hang, restarts);
      });
      after(() => {
        counting = false;
      });
      // Mocha may give up on before() while playHang still waits — the next suite must not start with a hung counterpart.
      after(() => fs.rmSync(HANG_FLAG, { force: true }));

      it("reaches every other counterpart before it gives up on a hung one", function () {
        // a host hangs as a whole, or one channel `<host> <port>` (round 104) — its idle line names the port then
        const hungIs = c =>
          hang.hung.includes(" ") ? `${c.host} ${c.port}` === hang.hung : c.host === hang.hung && c.port === undefined;
        assert.ok(
          hang.hung === null ||
            hang.calls.some(
              c => c.kind === "hang-start" && (c.host === hang.hung || `${c.host} ${c.port}` === hang.hung),
            ),
          `${hang.hung} never hung — a pooled connection or a hook below answered for it`,
        );
        const end = hang.calls.find(c => c.kind === "hang-idle" && hungIs(c))?.t ?? Infinity;
        // round 113 (govee inv4): a channel first reached in the starts before only after the moment this process
        // gave up on the hung one (counted from its first line) cannot show a wait — it is judged where it came earlier
        const gaveUp = end - (hang.calls[0]?.t ?? end);
        const judged = hang.others.filter(k => hang.usual[k] < gaveUp);
        if (hang.hung !== null && judged.length === 0) {
          console.log(
            `      no other counterpart came before ${hang.hung} was given up in the starts before — this run measured nothing`,
          );
        }
        const late = judged.filter(
          k => !(hang.calls.find(c => !c.kind.startsWith("hang-") && channel(c) === k)?.t < end),
        );
        assert.deepStrictEqual(
          late,
          [],
          `reached only after the adapter gave up on the hung ${hang.hung}, or never:\n${late.join("\n")}`,
        );
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });

      it("calls only counterparts it declares", function () {
        const declared = apiLimits();
        const unknown = [
          ...new Set(
            readCalls()
              .filter(c => !c.kind.startsWith("hang-") && !declared.some(d => fits(c, d.match)))
              .map(c => `${c.kind} ${c.host}:${c.port}`),
          ),
        ];
        assert.deepStrictEqual(
          unknown,
          [],
          `calls to counterparts src/lib/api-limits.json does not declare:\n${unknown.join("\n")}`,
        );
      });

      it("stays within every limit it declares", function () {
        // round 113 (govee inv4): each installation counts on its own — a suite begins one in clearInstanceData; a
        // process belongs to the installation its first call falls in, with the restarts the host plays in it;
        // round 123: only the installations judgedCalls() keeps
        const calls = judgedCalls();
        const over = [];
        for (const d of apiLimits()) {
          for (const limit of d.limits) {
            const lanes = new Map();
            for (const c of calls.filter(c => fits(c, d.match))) {
              const lane = `${limit.per === "host" ? c.host : "account"}, installation ${c.install}`;
              lanes.set(lane, [...(lanes.get(lane) ?? []), c.t]);
            }
            for (const [lane, times] of lanes) {
              for (let i = 0, j = 0; j < times.length; j++) {
                while (times[j] - times[i] >= limit.seconds * 1000) {
                  i++;
                }
                if (j - i + 1 > limit.max) {
                  over.push(
                    `${d.name} (${lane}): ${j - i + 1} calls within ${limit.seconds} s, at most ${limit.max} (${limit.source})`,
                  );
                  break;
                }
              }
            }
          }
        }
        assert.deepStrictEqual(over, [], `calls above a declared limit:\n${over.join("\n")}`);
      });

      // Round 123 (homeconnect 2026-10-15): a smaller account for the counted starts proves the limit only when it
      // pressed it
      it("puts its limiter under pressure when the counted starts get a smaller account", function () {
        if (!LIMIT_ACCOUNT) {
          return;
        }
        const slack = limitSlack(judgedCalls(), apiLimits());
        assert.deepStrictEqual(
          slack,
          [],
          `the smaller account never put the limiter under pressure:\n${slack.join("\n")}`,
        );
      });
    });

    // Round 107 (W100-5): the same rule while the adapter already runs — a device that answered and then stops answering
    // never delays the others. A queue every device shares after its first contact is red here; the suite above, where
    // the device hangs from the start, cannot see it (measured round 100 on a yamaha copy).
    suite("one counterpart hangs mid-run", getHarness => {
      let harness;
      let watch;
      let restarts;
      let hang;
      before(async function () {
        this.timeout(
          HANG_WARMUP_MS + HANG_DEADLINE_MS + STOP_DEADLINE_MS + RESTART_DELAY_MS + START_DEADLINE_MS + 120000,
        );
        harness = getHarness();
        clearInstanceData(harness);
        countThisInstallation();
        watch = await watchObjectWrites(harness);
        await resetInstanceNative(harness, await fixtureNative());
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        restarts = playControllerRestarts(harness, watch, NETWORK_HOOK);
        await harness.startAdapterAndWait(false, adapterEnv(NETWORK_HOOK));
        hang = await playHangMidRun(harness, restarts);
      });
      after(() => {
        counting = false;
      });
      // Mocha may give up on before() while playHangMidRun still waits — the next suite must not start with a hung counterpart.
      after(() => fs.rmSync(HANG_FLAG, { force: true }));

      it("keeps every other counterpart in its rhythm while one hangs mid-run", function () {
        if (hang.hung === null) {
          return;
        }
        const starts = c => c.kind === "hang-start" && (c.host === hang.hung || `${c.host} ${c.port}` === hang.hung);
        assert.ok(
          hang.calls.some(starts),
          `${hang.hung} never hung — a pooled connection or a hook below answered for it`,
        );
        // each attempt the adapter keeps open at the hung counterpart, from its hang-start to its own hang-end (a
        // request it gives up after its timeout is one wait, a connection that went silent another); one still
        // open ends at the deadline
        const waits = [];
        const open = new Map();
        for (const c of hang.calls) {
          const key = `${c.host} ${c.port}`;
          if (starts(c)) {
            open.set(key, [...(open.get(key) ?? []), c.t]);
          } else if (c.kind === "hang-end" && open.get(key)?.length) {
            waits.push([open.get(key).shift(), c.t]);
          }
        }
        for (const left of open.values()) {
          waits.push(...left.map(s => [s, hang.end]));
        }
        // a channel is judged by the rhythm it showed itself: its largest gap between calls before the wait (fewer
        // than two calls, or quiet for longer than that gap already, shows none) — it was due during the wait when
        // its last call plus that gap fell inside it, and then its next call must come inside it too
        const judged = [];
        const late = [];
        for (const k of hang.others) {
          const times = hang.calls.filter(c => !c.kind.startsWith("hang-") && channel(c) === k).map(c => c.t);
          for (const [s, e] of waits) {
            const before = times.filter(t => t < s);
            if (before.length < 2) {
              continue;
            }
            const gap = Math.max(...before.slice(1).map((t, i) => t - before[i]));
            const last = before[before.length - 1];
            if (s - last > gap || last + gap >= e) {
              continue;
            }
            judged.push(k);
            if (!(times.find(t => t >= s) < e)) {
              late.push(`${k}: due ${last + gap - s} ms into a wait of ${e - s} ms, reached only after it`);
              break;
            }
          }
        }
        if (judged.length === 0) {
          console.log(`      no other counterpart was due while ${hang.hung} hung — this run measured nothing`);
        }
        assert.deepStrictEqual(late, [], `waited for the hung ${hang.hung}:\n${late.join("\n")}`);
      });
    });

    // Round 104 (krobi 2026-10-03 12:01, GV-28 for every listener: an adapter that cannot communicate has a fatal
    // error): another program holds the adapter's own port before it starts. With no other path —
    // nothing answers, no other declared port is open — the adapter stops with an error; with one it runs on.
    if (listenPortPlan().taken.length > 0) {
      suite("a taken port", getHarness => {
        let harness;
        let held = [];
        let verdict;
        before(async function () {
          this.timeout(TAKEN_WINDOW_MS + 120000);
          harness = getHarness();
          clearInstanceData(harness);
          await resetInstanceNative(harness, await fixtureNative());
          const plan = listenPortPlan();
          held = await takePorts(plan.taken, plan.address);
          const seen = networkFiles();
          const since = Date.now();
          await harness.startAdapter(adapterEnv(NETWORK_HOOK));
          const fed = feedFixtures(harness).then(
            () => undefined,
            err => err,
          );
          while (!harness.didAdapterStop() && Date.now() < since + TAKEN_WINDOW_MS) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          await Promise.race([fed, new Promise(resolve => setTimeout(resolve, 1000))]);
          const taken = new Set(plan.taken.map(p => p.port));
          const via = answers => [
            ...new Set(answers.filter(a => !taken.has(a.local)).map(a => `${a.kind} ${a.host}:${a.port} answers`)),
          ];
          const open = networkUse(seen)
            .filter(r => (r.kind === "listen" || r.kind === "bind") && plan.others.includes(r.port))
            .map(r => `listens on ${r.port}`);
          // the suites before this one ran with the port free: what answered there on another port is a path too —
          // an adapter that stops at once never gets to show it here
          verdict = {
            plan,
            stopped: harness.didAdapterStop(),
            exit: harness.adapterExit,
            paths: [...open, ...via(readAnswers(since))],
            before: via(readAnswers(0, since)),
            errors: harness.getLogs().filter(l => l.level === "error" && l.from === `${ADAPTER}.0`),
          };
        });
        after(() => Promise.all(held.map(h => new Promise(resolve => h.close(() => resolve())))));

        it("stops with an error when it can talk to nothing, and runs on when it can", function () {
          const ports = verdict.plan.taken.map(p => `${p.protocol} ${p.port}`).join(", ");
          if (verdict.stopped) {
            assert.notStrictEqual(
              verdict.exit,
              0,
              `stopped with exit code 0 while ${ports} was taken — a port it cannot do without is a fatal error`,
            );
            assert.ok(
              verdict.errors.length > 0,
              `stopped while ${ports} was taken without an error line — the user reads the log, not the exit code`,
            );
            assert.deepStrictEqual(
              [...verdict.paths, ...verdict.before],
              [],
              `stopped although it still had a path while ${ports} was taken`,
            );
          } else {
            assert.ok(
              verdict.paths.length > 0,
              `runs on ${TAKEN_WINDOW_MS} ms after a start with ${ports} taken, and nothing answered and no other port of it is open — it talks to nothing, that is a fatal error`,
            );
          }
        });
      });
    }

    // Round 101 (krobi 2026-10-07 15:54, GV-13 as the fleet rule): no counterpart answers, every writable state gets
    // one command — a command that reached a counterpart stays unconfirmed (`ack: false`), and where the adapter has
    // writable states at least one command reaches a counterpart (otherwise the suite judged nothing).
    suite("a command nobody answers stays unconfirmed", getHarness => {
      let harness;
      let watch;
      let restarts;
      let command;
      before(async function () {
        this.timeout(
          COMMAND_WINDOW_MS + OUTAGE_DEADLINE_MS + STOP_DEADLINE_MS + RESTART_DELAY_MS + START_DEADLINE_MS + 120000,
        );
        harness = getHarness();
        clearInstanceData(harness);
        watch = await watchObjectWrites(harness);
        await resetInstanceNative(harness, await fixtureNative());
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        restarts = playControllerRestarts(harness, watch, NETWORK_HOOK);
        await harness.startAdapterAndWait(false, adapterEnv(NETWORK_HOOK));
        await feedFixtures(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
        command = await playCommands(harness);
      });
      // Mocha may give up on before() while playCommands still waits — the next suite must not start silenced.
      after(() => fs.rmSync(HANG_FLAG, { force: true }));

      it("confirms no command no counterpart answered", function () {
        // round 104: every writable state is judged, not only the ones whose call carried the command as its cause
        // (a queue started before the command loses it — yamaha 11 of 436); nothing answers, so no `ack: true` but
        // for a state LOCAL_STATES names as the adapter's own setting, and (round 107) for a state SEND_CONFIRMED
        // grants whose command went out without waiting for an answer; (round 134) a write that offers no other
        // entry of its list and reached no counterpart is no command
        const local = new Set(LOCAL_STATES.map(id => `${NS}${id}`));
        const idle = w => w.sole && !command.calls.some(c => c.cause === w.id);
        const confirmed = command.writes
          .filter(w => !idle(w) && !local.has(w.id) && !sentWithoutAnswer(command, w.id))
          .filter(w => command.acks.some(([id, ts]) => id === w.id && ts >= w.t))
          .map(w => `${w.id} = ${JSON.stringify(w.val)}`);
        assert.deepStrictEqual(
          confirmed,
          [],
          `acknowledged although no counterpart answered:\n${confirmed.join("\n")}`,
        );
      });

      it("reaches a counterpart with its commands", function () {
        assert.ok(
          command.writes.length === 0 || command.calls.length > 0,
          `none of ${command.writes.length} commands reached a counterpart in its own context — a queue that started before the command, or no device command at all: the suite judged nothing`,
        );
      });

      // Round 107 (K18, govee): a limit is proven only where the run reaches its counterpart — every counterpart
      // src/lib/api-limits.json declares is called at least once in this run (every suite so far, the commands of this
      // one last); one that only credentials or a protocol the fixtures lack would reach needs its fixture
      it("reaches every counterpart it declares", function () {
        const calls = readCalls().filter(c => !c.kind.startsWith("hang-"));
        const unreached = apiLimits()
          .filter(d => !calls.some(c => fits(c, d.match)))
          .map(d => d.name);
        assert.deepStrictEqual(
          unreached,
          [],
          `counterparts src/lib/api-limits.json declares that the run never reached — their limits are unproven:\n${unreached.join("\n")}`,
        );
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });
    });

    // Round 87 (krobi 2026-10-03 00:04): a device, account or entry named `info` never takes the place of the adapter's
    // own `info` channel — `info` and everything below it stay exactly what a fresh installation has.
    suite("a name that is the adapter's own", getHarness => {
      let harness;
      let watch;
      let restarts;
      let live;
      before(async function () {
        this.timeout(180000);
        harness = getHarness();
        clearInstanceData(harness);
        watch = await watchObjectWrites(harness);
        await resetInstanceNative(harness, await fixtureNative());
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        restarts = playControllerRestarts(harness, watch);
        await harness.startAdapterAndWait(false, adapterEnv());
        await feedFixtures(harness);
        await feedReservedNames(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
        live = await dumpObjects(harness);
      });

      it("keeps its own info channel", function () {
        const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
        const own = id => id === `${NS}info` || id.startsWith(`${NS}info.`);
        const ids = [...new Set([...Object.keys(current), ...Object.keys(live)])].filter(own);
        const taken = ids.filter(id => canonical(live[id] ?? null) !== canonical(current[id] ?? null));
        const gone = [...new Set(watch.deleted)].filter(own);
        assert.deepStrictEqual(
          [...taken, ...gone],
          [],
          `objects below info that differ from a fresh installation or were deleted:\n${[...taken, ...gone].join("\n")}`,
        );
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });
    });

    // Round 87 (krobi 2026-10-03 00:27/00:28, 11:38): with an address chosen, the adapter listens, sends and connects
    // there and nowhere else — the cloud included — and a client from another network gets no answer.
    if (ADDRESS_KEY) {
      suite("chosen network address", getHarness => {
        let harness;
        let restarts;
        let use;
        let strangers;
        before(async function () {
          this.timeout(180000);
          assert.ok(CHOSEN_ADDRESS, "this machine carries no non-internal IPv4 address to choose");
          harness = getHarness();
          clearInstanceData(harness);
          const seen = networkFiles();
          await resetInstanceNative(harness, await fixtureNative({ [ADDRESS_KEY]: CHOSEN_ADDRESS }));
          restarts = playControllerRestarts(harness, null, NETWORK_HOOK);
          await harness.startAdapterAndWait(false, adapterEnv(NETWORK_HOOK));
          await feedFixtures(harness);
          await restarts.done;
          await waitForAdapterWork(harness);
          use = networkUse(seen);
          strangers = await askFromAnotherNetwork(use, CHOSEN_ADDRESS);
        });

        it("uses only the chosen address", function () {
          assert.ok(
            use.length > 0,
            "the network hook recorded nothing — a start without NETWORK_HOOK as its last hook",
          );
          const wrong = offTheAddress(use, CHOSEN_ADDRESS);
          assert.deepStrictEqual(wrong, [], `network use off ${CHOSEN_ADDRESS}:\n${wrong.join("\n")}`);
        });

        it("answers no client from another network", function () {
          assert.deepStrictEqual(strangers, [], `answers to another network:\n${strangers.join("\n")}`);
        });

        it("restarts at most once for its own instance object", function () {
          assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
        });
      });

      // Round 87 (krobi 2026-10-02 23:52, F-06 of fakeroku as the fleet rule): an address the host does not carry —
      // the adapter falls back to every address, keeps working, and says so in exactly one warning.
      suite("missing network address", getHarness => {
        let harness;
        let restarts;
        let lines;
        before(async function () {
          this.timeout(180000);
          harness = getHarness();
          clearInstanceData(harness);
          await resetInstanceNative(harness, await fixtureNative({ [ADDRESS_KEY]: MISSING_ADDRESS }));
          restarts = playControllerRestarts(harness, null, NETWORK_HOOK);
          await harness.startAdapterAndWait(false, adapterEnv(NETWORK_HOOK));
          // The fixtures reach the adapter on every address — that it keeps working. No waitForAdapterWork: a
          // missing address may keep the adapter's state short of green (fakeroku F-06: yellow until changed).
          await feedFixtures(harness);
          await restarts.done;
          lines = harness.getLogs().filter(l => l.from === `${ADAPTER}.0` && l.message.includes(MISSING_ADDRESS));
        });

        it("falls back to every address and warns once", function () {
          const said = lines
            .filter(l => l.level === "warn" || l.level === "error")
            .map(l => `${l.level}: ${l.message}`);
          assert.deepStrictEqual(
            said.length === 1 && said[0].startsWith("warn: "),
            true,
            `lines naming ${MISSING_ADDRESS}:\n${said.join("\n")}`,
          );
        });

        it("restarts at most once for its own instance object", function () {
          assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
        });
      });
    }

    // Round 97 (krobi 2026-10-06 19:07–19:14): the diagnostics report of every device, asked for like the admin card,
    // with every counterpart there and with every counterpart gone. A report adds no datapoint ("db-10 NIEMALS!"),
    // writes no value and no file (DB-01) — and an unconnected device is listed as such and not read live (DB-03).
    if (DIAGNOSTICS_REPORT) {
      suite("diagnostics report", getHarness => {
        let harness;
        let watch;
        let restarts;
        let reports;
        before(async function () {
          this.timeout(3 * OUTAGE_DEADLINE_MS + 120000);
          harness = getHarness();
          clearInstanceData(harness);
          watch = await watchObjectWrites(harness);
          await resetInstanceNative(harness, await fixtureNative());
          await setSystemLanguage(harness, FIRST_LANGUAGE);
          restarts = playControllerRestarts(harness, watch, NETWORK_HOOK);
          await harness.startAdapterAndWait(false, adapterEnv(NETWORK_HOOK));
          await feedFixtures(harness);
          await restarts.done;
          await waitForAdapterWork(harness);
          reports = await playReports(harness, watch);
        });
        // Mocha may give up on before() while playReports still waits — the next suite must not start cut.
        after(() => fs.rmSync(OUTAGE_FLAG, { force: true }));

        it("hands over a report for every device", function () {
          assert.ok(reports.devices.length > 0, "the adapter lists no device — feedFixtures gives it none");
          const quote = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const version = quote(require(path.join(ADAPTER_DIR, "io-package.json")).common.version);
          // DB-12 (krobi 2026-10-06 19:07, one file name for every adapter): the device part is the device id the card
          // lists — or, where the id falls back to a name, an address or a whole serial, the placeholder the content uses
          // for it (DB-04, round 105: the file goes out as the attachment of a public issue)
          const named = new RegExp(`^${ADAPTER}_([A-Za-z0-9_-]+)_v${version}_\\d{4}-\\d{2}-\\d{2}_\\d{6}\\.json$`);
          const ownName = (device, answer) => {
            const part = named.exec(answer?.fileName ?? "")?.[1];
            if (part === undefined) {
              return false;
            }
            // a placeholder has the core's form `<kind>-<n>` (placeholders.ts) and stands in the content too; the id
            // may keep its own parts around it (a second device of a model: `wx-010-serial-1`, measured by yamaha)
            const own = device.replace(/[^a-z0-9-]+/gi, "_");
            const placed = (part.match(/[a-z]+-\d+/g) ?? []).filter(t => !own.includes(t));
            const rest = placed.reduce((text, t) => text.replace(t, ""), part);
            return (
              part === own ||
              (placed.length > 0 && placed.every(t => (answer?.content ?? "").includes(t)) && own.includes(rest))
            );
          };
          const wrong = [...reports.reports, ...reports.silent, ...reports.offline]
            .filter(
              ({ device, answer }) =>
                !ownName(device, answer) || JSON.parse(answer.content).adapter !== `iobroker.${ADAPTER}`,
            )
            .map(({ device, answer }) => `${device}: ${JSON.stringify(answer).slice(0, 300)}`);
          assert.deepStrictEqual(
            wrong,
            [],
            `no report, or not named <adapter>_<device-id>_v<version>_<date>_<time>.json:\n${wrong.join("\n")}`,
          );
        });

        it("reads every connected device live and makes no answer up", function () {
          // DB-02 (krobi 2026-10-05 22:47 for yamaha, 2026-10-06 13:40 for govee): a connected device is read live
          const unread = reports.reports
            .filter(({ device }) => reports.devices.find(d => d.value === device)?.connected)
            .filter(({ answer }) => JSON.parse(answer?.content ?? "{}").liveRead !== "read")
            .map(({ device, answer }) => `${device}: ${JSON.parse(answer?.content ?? "{}").liveRead}`);
          assert.deepStrictEqual(unread, [], `connected devices the report did not read live:\n${unread.join("\n")}`);
          assert.ok(reports.silent.length > 0, "no connected device — the live read was never played");
          const madeUp = reports.silent
            .filter(({ answer }) => JSON.parse(answer?.content ?? "{}").liveRead === "read")
            .map(({ device }) => device);
          assert.deepStrictEqual(
            madeUp,
            [],
            `reports that say the device was read while no counterpart answered:\n${madeUp.join("\n")}`,
          );
        });

        it("lists an unconnected device as such and does not read it live", function () {
          const listed = reports.offlineDevices.filter(d => d.connected !== false).map(d => d.value);
          assert.deepStrictEqual(
            listed,
            [],
            `listed as connected while every counterpart is gone:\n${listed.join("\n")}`,
          );
          const read = reports.offline
            .filter(({ answer }) => JSON.parse(answer?.content ?? "{}").connected !== false)
            .map(({ device }) => device);
          assert.deepStrictEqual(read, [], `reports that do not say the device was not connected:\n${read.join("\n")}`);
          // DB-03 (krobi 2026-10-06 13:02: every device is listed and reported, online and offline): every device stays listed
          const listedThen = reports.devices.map(d => d.value).sort();
          const listedNow = reports.offlineDevices.map(d => d.value).sort();
          assert.deepStrictEqual(
            listedNow,
            listedThen,
            "the card does not list every device while every counterpart is gone",
          );
        });

        it("adds no datapoint and writes no value for a report", function () {
          const written = [
            ...new Set(watch.times.filter(([, t]) => t >= reports.start && t <= reports.end).map(([id]) => id)),
          ];
          const added = reports.keysAfter.filter(id => !reports.keys.has(id));
          const lost = [...new Set(watch.deleted.slice(reports.deleted))];
          const shown = new Set(Object.keys(OUTAGE_SHOWN).map(id => `${NS}${id}`));
          const values = [...new Set(reports.writes.filter(id => !shown.has(id)))];
          // DB-02, the read changes nothing in the adapter: a value the live read changes while the counterparts answer as before
          const same = id =>
            JSON.stringify(reports.values[id]?.val) === JSON.stringify(reports.valuesAfterOnline[id]?.val);
          const changed = [...new Set(reports.onlineWrites)].filter(id => !same(id));
          const all = [
            ...written.map(id => `object ${id}`),
            ...added.map(id => `state ${id}`),
            ...lost.map(id => `deleted ${id}`),
            ...values.map(id => `value ${id}`),
            ...changed.map(id => `changed ${id}`),
          ];
          assert.deepStrictEqual(all, [], `the reports added, wrote or deleted:\n${all.join("\n")}`);
        });

        it("writes no file for a report", function () {
          const files = [...new Set([...Object.keys(reports.files), ...Object.keys(reports.filesAfter)])];
          const changed = files.filter(f => reports.files[f] !== reports.filesAfter[f]);
          // round 104: anywhere — the network hook notes every file the adapter process writes (os.tmpdir too)
          const anywhere = [
            ...new Set(
              fileWrites()
                .filter(w => w.t >= reports.start && w.t <= reports.end)
                .map(w => w.path),
            ),
          ];
          const all = [...changed, ...anywhere.filter(f => !changed.includes(f))];
          assert.deepStrictEqual(all, [], `files the reports wrote, changed or removed:\n${all.join("\n")}`);
        });

        it("shows no address, hardware id or mail address in plain text", function () {
          const forms = [
            /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w.])/,
            /(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}(?![0-9A-Fa-f:-])/,
            /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/,
          ];
          // round 104: IPv6 too — two colons in a row or at least four groups, one group with two hex digits
          // (measured on 24 reports of the yamaha copy: no time, date or id matched)
          const v6 = text =>
            (text.match(/(?<![\w:.])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?![\w:.])/g) ?? []).filter(
              m => (m.includes("::") || m.split(":").length >= 4) && /[0-9A-Fa-f]{2}/.test(m),
            );
          // round 105: the file name too — its device part is never pseudonymised by anyone but the adapter
          const part = answer => (answer?.fileName ?? "").replace(/_v[^_]*_\d{4}-\d{2}-\d{2}_\d{6}\.json$/, "");
          const dashed =
            /(?<!\d)(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)[._-]){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d)/;
          const plain = [...reports.reports, ...reports.silent, ...reports.offline].flatMap(({ device, answer }) => [
            ...forms.filter(f => f.test(answer?.content ?? "")).map(f => `${device}: ${f}`),
            ...v6(answer?.content ?? "").map(m => `${device}: ${m}`),
            ...(dashed.test(part(answer)) ? [`${device}: file name ${answer.fileName}`] : []),
          ]);
          assert.deepStrictEqual(
            plain,
            [],
            `reports that show an address, a hardware id or a mail address in plain text (DB-04):\n${plain.join("\n")}`,
          );
        });

        it("shows no name, account or key of the user in plain text", function () {
          assert.ok(
            REPORT_PERSONAL.length > 0,
            "REPORT_PERSONAL names no value — list the fixtures' names, accounts, tokens and serials a user owns (DB-04, DB-05)",
          );
          // round 105: the file name too, in the spelling a file name takes (Küche → kueche, k_che)
          const slug = v =>
            v
              .toLowerCase()
              .replace(/ä/g, "ae")
              .replace(/ö/g, "oe")
              .replace(/ü/g, "ue")
              .replace(/ß/g, "ss")
              .normalize("NFKD")
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "");
          const loose = v =>
            v
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "");
          const part = answer =>
            slug(
              (answer?.fileName ?? "").replace(`${ADAPTER}_`, "").replace(/_v[^_]*_\d{4}-\d{2}-\d{2}_\d{6}\.json$/, ""),
            );
          const inName = (answer, v) => [slug(v), loose(v)].some(s => s !== "" && part(answer).includes(s));
          const plain = [...reports.reports, ...reports.silent, ...reports.offline].flatMap(({ device, answer }) =>
            REPORT_PERSONAL.filter(v => (answer?.content ?? "").includes(v) || inName(answer, v)).map(
              v => `${device}: ${v}`,
            ),
          );
          assert.deepStrictEqual(
            plain,
            [],
            `reports that show the user's own values in plain text (DB-04, DB-05):\n${plain.join("\n")}`,
          );
        });

        it("carries the object tree, the environment and log lines in every report", function () {
          // DB-03 (krobi 2026-10-06 13:03): a report holds the object tree, the environment and log lines, also for
          // a device that is not connected; the master's ReportContent names them the same in every adapter (round 129)
          const filled = v =>
            Array.isArray(v) ? v.length > 0 : v !== null && typeof v === "object" && Object.keys(v).length > 0;
          const missing = [...reports.reports, ...reports.silent, ...reports.offline].flatMap(({ device, answer }) => {
            const report = JSON.parse(answer?.content ?? "{}");
            return ["environment", "objectTree", "logs"]
              .filter(part => !filled(report[part]))
              .map(part => `${device}: ${part}`);
          });
          assert.deepStrictEqual(
            missing,
            [],
            `reports without their object tree, environment or log lines (DB-03):\n${missing.join("\n")}`,
          );
        });

        it("holds every block once", function () {
          // krobi 2026-10-20 00:46 for every adapter with a report, no content twice (DB-14): a block the file holds
          // twice stands at its second place as a pointer to the first — the master's onceEach writes it
          const twice = [...reports.reports, ...reports.silent, ...reports.offline].flatMap(({ device, answer }) => {
            const seen = new Map();
            const found = [];
            const walk = (node, pointer) => {
              if (node === null || typeof node !== "object") {
                return;
              }
              // a pointer onceEach wrote is no block: a block the file repeats twice leaves two equal pointers
              // to its first place (round 132, govee 2026-10-20)
              const keys = Object.keys(node);
              if (keys.length === 1 && keys[0] === "sameAs" && typeof node.sameAs === "string") {
                return;
              }
              const text = JSON.stringify(node);
              const first = seen.get(text);
              if (first !== undefined && JSON.stringify({ sameAs: first }).length < text.length) {
                found.push(`${device}: ${pointer} repeats ${first}`);
                return;
              }
              if (first === undefined) {
                seen.set(text, pointer);
              }
              Object.entries(node).forEach(([key, item]) =>
                walk(item, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`),
              );
            };
            walk(JSON.parse(answer?.content ?? "{}"), "");
            return found;
          });
          assert.deepStrictEqual(twice, [], `blocks a report holds twice (DB-14):\n${twice.join("\n")}`);
        });

        it("carries no fixed text", function () {
          // krobi 2026-10-20 00:29 "no dummy text", 00:46 for the fleet (DB-14): a sentence of four words or more that
          // stands the same in the report of every device and holds a text of the adapter's own source says nothing
          // about one device. A counterpart's answer or error text is no text of the source, so an account-wide block
          // the same for every device stays out; so do the frame, the environment, the object tree and every log line
          // (two real govee reports of 2026-10-18: exactly the five fixed sentences, no other hit)
          const RECORDS = [
            "readMe",
            "adapter",
            "version",
            "exportedAt",
            "runtime",
            "connected",
            "liveRead",
            "environment",
            "objectTree",
            "logs",
          ];
          const words = text => text.trim().split(/\s+/).length;
          const own = [];
          const read = dir => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const file = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                read(file);
              } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
                for (const m of fs
                  .readFileSync(file, "utf8")
                  .matchAll(
                    /\x22((?:\\.|[^\x22\\\n])*)\x22|\x27((?:\\.|[^\x27\\\n])*)\x27|\x60((?:\\.|[^\x60\\])*)\x60/g,
                  )) {
                  own.push(
                    ...(m[1] ?? m[2] ?? m[3])
                      .split(/\$\x7b[^\x7d]*\x7d/)
                      .map(part => part.replace(/\\(.)/g, "$1").trim())
                      .filter(part => words(part) >= 4),
                  );
                }
              }
            }
          };
          read(path.join(ADAPTER_DIR, "src"));
          const sentences = answer => {
            const found = new Set();
            const walk = node => {
              if (typeof node === "string") {
                if (words(node) >= 4 && own.some(text => node.includes(text))) {
                  found.add(node);
                }
              } else if (node !== null && typeof node === "object" && !["ts", "level", "msg"].every(k => k in node)) {
                Object.values(node).forEach(walk);
              }
            };
            Object.entries(JSON.parse(answer?.content ?? "{}"))
              .filter(([key]) => !RECORDS.includes(key))
              .forEach(([, part]) => walk(part));
            return found;
          };
          const fixed = [reports.reports, reports.offline]
            .filter(group => new Set(group.map(({ device }) => device)).size > 1)
            .flatMap(group => {
              const each = group.map(({ answer }) => sentences(answer));
              return [...each[0]].filter(s => each.every(set => set.has(s)));
            });
          assert.deepStrictEqual(
            [...new Set(fixed)],
            [],
            `sentences of the adapter's own source that stand the same in the report of every device (DB-14):\n${[...new Set(fixed)].join("\n")}`,
          );
        });

        it("restarts at most once for its own instance object", function () {
          assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
        });
      });
    }

    const previousFile = process.env.INVENTORY_PREVIOUS;
    if (previousFile && fs.existsSync(previousFile)) {
      suite("upgrade from the previous release", getHarness => {
        let harness;
        let watch;
        let restarts;
        let verdictAt;
        let maskedLeft;
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(120000);
          harness = getHarness();
          clearInstanceData(harness);
          watch = await watchObjectWrites(harness);
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          await seedPrevious(harness, previous);
          await seedInstanceData(harness, previous);
          await restoreMaskedSecrets(harness);
          maskedLeft = await maskedSecretsLeft(harness);
          await resetInstanceNative(harness, await fixtureNative());
          // The inventory was written in FIRST_LANGUAGE: labels an adapter localises itself (`states`)
          // only compare in the same language.
          await setSystemLanguage(harness, FIRST_LANGUAGE);
          restarts = playControllerRestarts(harness, watch);
          await harness.startAdapterAndWait(false, adapterEnv());
          await feedFixtures(harness);
          // On the seeded set feedFixtures may return at once, or wait for a state this run writes
          // itself; waitForAdapterWork adds the adapter's last start step either way.
          await waitForAdapterWork(harness);
          // A migration that wrote the instance object restarts the instance (round 64) — the verdict
          // comes after the second start has done its work.
          await restarts.done;
          await waitForAdapterWork(harness);
          verdictAt = Date.now();
          fs.writeFileSync(
            path.join(RESOURCE_DIR, "window.json"),
            JSON.stringify({ start: verdictAt, end: verdictAt + SETTLE_MS }),
          );
        });

        it("every current object carries the current texts and roles", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const stale = [];
          for (const [id, obj] of Object.entries(current)) {
            const got = live[id];
            if (!got) {
              stale.push(`${id}: missing after upgrade`);
              continue;
            }
            // Every field of `common`, not a chosen few: an adapter writes only what differs (round 61),
            // so every changed field must reach an existing installation.
            for (const f of new Set([...Object.keys(obj.common ?? {}), ...Object.keys(got.common ?? {})])) {
              if (f === "custom") {
                continue; // the user's recording — judged on its own below (round 64)
              }
              if (canonical(got.common?.[f]) !== canonical(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
            // The KIND of the object (state/channel/device/folder/meta) lives one level
            // ABOVE `common`; `common.type` is the VALUE type (string/number/
            // boolean) — something entirely different that merely shares the name. Without
            // this comparison a type migration that never reaches an existing installation
            // stays green: every text matches while every datapoint under the wrongly
            // declared container is a repochecker E2001 (hueemu v1.17.0, `clients` from
            // `meta` to `folder` — found on the live tree, by no gate).
            if (got.type !== obj.type) {
              stale.push(`${id}: type still ${JSON.stringify(got.type)}, want ${JSON.stringify(obj.type)}`);
            }
          }
          assert.deepStrictEqual(stale, [], "objects an update did not reach:\n" + stale.join("\n"));
        });

        it("objects the release removed are gone (no leftovers)", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
          assert.deepStrictEqual(leftovers, [], "leftover objects:\n" + leftovers.join("\n"));
        });

        it("rewrites no object unchanged", function () {
          const idle = [...new Set(watch.unchanged)];
          assert.deepStrictEqual(idle, [], `objects written without a change:\n${idle.join("\n")}`);
        });

        it("rewrites no state unchanged", function () {
          const idle = [...new Set(watch.unchangedStates)];
          assert.deepStrictEqual(idle, [], `states written without a change:\n${idle.join("\n")}`);
        });

        // A kept object that is deleted and created anew makes the suite judge a fresh object, not the
        // upgraded one (hassemu v1.43.1: the stale cleanup removed 18 seeded clients before the dump).
        it("deletes no object the release keeps", function () {
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const lost = [...new Set(watch.deleted)].filter(id => id in previous && id in current);
          assert.deepStrictEqual(lost, [], `kept objects deleted during the upgrade:\n${lost.join("\n")}`);
        });

        it("starts on no masked secret from the previous dump", function () {
          assert.deepStrictEqual(
            maskedLeft,
            [],
            `seeded objects still carry ${ENCRYPTED_MARKER}:\n${maskedLeft.join("\n")}`,
          );
        });

        it("a recording goes on only with its own datapoint", async function () {
          this.timeout(30000);
          const live = await dumpObjects(harness);
          const carriers = new Map();
          for (const [id, obj] of Object.entries(live)) {
            const origin = obj.common?.custom?.[RECORDING]?.origin;
            if (origin) {
              carriers.set(origin, [...(carriers.get(origin) ?? []), id]);
            }
          }
          const wrong = [];
          for (const [origin, ids] of carriers) {
            if (ids.length > 1) {
              wrong.push(`${origin} → ${ids.join(", ")}: one recording on several datapoints`);
            } else if (ids[0] !== origin && live[origin]?.type === "state") {
              wrong.push(`${origin} → ${ids[0]}: copied while ${origin} lives on`);
            } else if (ids[0] !== origin && live[ids[0]].common?.type !== previous[origin]?.common?.type) {
              wrong.push(`${origin} → ${ids[0]}: another value type — a new datapoint, not the same one moved`);
            }
          }
          // A state that lives on keeps what hangs on it — the recording is the user's, never destroyed.
          for (const [id, obj] of Object.entries(previous)) {
            if (obj.type === "state" && live[id]?.type === "state" && !carriers.get(id)?.includes(id)) {
              wrong.push(`${id}: its recording is gone although the datapoint lives on`);
            }
          }
          // A state the release moves under a new id (MOVES) takes its recording along (krobi 2026-09-02).
          for (const [from, to] of Object.entries(MOVES)) {
            if (previous[from]?.type === "state" && !carriers.get(from)?.includes(to)) {
              wrong.push(`${from} → ${to}: its recording did not move with the datapoint`);
            }
          }
          assert.deepStrictEqual(wrong, [], `recordings that left their datapoint:\n${wrong.join("\n")}`);
        });

        // What a fresh installation does not have, an upgrade must not have either — whatever made it (round 64:
        // a datapoint created because the old one was recorded is exactly that).
        it("creates nothing a fresh installation lacks", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const extra = Object.keys(live).filter(id => !(id in current));
          assert.deepStrictEqual(extra, [], `objects a fresh installation does not have:\n${extra.join("\n")}`);
        });

        it("restarts at most once for its own instance object", function () {
          assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
        });

        // Last in the suite: a write after the verdict means waitForAdapterWork ended before the adapter did.
        it("writes nothing after the verdict", async function () {
          this.timeout(SETTLE_MS + 5000);
          await new Promise(resolve => setTimeout(resolve, Math.max(0, verdictAt + SETTLE_MS - Date.now())));
          const late = [...new Set(watch.times.filter(([, t]) => t > verdictAt).map(([id]) => id))];
          assert.deepStrictEqual(late, [], `objects written after the verdict:\n${late.join("\n")}`);
        });
      });
    }

    // Round 124 (plan P5): the fleet suites — one master for every adapter, called with this copy's own helpers.
    require("./fleet-suites.js")(suite, {
      ADAPTER_DIR,
      ADAPTER,
      NS,
      FIRST_LANGUAGE,
      SECOND_LANGUAGE,
      NETWORK_HOOK,
      OUTAGE_FLAG,
      RESOURCE_DIR,
      HANG_DEADLINE_MS,
      CHOSEN_ADDRESS,
      clearInstanceData,
      resetInstanceNative,
      fixtureNative,
      setSystemLanguage,
      playControllerRestarts,
      restartAsTheHost,
      adapterEnv,
      feedFixtures,
      waitForAdapterWork,
      dumpObjects,
      dumpStates,
      withinDeadline,
      readCalls,
    });
  },
});

// Round 62: after every suite, every adapter process of this run has exited — what it left open after onUnload fails
// the run. Every start leaves a marker: no marker means a start without adapterEnv(), a marker without a report a
// process that never reached its exit (killed after a hanging onUnload, or crashed).
after(function () {
  const files = fs.readdirSync(RESOURCE_DIR);
  const starts = files.filter(f => f.endsWith(".start")).map(f => f.slice(0, -".start".length));
  const silent = starts.filter(pid => !files.includes(`${pid}.json`));
  const reports = starts
    .filter(pid => !silent.includes(pid))
    .map(pid => JSON.parse(fs.readFileSync(path.join(RESOURCE_DIR, `${pid}.json`), "utf8")));
  const left = reports.flatMap(r => r.left);
  const reread = reports.flatMap(r =>
    Object.entries(r.quiet)
      .filter(([id]) => READ_ONLY.has(id))
      .map(([id, n]) => `${id} ×${n}`),
  );
  const single = reports.flatMap(r =>
    Object.entries(r.single)
      .filter(([id]) => READ_ONLY.has(id))
      .map(([id, n]) => `${id} ×${n}`),
  );
  // Round 113: every TCP connection and unicast datagram of the run ends on this machine (the probe sees where a fixture
  // hook sent it)
  const away = [
    ...new Set(
      files
        .filter(f => f.endsWith(".lands"))
        .flatMap(f => fs.readFileSync(path.join(RESOURCE_DIR, f), "utf8").split("\n").filter(Boolean))
        .map(l => JSON.parse(l))
        .map(c => `${c.kind} ${c.host}:${c.port}`),
    ),
  ];
  fs.rmSync(RESOURCE_DIR, { recursive: true, force: true });
  assert.ok(starts.length > 0, "no adapter start loaded the resource probe — a start without adapterEnv()");
  assert.deepStrictEqual(silent, [], "adapter processes that never reached their exit (killed or crashed)");
  assert.deepStrictEqual(left, [], `left open after onUnload:\n${left.join("\n")}`);
  assert.deepStrictEqual(
    reread,
    [],
    `read-only states read back from the database while nothing changed:\n${reread.join("\n")}`,
  );
  assert.deepStrictEqual(
    single,
    [],
    `read-only states read one by one from the database (one bulk getStatesAsync at the start, then compare in memory):\n${single.join("\n")}`,
  );
  assert.deepStrictEqual(
    away,
    [],
    `connections that left this machine — the run reached the real world (a route missing in FIXTURE_HOOKS, a device on the network):\n${away.join("\n")}`,
  );
});
