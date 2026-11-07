"use strict";
// Fleet master test/fleet-suites.js (round 124, krobi 2026-10-15 22:23) — byte-identical in every adapter, synced by the
// release mode like eslint.config.mjs; never edit the copy. test/inventory.js calls it once inside defineAdditionalTests:
//   require("./fleet-suites.js")(suite, { ADAPTER_DIR, ADAPTER, NS, ... });
// with the helpers of its own copy — this file copies none of them. What only the adapter knows (its connection test,
// its group switches in the admin, whether its fixture can reject a login or rename a device) stands in
// fleet.json `suites`; a missing declaration is a finding, `{ "none": "<reason>" }` a declared "no".
//
// Suites (plan specs/2026-10-15-runde-124-plan.html, P5):
//   "a quiet run and a clean stop"      D7 nothing above debug once the start is done · D10 an unknown message gets an
//                                       error · D9 a button falls back to false, confirmed — a press the adapter drops
//                                       itself stays unconfirmed (GV-13), proven by a press alone that reaches nothing ·
//                                       D4 the stop leaves every
//                                       marker offline, every reason text `Unknown`, the sums at 0/false
//   (in the same start)                D3 the connection test answers `result` while the counterpart is there and `error` while it
//                                       is cut — a test that answers from memory says `result` both times; a throttled
//                                       test declares its spacing (`spacingMs`), the suite waits it between the two
//   "answers in the system language"    D14 the same cut test in the second system language answers in other words
//   "a group switch reports its balance" D12 a group switch in the admin settings (krobi 2026-10-16: not a datapoint)
//                                       flipped: one balance line when datapoints came or went, none when nothing changed
//   "a renamed device keeps its name"   D22 the fixture renames a device between two starts; the name follows
//   "a rejected login shows no connection" D11 (krobi 2026-10-16 07:38: no connection, then offline) after a rejected
//                                       login info.connection is true only while data still arrives
//   "a counterpart that answers wrong or refuses" D6 a 500 and an empty 200 · C26b drifted JSON: the adapter runs on,
//                                       deletes no object and empties no value the clean start had (round 148) beyond
//                                       what the same restart with right answers empties (round 163),
//                                       each met by a restart (network hook,
//                                       section 7 `fault`: the first answer to each request wrong, the repeat right),
//                                       red as well when the wrong answers reached no request past the first one of a
//                                       clean start · D21 after a 429 with retry-after 60 no call to that host before
//                                       the minute is up · D21 under a series of errors (a 500 to every answer) the calls
//                                       to a host get fewer from minute to minute
//   "one device gone while the channel lives" D6 one device stays in the account's list and stops answering: only
//                                       that one goes unreachable (a marker already down before counts not; counted by
//                                       device, a device may carry several markers)
//   "every call to a hung counterpart ends" D21 a start with every counterpart hung, held until each call of its first
//                                       window ended or outlived the deadline: every call that hung — there and in the
//                                       hang suites of the template — ended within the deadline while its process lived
//   "every writable datapoint reaches the adapter" D10 (no start) every writable state of the inventory reached the
//                                       adapter's stateChange in this run (resource probe; the commands of the
//                                       template's suite "a command nobody answers stays unconfirmed")
//   "the whole run"                     (no start, round 157) D4 nothing is written after the unload callback in any stop
//                                       of the run (resource probe) · D17 no datagram to 255.255.255.255, and every own
//                                       address it names to others is the chosen one (network hook, section 8)
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");

// D7: how long the run stays watched after its start is done — several cycles of every fleet poll.
const QUIET_WINDOW_MS = 60000;
// D9: how long a pressed button may take to fall back.
const PRESS_WINDOW_MS = 15000;
// D9 (round 142, yamaha 2026-10-22): a button still unconfirmed after the window is pressed alone, one window at a time,
// up to PRESS_TRIES times. The window outlasts the longest path from a press to its first call measured (yamaha: 100 ms
// line spacing plus one queued line, 200 ms), the tries outlast the background calls of the fixtures (yamaha: about one
// every 3.5 s across eight devices — a 1 s window is quiet three times in four).
const PRESS_ALONE_MS = 1000;
const PRESS_TRIES = 8;
// D10/D3/D14: how long a message may take to be answered.
const ANSWER_MS = 30000;
const STOP_MS = 30000;
// D12 (krobi 2026-08-26): the one balance line of a group switch.
const BALANCE_RE = /Object tree updated: created \d+ datapoint\(s\), removed \d+ datapoint\(s\)/;
// D4: what a stopped adapter shows on each marker role.
const STOPPED = {
  "indicator.connected": false,
  "indicator.reachable": false,
  "indicator.alive": false,
  "indicator.maintenance.unreach": true,
};
const REASON_LEAF = /^(error|reason)$/i;
const SUM_ONLINE = /^info\.[a-z][A-Za-z0-9]*Online$/;
const SUM_ALL = /^info\.[a-z][A-Za-z0-9]*AllOnline$/;
// Switches the fixture hooks of an adapter honour (fleet.json suites.rename / rejectLogin).
const RENAME_SWITCH = "INVENTORY_RENAME";
const REJECT_LOGIN_SWITCH = "INVENTORY_REJECT_LOGIN";
const DROP_DEVICE_SWITCH = "INVENTORY_DROP_DEVICE";
const KEYS = ["connectionTest", "groupSwitches", "rename", "rejectLogin", "dropDevice"];
// D6 (one device gone): how long the suite holds the dropped device — several cycles of every fleet poll (round 157: the
// wrong answers hold by FAULT_IDLE_MS/FAULT_CAP_MS below, the comment named that suite).
const FAULT_HOLD_MS = 60000;
// D6/C26b (round 124, red-proof run 2026-10-16): a wrong answer lasts until every request of a clean start met one, or
// no new request met one for longer than a 60 s backoff, at most three minutes.
const FAULT_IDLE_MS = 70000;
const FAULT_CAP_MS = 180000;
const BACKOFF_WINDOW_MS = 120000;
const SETTLE_MS = 10000;
const START_MS = 60000;
// Round 157 (fleet-suite audit): the first start of a suite had no limit of its own — only the mocha timeout (up to 33 min
// in the wrong-answers suite) ended a start that hung, with a message that named nothing. Twice START_MS: a full first start
// measured about 30 s on the CI runner.
const FIRST_START_MS = 2 * START_MS;
// D21: how long the start with every counterpart hung outlives the deadline — the pulse of the network hook beats every 2 s
const HANG_SLACK_MS = 15000;
// D21: the retry-after the network hook sends with every 429 (section 7), and the slack around its first answer.
const RETRY_AFTER_MS = 60000;
const RETRY_GRACE_MS = 2000;
// D21 (plan line: "the calls per window decrease — backoff"): four windows of a minute under a 500 to every answer; the
// first holds the start, the second against the fourth is the verdict.
const ERROR_WINDOW_MS = 60000;
const ERROR_WINDOWS = 4;
const EMPTY = new Set([null, ""]);

/**
 * fleet.json `suites` of the adapter, every key checked for its form; a missing key throws in the suite that needs it.
 *
 * @param {string} adapterDir the adapter root
 */
function readDeclarations(adapterDir) {
  const file = path.join(adapterDir, "fleet.json");
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const suites = all.suites ?? {};
  return key => {
    assert.ok(KEYS.includes(key), `unknown suites key ${key}`);
    assert.ok(key in suites, `fleet.json suites.${key} is missing — declare it or give { "none": "<reason>" }`);
    const value = suites[key];
    if (value && typeof value === "object" && !Array.isArray(value) && "none" in value) {
      assert.ok(
        typeof value.none === "string" && value.none.trim().length >= 15,
        `fleet.json suites.${key}.none needs a reason of at least 15 characters`,
      );
      return null;
    }
    return value;
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Round 165 (krobi 2026-10-31 01:33 and 02:10: why D06 is always the slowest part, and that no run could be debugged):
// every suite, test, start, restart, stop and wait for the adapter's work as one JSON line in
// $KROBI_RUN_DIR/d06-events.jsonl — the run of werkbank-run.py sets the folder; without it (the CI) nothing is written,
// and a line that cannot be written changes no verdict. Each line names the adapter (npm's package name): a lab copy's
// run folder has no state that would.
const EVENTS = process.env.KROBI_RUN_DIR ? path.join(process.env.KROBI_RUN_DIR, "d06-events.jsonl") : null;
// Round 165 (krobi 2026-11-01 16:17: every check has a key over exactly its inputs, nothing runs twice): D06 per suite.
// pre-release.py names the suites whose key moved (KROBI_D06_ONLY, a JSON list of titles — every other suite is not
// registered), the files the run writes as its output (KROBI_D06_WATCH) and a file for one line per suite
// (KROBI_D06_RESULTS): its tests and hooks, what it left for the next suite, what it read of an earlier one, the output
// files before and after it and which of them it read and wrote (a later suite reads test/objects.inventory.json, which
// the first one writes). Without them (the CI) every suite runs, nothing is measured and nothing is written.
const ONLY = process.env.KROBI_D06_ONLY ? new Set(JSON.parse(process.env.KROBI_D06_ONLY)) : null;
const RESULTS = process.env.KROBI_D06_RESULTS || null;
const WATCH = process.env.KROBI_D06_WATCH ? JSON.parse(process.env.KROBI_D06_WATCH) : [];
// What the template's suiteState held where a suite left out would have ended (KROBI_D06_CARRY): `before` per title — the
// state the suite after a left-out one starts from in the whole run —, `end` the state the root hooks judge with when the
// last suites were left out. restoreState of the contract sets it; the suite's line says what it started from.
const CARRY = process.env.KROBI_D06_CARRY ? JSON.parse(process.env.KROBI_D06_CARRY) : { before: {}, end: null };
// fs as it is before the measurement below wraps it — the measurement reads through these
const FS = { readdirSync: fs.readdirSync, readFileSync: fs.readFileSync, statSync: fs.statSync };
// The state of the run between two suites. `suite`, `start`, `reads`, `cleared`, `read` and `wrote` belong to the suite
// running: its title, its start, what it read of an earlier suite, whether it removed the instance data before its
// adapter started, the output files it read and wrote. `first` is the world before the first suite and `firstStart` that
// suite's start; `pending` is the suite whose line waits until its harness has stopped; `contract` is the template's
// (withProtocol), `testDir` and `adapter` the harness's.
/**
 * @typedef {object} RunState
 * @property {string} suite
 * @property {number} start
 * @property {string[]} reads
 * @property {boolean} cleared
 * @property {string[]} read
 * @property {string[]} wrote
 * @property {number} starts
 * @property {ReturnType<typeof world> | null} first
 * @property {number} firstStart
 * @property {{ title: string, node: Mocha.Suite | undefined, at: number, before: Record<string, string>, start: string,
 *   carried: boolean } | null} pending
 * @property {boolean} span
 * @property {{ RESOURCE_DIR: string, suiteState?: () => unknown, restoreState?: (state: any) => void } | null} contract
 * @property {string} testDir
 * @property {string} adapter
 */
/** @type {RunState} */
const run = {
  suite: "",
  start: 0,
  reads: [],
  cleared: false,
  read: [],
  wrote: [],
  starts: 0,
  first: null,
  firstStart: 0,
  pending: null,
  span: false,
  contract: null,
  testDir: "",
  adapter: "",
};
function result(line) {
  if (!RESULTS) {
    return;
  }
  try {
    fs.appendFileSync(RESULTS, `${JSON.stringify(line)}\n`);
  } catch {
    // a lost line never changes a verdict — pre-release.py runs D06 whole without it
  }
}
/** The master's own state between two suites — each suite must leave it as the first one found it. */
function masterState() {
  return {
    suite: run.suite,
    start: run.start,
    reads: run.reads,
    cleared: run.cleared,
    read: run.read,
    wrote: run.wrote,
    starts: run.starts,
    pending: run.pending !== null,
    titles: protocolledTitles.size,
  };
}
/** A value as stable text: a Set and a Map by their entries, an object by its sorted keys, a function by its name. */
function stateText(value) {
  const open = new Set();
  const walk = v => {
    if (typeof v === "function") {
      return `<function ${v.name}>`;
    }
    if (typeof v === "bigint" || typeof v === "symbol") {
      return String(v);
    }
    if (v === undefined) {
      return "<undefined>";
    }
    if (!v || typeof v !== "object") {
      return v;
    }
    if (open.has(v)) {
      return "<cycle>";
    }
    open.add(v);
    try {
      if (v instanceof Set) {
        return { "<Set>": [...v].map(walk) };
      }
      if (v instanceof Map) {
        return { "<Map>": [...v].map(([k, x]) => [walk(k), walk(x)]) };
      }
      if (Array.isArray(v)) {
        return v.map(walk);
      }
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map(k => [k, walk(v[k])]),
      );
    } finally {
      open.delete(v);
    }
  };
  return JSON.stringify(walk(value));
}
const sha256 = data => require("node:crypto").createHash("sha256").update(data).digest("hex");
/**
 * Each file below `dir` (path relative to it → its sha256), the names `skip` returns true for left out.
 *
 * @param {string} dir the folder
 * @param {(name: string) => boolean} [skip] the paths (relative, with `/`) to leave out
 * @returns {Record<string, string>} path → sha256
 */
function filesOf(dir, skip = () => false) {
  /** @type {Record<string, string>} */
  const out = {};
  const walk = (at, rel) => {
    let entries = [];
    try {
      entries = FS.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (skip(name)) {
        continue;
      }
      if (e.isDirectory()) {
        walk(path.join(at, e.name), name);
      } else {
        try {
          out[name] = sha256(FS.readFileSync(path.join(at, e.name)));
        } catch {
          out[name] = "<unreadable>";
        }
      }
    }
  };
  walk(dir, "");
  return out;
}
// what @iobroker/testing resets before each suite (the two databases it restores, the folder it empties, the databases'
// own backups) and the instance data, whose reader the start measures (startsFromEarlier)
const CONTROLLER_RESET = /^(?:(?:objects|states)\.jsonl.*|sqlite|backup-objects)(?:\/|$)/;
/** The template's suiteState as stable text (plain values: restoreState gets them back through JSON). */
function suiteStateText() {
  try {
    return stateText(run.contract?.suiteState?.() ?? null);
  } catch (err) {
    return JSON.stringify(`<suiteState unreadable: ${err instanceof Error ? err.message : err}>`);
  }
}
/**
 * Sets the template's suiteState to `text` (KROBI_D06_CARRY) — false when the contract has no restoreState or it throws.
 *
 * @param {string} text the state as suiteStateText wrote it
 */
function restoreSuiteState(text) {
  try {
    run.contract?.restoreState?.(JSON.parse(text));
    return typeof run.contract?.restoreState === "function";
  } catch {
    return false;
  }
}
/**
 * The state one suite can leave for the next: the environment, the flags of RESOURCE_DIR (its files that are no record
 * `<pid|time>.<kind>`), the controller's data folder past what @iobroker/testing resets, both state functions.
 */
function world() {
  const dir = run.contract?.RESOURCE_DIR;
  const flags = dir ? filesOf(dir, name => /^\d+\./.test(name)) : {};
  const suiteState = suiteStateText();
  const controller = run.testDir
    ? filesOf(
        path.join(run.testDir, "iobroker-data"),
        name => CONTROLLER_RESET.test(name) || name === `${run.adapter}.0`,
      )
    : {};
  return { env: { ...process.env }, flags, controller, suiteState, masterState: stateText(masterState()) };
}
/**
 * What `now` holds that `first` did not, by name: environment variables, flags, controller files, the master's state. The
 * template's suiteState is no such leftover: each line says what its suite started from and ended with (`start`,
 * `state`), and a suite after one left out starts from what that one ended with (KROBI_D06_CARRY).
 */
function leftBehind(first, now) {
  const left = [];
  const differ = (what, a, b) => {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[k] !== b[k]) {
        left.push(`${what} ${k}`);
      }
    }
  };
  differ("env", first.env, now.env);
  differ("flag", first.flags, now.flags);
  differ("controller", first.controller, now.controller);
  if (now.masterState !== first.masterState) {
    left.push("masterState");
  }
  return left;
}
/**
 * Each file the run writes as its output (KROBI_D06_WATCH) → its sha256, a missing one as such.
 *
 * @returns {Record<string, string>} path → sha256 or "<absent>"
 */
function outputState() {
  return Object.fromEntries(
    WATCH.map(file => {
      try {
        return [file, sha256(FS.readFileSync(file))];
      } catch {
        return [file, "<absent>"];
      }
    }),
  );
}
/** The absolute path an fs call names (a string, a Buffer or a file URL), or null (a descriptor). */
function pathOf(file) {
  try {
    if (typeof file === "string") {
      return path.resolve(file);
    }
    if (Buffer.isBuffer(file)) {
      return path.resolve(file.toString());
    }
    if (file instanceof URL) {
      return require("node:url").fileURLToPath(file);
    }
  } catch {
    // not a path
  }
  return null;
}
const inside = (full, dir) => Boolean(full && dir) && (full === dir || full.startsWith(`${dir}${path.sep}`));
const resources = () => (run.contract?.RESOURCE_DIR ? path.resolve(run.contract.RESOURCE_DIR) : "");
const instanceData = () => (run.testDir ? path.join(run.testDir, "iobroker-data", `${run.adapter}.0`) : "");
/** A suite read what an earlier suite left: `why` names the channel ("records", "instance data"). */
function readEarlier(why) {
  if (run.start > 0 && !run.reads.includes(why)) {
    run.reads.push(why);
  }
}
/** A record an earlier suite made: born (a record only grows) after the first suite began and before this one. */
function madeEarlier(full) {
  try {
    const s = FS.statSync(full);
    const born = s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
    return born >= run.firstStart && born < run.start;
  } catch {
    return false;
  }
}
/** A file at or below `full` last written before this suite began. */
function olderInside(full) {
  let s;
  try {
    s = FS.statSync(full);
  } catch {
    return false;
  }
  if (!s.isDirectory()) {
    return s.mtimeMs < run.start;
  }
  try {
    return FS.readdirSync(full).some(name => olderInside(path.join(full, name)));
  } catch {
    return true;
  }
}
// Every fs call of this process is measured while a suite runs (pre-release.py only, KROBI_D06_RESULTS): a listing of
// RESOURCE_DIR outside recordFiles reads whatever earlier suites left — so it does in a run where they did not run —, and
// a record an earlier suite made holds its records; the instance data a suite did not remove first is what an earlier
// suite left, and a file in it older than the suite as well. Such a suite needs every suite before it. An output file
// (KROBI_D06_WATCH) a suite reads or writes is noted by its path — an open by its flags (fs.readFileSync opens through
// fs.openSync, so a read is also an open for reading). The measurement only looks: each call returns and throws as fs
// does.
const LISTINGS = new Set(["readdirSync", "opendirSync", "readdir", "opendir"]);
const READS = ["readFileSync", "statSync", "lstatSync", "existsSync", "accessSync", "openSync", "createReadStream"];
const READS_ASYNC = ["readFile", "stat", "lstat", "access", "open", "exists"];
const REMOVALS = ["rmSync", "rmdirSync", "rm", "rmdir"];
const WRITES = [
  "writeFileSync",
  "appendFileSync",
  "writeFile",
  "appendFile",
  "createWriteStream",
  "truncateSync",
  "truncate",
  "unlinkSync",
  "unlink",
  ...REMOVALS,
];
// these name a second file the call changes: the target of a copy, both ends of a move
const MOVES = new Set(["copyFileSync", "copyFile", "cpSync", "cp", "renameSync", "rename"]);
// an open writes when its flags say so ("r" when it names none)
const OPENS = new Set(["openSync", "open"]);
const WRITE_BITS =
  fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_TRUNC | fs.constants.O_CREAT;
const opensToWrite = flags =>
  typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" && (flags & WRITE_BITS) !== 0;
const note = (list, file) => {
  const full = pathOf(file);
  if (full && WATCH.includes(full) && !list.includes(full)) {
    list.push(full);
  }
};
function wrote(name, file, rest) {
  if (run.start === 0) {
    return;
  }
  if (OPENS.has(name) && !opensToWrite(rest[0])) {
    return;
  }
  note(run.wrote, file);
  if (MOVES.has(name)) {
    note(run.wrote, rest[0]);
  }
}
function looked(name, file, rest) {
  if (run.start === 0) {
    return;
  }
  if (!MOVES.has(name) && !(OPENS.has(name) && opensToWrite(rest[0]))) {
    note(run.read, file);
  }
  const full = pathOf(file);
  if (inside(full, resources()) && !run.reads.includes("records") && (LISTINGS.has(name) || madeEarlier(full))) {
    readEarlier("records");
  }
  if (inside(full, instanceData()) && !run.reads.includes("instance data") && (!run.cleared || olderInside(full))) {
    readEarlier("instance data");
  }
}
function removed(name, file) {
  if (run.start > 0 && inside(instanceData(), pathOf(file))) {
    run.cleared = true;
  }
}
if (RESULTS) {
  const wrap = (target, name, measure) => {
    const original = target?.[name];
    if (typeof original !== "function") {
      return;
    }
    /** @this {unknown} */
    const wrapper = function (file, ...rest) {
      try {
        measure(name, file, rest);
      } catch {
        // the measurement never changes what fs does
      }
      return original.call(this, file, ...rest);
    };
    // what the function carries beyond itself (fs.exists its promisified form)
    for (const key of Reflect.ownKeys(original)) {
      const own = Object.getOwnPropertyDescriptor(original, key);
      if (own && !(typeof key === "string" && ["length", "name", "prototype"].includes(key))) {
        Object.defineProperty(wrapper, key, own);
      }
    }
    target[name] = wrapper;
  };
  /** @type {Map<string, Array<(name: string, file: unknown, rest: unknown[]) => void>>} */
  const measures = new Map();
  const add = (names, measure) => names.forEach(n => measures.set(n, [...(measures.get(n) ?? []), measure]));
  add([...LISTINGS, ...READS, ...READS_ASYNC], looked);
  add(REMOVALS, removed);
  add([...WRITES, ...MOVES, ...OPENS], wrote);
  for (const target of [fs, fs.promises]) {
    for (const [name, list] of measures) {
      wrap(target, name, (n, file, rest) => list.forEach(measure => measure(n, file, rest)));
    }
  }
}
/**
 * The record files `<pid|time><suffix>` of RESOURCE_DIR last written at or after `from` (ms) — the one way a suite reads
 * the run's records. A file last written before `from` holds no record after it. `from` before the suite's own start (0:
 * the whole run) reads what earlier suites left, and so does a file an earlier suite made: the suite then needs every
 * suite before it — unless the master declares it in RUN_WIDE.
 *
 * @param {string} dir RESOURCE_DIR
 * @param {string} suffix ".calls", ".net", ".requests", …
 * @param {number} [from] the earliest time of interest (ms)
 * @returns {string[]} the file names
 */
function recordFiles(dir, suffix, from = 0) {
  if (from < run.start) {
    readEarlier("records");
  }
  return FS.readdirSync(dir).filter(f => {
    if (!f.endsWith(suffix)) {
      return false;
    }
    const full = path.join(dir, f);
    try {
      if (from > 0 && FS.statSync(full).mtimeMs < from) {
        return false;
      }
    } catch {
      return false;
    }
    if (madeEarlier(full)) {
      readEarlier("records");
    }
    return true;
  });
}
/**
 * The JSON lines of recordFiles, each with the `pid` (or time) its file name starts with.
 *
 * @param {string} dir RESOURCE_DIR
 * @param {string} suffix ".calls", ".net", ".requests", …
 * @param {number} [from] the earliest time of interest (ms)
 * @returns {object[]} the records, file by file
 */
function recordLines(dir, suffix, from = 0) {
  return recordFiles(dir, suffix, from).flatMap(f => {
    let text = "";
    try {
      text = FS.readFileSync(path.join(dir, f), "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map(l => ({ ...JSON.parse(l), pid: f.slice(0, -suffix.length) }));
  });
}
function protocolEvent(step, fields = {}) {
  if (!EVENTS) {
    return;
  }
  try {
    const line = {
      t: Date.now() / 1000,
      pid: process.pid,
      part: "fleet-suites",
      adapter: process.env.npm_package_name ?? "",
      step,
      suite: run.suite,
      ...fields,
    };
    fs.appendFileSync(EVENTS, `${JSON.stringify(line)}\n`);
  } catch {
    // the protocol never changes a verdict
  }
}
async function timed(step, fields, work) {
  const at = Date.now();
  protocolEvent(`${step}-start`, { ...fields, t: at / 1000 });
  try {
    return await work;
  } finally {
    // one clock reading for the line's end and its seconds — two straddled a millisecond tick and moved its begin
    const now = Date.now();
    protocolEvent(step, { ...fields, s: (now - at) / 1000, t: now / 1000 });
  }
}
// Round 165 (R165-159, lab runs 2026-11-02 00:12 and 00:50 on the fakeroku copy: of the eight calls of its hook the
// protocol measured the master's four, the template's suites make the other four themselves): the wait for the adapter's
// work as one "work-wait" line with its seconds, wherever it is called. The template builds its hook through it; a hook
// built without it (an adapter before its next release) is measured here for the master's suites, and one built with it
// is never measured twice. The mark sits on the function, not in a set of the master: nothing of the master changes as
// the template loads.
const MEASURED = Symbol("work-wait");
function workWaitOf(work) {
  if (work[MEASURED]) {
    return work;
  }
  // the hook is called once the wait's line is open (review 2026-11-02): called first, the template's hook opened its own
  // window before the wait began, and `analyse` counted that time as a wait and as a window
  const measured = (...args) =>
    timed(
      "work-wait",
      {},
      Promise.resolve().then(() => work(...args)),
    );
  measured[MEASURED] = true;
  return measured;
}
// Round 165 (krobi 2026-10-31 23:07 and 23:08: one uniform build for every wait, as a whole): every wait of a
// suite, the master's and the template's, goes through this one helper and is its own line in the protocol — its name,
// its cap and the seconds it took. `done` decides how it ends: without it the whole window (a window that proves something
// does not happen, or a pause the suite plays); a promise ends it when it settles; a function is asked at once, after every
// pause of `every` ms and once more at the cap, and ends it at its first truthy answer, which the wait returns. A cap of
// Infinity leaves the deadline to `done` (one that moves with the process started last).
function waitWindow(name, ms, done, every = 1000) {
  const cap = Math.max(0, ms);
  const wait = async () => {
    if (done === undefined) {
      await sleep(cap);
      return undefined;
    }
    if (typeof done !== "function") {
      let timer;
      try {
        return await Promise.race([done, new Promise(resolve => (timer = setTimeout(resolve, cap)))]);
      } finally {
        clearTimeout(timer);
      }
    }
    const until = Date.now() + cap;
    let got;
    while (!(got = await done()) && Date.now() < until) {
      await sleep(Math.min(every, until - Date.now()));
    }
    return got;
  };
  return timed("window", { name, ms: cap }, wait());
}
// every start and stop of a suite's harness as its own line, wherever the suite calls it — each harness once. A start
// without the wait for "ready" (the template's "a taken port") is a start too; the one the waiting start makes inside
// (@iobroker/testing 6.3.1 calls this.startAdapter synchronously) is the same start. Round 165: every start measures
// whether the adapter meets instance data an earlier suite left — @iobroker/testing resets the databases before each
// suite, never the instance data folder: it does unless the suite removed the folder before, or a file in it is older
// than the suite.
const TIMED = Symbol("fleet-suites timed");
function startsFromEarlier() {
  if (RESULTS && run.start > 0 && (!run.cleared || olderInside(instanceData()))) {
    readEarlier("instance data");
  }
}
function protocolHarness(harness) {
  if (harness && typeof harness === "object" && !harness[TIMED]) {
    harness[TIMED] = true;
    if (typeof harness.testDir === "string") {
      run.testDir = harness.testDir;
      run.adapter = harness.adapterName;
    }
    const startAndWait = harness.startAdapterAndWait.bind(harness);
    const startOnly = harness.startAdapter.bind(harness);
    const stop = harness.stopAdapter.bind(harness);
    let inner = false;
    const begin = (work, args) => {
      inner = true;
      try {
        if (run.start > 0) {
          run.starts++;
        }
        startsFromEarlier();
        return timed("start", {}, work(...args));
      } finally {
        inner = false;
      }
    };
    harness.startAdapterAndWait = (...args) => begin(startAndWait, args);
    harness.startAdapter = (...args) => (inner ? startOnly(...args) : begin(startOnly, args));
    harness.stopAdapter = (...args) => timed("stop", {}, stop(...args));
  }
  return harness;
}
/** A mocha suite's verdicts: its tests by state, recursively, and its hooks that failed (a harness stop among them). */
function tally(node) {
  const out = { passed: 0, failed: 0, pending: 0, notRun: node ? 0 : 1, hooksFailed: 0 };
  const walk = s => {
    for (const t of s.tests ?? []) {
      if (t.isPending?.()) {
        out.pending++;
      } else if (t.state === "passed") {
        out.passed++;
      } else if (t.state === "failed") {
        out.failed++;
      } else {
        out.notRun++;
      }
    }
    for (const h of [
      ...(s._beforeAll ?? []),
      ...(s._beforeEach ?? []),
      ...(s._afterEach ?? []),
      ...(s._afterAll ?? []),
    ]) {
      if (h.state === "failed") {
        out.hooksFailed++;
      }
    }
    for (const c of s.suites ?? []) {
      walk(c);
    }
  };
  if (node) {
    walk(node);
  }
  return out;
}
/**
 * The line of the suite that ran last, once its harness has stopped (the next suite's start, the end of all suites):
 * its verdicts, what it left that the first suite did not find, what it read of an earlier suite, the output before and
 * after it.
 */
function finishSuite() {
  const p = run.pending;
  if (!p) {
    return;
  }
  const { reads, read, wrote: written, starts } = run;
  run.pending = null;
  run.suite = "";
  run.start = 0;
  run.reads = [];
  run.cleared = false;
  run.read = [];
  run.wrote = [];
  run.starts = 0;
  if (RESULTS) {
    result({
      title: p.title,
      ...tally(p.node),
      left: run.first ? leftBehind(run.first, world()) : ["<no world before the first suite>"],
      reads,
      before: p.before,
      after: outputState(),
      read,
      wrote: written,
      start: p.start,
      state: suiteStateText(),
      carried: p.carried,
      starts,
      s: p.at ? (Date.now() - p.at) / 1000 : 0,
    });
  }
}
// Round 165 (lab run 2026-10-31 22:50: 28 s of a 224 s D06 before the first event): what @iobroker/testing does before
// the first suite — its preparation of the controller and its own suite "Adapter startup" — as one span with the seconds
// since the process started, and that suite's tests with mocha's duration. Registered once, where the template calls
// withProtocol (@iobroker/testing's "User-defined tests"): it runs after "Adapter startup" and before the first suite;
// its end finishes the last suite.
const HARNESS_SPAN = "@iobroker/testing";
function protocolHarnessSpan() {
  if (run.span) {
    return;
  }
  run.span = true;
  before(function () {
    const own = this?.test?.parent;
    for (const sibling of own?.parent?.suites ?? []) {
      if (sibling === own) {
        break;
      }
      for (const test of sibling.tests ?? []) {
        protocolEvent("test", {
          suite: HARNESS_SPAN,
          title: `${sibling.title}: ${test.title}`,
          state: test.state,
          s: (test.duration ?? 0) / 1000,
        });
      }
    }
    protocolEvent("suite", { suite: HARNESS_SPAN, s: process.uptime() });
    // Round 165 (R165-94, krobi 2026-11-01 00:28): how many suites follow — the status window shows "Suite k von N"
    protocolEvent("plan", {
      suite: HARNESS_SPAN,
      kind: "suite",
      of: (own?.suites ?? []).filter(suite => protocolledTitles.has(suite.title)).length,
    });
  });
  after(function () {
    finishSuite();
    // the last suites were left out: the root hooks judge with the state the whole run ends with
    if (RESULTS && CARRY.end !== null && CARRY.end !== undefined) {
      result({ end: restoreSuiteState(CARRY.end) ? suiteStateText() : "<not restored>" });
    }
  });
}
// The template's `suite` with a start and an end per suite and one line per test (mocha's duration and verdict). The
// template wraps its own suites with it and hands the wrapped one to this file (lab run 2026-10-31 22:25: without that,
// 103 s of a 222 s D06 left events), which wraps it no second time. Round 165: the template hands its contract along —
// `{ RESOURCE_DIR, suiteState, restoreState }`, suiteState naming every binding of the template a function writes and
// restoreState setting each of them again —, and a suite pre-release.py did not select (KROBI_D06_ONLY) is not registered.
const PROTOCOLLED = Symbol("fleet-suites protocolled");
const protocolledTitles = new Set();
function withProtocol(suite, contract) {
  protocolHarnessSpan();
  if (contract) {
    run.contract = contract;
  }
  if (suite?.[PROTOCOLLED]) {
    return suite;
  }
  const wrapped = (title, body) => {
    if (ONLY && !ONLY.has(title)) {
      result({ title, registered: false });
      return undefined;
    }
    protocolledTitles.add(title);
    result({ title, registered: true });
    return suite(title, getHarness => {
      let at = 0;
      before(function () {
        finishSuite();
        protocolHarness(getHarness());
        // the suite before it was left out: it starts from the state that one ended with in the run that proved it
        const carried =
          RESULTS && typeof CARRY.before?.[title] === "string" ? restoreSuiteState(CARRY.before[title]) : true;
        if (RESULTS && !run.first) {
          run.first = world();
        }
        // measured before the suite counts as running: the master's own reads are no read of the suite
        const outputs = RESULTS ? outputState() : {};
        const start = RESULTS ? suiteStateText() : "";
        at = Date.now();
        run.suite = title;
        run.start = at;
        run.firstStart ||= at;
        run.pending = { title, node: this?.test?.parent, at, before: outputs, start, carried };
        protocolEvent("suite-start", { t: at / 1000 });
      });
      afterEach(function () {
        const test = this.currentTest;
        protocolEvent("test", { title: test?.title, state: test?.state, s: (test?.duration ?? 0) / 1000 });
      });
      body(() => protocolHarness(getHarness()));
      after(function () {
        // a suite whose start failed before its own hook ran: the line of the one before it, then its own — its end
        // carries its own title (review 2026-11-02: it carried the one before it, and `analyse` set that suite to 0 s)
        if (run.pending?.title !== title) {
          finishSuite();
          run.pending = { title, node: this?.test?.parent, at: 0, before: {}, start: "", carried: false };
          run.suite = title;
        }
        const now = Date.now();
        protocolEvent("suite", { s: at ? (now - at) / 1000 : 0, t: now / 1000 });
      });
    });
  };
  wrapped[PROTOCOLLED] = true;
  return wrapped;
}

// D3 (round 132, govee 2026-10-20: a second test within 30 s answers from its throttle): the spacing an adapter
// declares between two real connection tests. It only makes the suite wait — a spacing shorter than the throttle
// leaves the cut test answered from the throttle, and D3 stays red. The cap only bounds a run against a wrong value
// (two minutes, four times the longest throttle measured); a longer throttle is a question for the Werkbank.
const SPACING_CAP_MS = 120000;
function spacingOf(test) {
  const spacing = test.spacingMs ?? 0;
  assert.ok(
    Number.isInteger(spacing) && spacing >= 0 && spacing <= SPACING_CAP_MS,
    `fleet.json suites.connectionTest.spacingMs is a whole number of milliseconds from 0 to ${SPACING_CAP_MS}`,
  );
  return spacing;
}

// D6 (round 132, govee 2026-10-20): the markers that went to their stopped value with the drop — one that showed it
// before the drop says nothing about the dropped device.
function newlyDown(markers, before, after) {
  return markers.filter(([id, off]) => after[id]?.val === off && before[id]?.val !== off).map(([id]) => id);
}
// D6: the markers that showed their device reachable before the drop — the suite needs two, or no other device could
// wrongly go down with the dropped one.
function upBefore(markers, before) {
  return markers
    .filter(([id, off]) => before[id]?.val !== undefined && before[id]?.val !== null && before[id]?.val !== off)
    .map(([id]) => id);
}
// D6/C26b (round 148, dl-manager CI 40423395879): an emptied value counts only when the clean start already had it — the
// baseline before each mode carries what the previous wrong answers set (a reason text), and an adapter that recovers after
// that mode, as its backoff wants, rightly empties it again (the fleet rule: empty while all is well).
function emptiedOf(clean, before, after) {
  return Object.keys(before).filter(
    id =>
      id in clean &&
      !EMPTY.has(clean[id]?.val) &&
      !EMPTY.has(before[id]?.val) &&
      (!(id in after) || EMPTY.has(after[id]?.val)),
  );
}
// D6/C26b (round 163, dl-manager CI 41098560273): the adapter's writes in the order the states arrived, and the host's
// alive=false of each restart among them (GONE) — what the old process wrote before it, its stop, is no answer of the
// restarted adapter (round 157 F20 for its requests). A missing mark would judge nothing, so it fails loudly.
const GONE = "";
function newProcessWrites(writes) {
  const gone = writes.findIndex(([id]) => id === GONE);
  assert.ok(
    gone >= 0,
    "the host's alive=false of a restart never reached the states — the restart play needs a new form",
  );
  return writes.slice(gone + 1);
}
// D6/C26b (round 163): per value of the clean start the empties the new process of a restart with right answers wrote
// before its first value (dl-manager resets its speeds on every stop and start), and the values still waiting for one.
function restartEmpties(clean, writes) {
  const lead = {};
  const filled = new Set();
  for (const [id, empty] of newProcessWrites(writes)) {
    if (!(id in clean) || EMPTY.has(clean[id]?.val) || filled.has(id)) {
      continue;
    }
    if (empty) {
      lead[id] = (lead[id] ?? 0) + 1;
    } else {
      filled.add(id);
    }
  }
  return { lead, waiting: Object.keys(lead).filter(id => !filled.has(id)) };
}
// D6/C26b (round 157, fleet-suite audit F6): a value of the clean start the adapter emptied WHILE a wrong answer was played —
// the before/after picture missed one emptied and filled again inside the window (deletions had their listener already).
// Round 163: only the new process counts, and of its empties before a value only those beyond the clean restart's.
function emptiedDuring(clean, before, writes, restart) {
  const lead = {};
  const filled = new Set();
  const emptied = new Set();
  for (const [id, empty] of newProcessWrites(writes)) {
    if (!(id in clean) || EMPTY.has(clean[id]?.val) || EMPTY.has(before[id]?.val)) {
      continue;
    }
    if (!empty) {
      filled.add(id);
    } else if (filled.has(id) || (lead[id] = (lead[id] ?? 0) + 1) > (restart[id] ?? 0)) {
      emptied.add(id);
    }
  }
  return [...emptied];
}
// D21 (round 157, fleet-suite audit F17): the calls to a host before the retry-after of its first 429 ran out — a call
// once there stays (a later one never moves the first), so the window ends at the first and the verdict is the same.
function retryTooEarly(calls) {
  const byHost = new Map();
  for (const c of calls) {
    byHost.set(c.host, [...(byHost.get(c.host) ?? []), c.t]);
  }
  const early = [];
  for (const [host, times] of byHost) {
    const first = Math.min(...times);
    const again = times.filter(when => when > first + RETRY_GRACE_MS && when < first + RETRY_AFTER_MS - RETRY_GRACE_MS);
    if (again.length > 0) {
      early.push(`${host}: ${again.length} call(s), the first ${again[0] - first} ms after a 429 with retry-after 60`);
    }
  }
  return early;
}
// D12 (round 157, fleet-suite audit F3): after a restart waitForAdapterWork ends at once (the values exist from the first
// start), so the tree was counted before the adapter rebuilt it — "0 changed, no line" was green without a proof. The
// suite waits for the balance line or a state set that holds still for SWITCH_STILL_POLLS seconds, at most
// SWITCH_SETTLE_CAP_MS.
const SWITCH_STILL_POLLS = 5;
const SWITCH_SETTLE_CAP_MS = 60000;
function sameIds(a, b) {
  return a.size === b.size && [...a].every(id => b.has(id));
}
// D6 (round 141, yamaha 2026-10-22: every receiver carries info.connection and one reachable flag per transport, 32
// markers on 8 devices, and one dropped receiver turned 2 to 4 of them false): the suite counts DEVICES, not markers. A
// marker belongs to the nearest object above it whose type is "device", else to the first id segment under the namespace.
function devicesOf(ids, objects) {
  const owner = id => {
    const parts = id.split(".");
    for (let n = parts.length - 1; n >= 3; n--) {
      const candidate = parts.slice(0, n).join(".");
      if (objects[candidate]?.type === "device") {
        return candidate;
      }
    }
    return parts.slice(0, 3).join(".");
  };
  return [...new Set(ids.map(owner))].sort();
}
// D9 (round 142, yamaha 2026-10-22): a press the adapter drops itself — a player key while the zone plays no player
// source, a menu step with no menu open — reaches no counterpart and stays `true` with `ack: false`: GV-13 (krobi
// 2026-09-25 23:48, the sealed register's text) keeps a command that did not arrive unconfirmed and never writes the old
// value back blindly. The fleet's button standard (2026-06-11) resets after a success and allows none after an error.
// A button counts as dropped only while nothing but the press wrote it, no call ran in its own context since the first
// press, and a press of it alone meets a window without any call at all. The cause only makes a button red: a queue may
// lose it (round 104, yamaha 11 of 436), so a call without it or with another one is ambiguous and the press is repeated.
async function droppedPress(harness, id, opts) {
  const {
    adapter,
    readCalls,
    since,
    windowMs = PRESS_ALONE_MS,
    tries = PRESS_TRIES,
    wait = ms => waitWindow("D9 a press alone", ms),
  } = opts;
  const untouched = s => s?.val === true && s?.ack === false && s?.from !== `system.adapter.${adapter}.0`;
  const ownCall = from => readCalls(from).some(c => c.cause === id && c.t >= from);
  if (!untouched(await harness.states.getStateAsync(id)) || ownCall(since)) {
    return false;
  }
  for (let i = 0; i < tries; i++) {
    const t = Date.now();
    await harness.states.setStateAsync(id, { val: true, ack: false });
    await wait(windowMs);
    const calls = readCalls(t).filter(c => c.t >= t);
    if (!untouched(await harness.states.getStateAsync(id)) || calls.some(c => c.cause === id)) {
      return false;
    }
    if (calls.length === 0) {
      return true;
    }
  }
  return false;
}
// D21 (round 157, fleet-suite audit): the hang suite slept a fixed since + deadline + slack (135 s) — and since its start
// alone takes up to 30 s, a call that never ended could hardly ever be judged (that needs it older than the deadline while
// its process lives). The calls judged are those that began within `windowMs` of the first hung call; the suite holds until
// each has ended or is open past the deadline plus one pulse of the network hook (2 s) — the verdict below reads the same
// records. "none": no call hung yet.
const PULSE_SLACK_MS = 3000;
function hangDecided(calls, windowMs, deadlineMs, now) {
  const starts = calls.filter(c => c.kind === "hang-start");
  if (starts.length === 0) {
    return "none";
  }
  const first = Math.min(...starts.map(c => c.t));
  const open = new Map();
  for (const c of [...calls].sort((a, b) => a.t - b.t)) {
    const key = `${c.host} ${c.port}`;
    if (c.kind === "hang-start") {
      open.set(key, [...(open.get(key) ?? []), c.t]);
    } else if (c.kind === "hang-end") {
      (open.get(key) ?? []).shift();
    }
  }
  const undecided = [...open.values()]
    .flat()
    .filter(t => t < first + windowMs && now - t <= deadlineMs + PULSE_SLACK_MS);
  return undecided.length === 0 ? "decided" : "open";
}
// D21 (round 157): under a 500 to every answer only a host called at least twice in the second minute is judged, red when
// the fourth minute holds as many calls or more — once the second minute is over and no host qualifies, or one host is red
// already, the verdict cannot change (the suite slept all four minutes).
function errorCountsByHost(calls, since) {
  const byHost = new Map();
  for (const c of calls) {
    const w = Math.floor((c.t - since) / ERROR_WINDOW_MS);
    if (w >= 0 && w < ERROR_WINDOWS) {
      const counts = byHost.get(c.host) ?? new Array(ERROR_WINDOWS).fill(0);
      counts[w]++;
      byHost.set(c.host, counts);
    }
  }
  return byHost;
}
function backoffSettled(byHost, minute) {
  if (minute < 2) {
    return false;
  }
  const judged = [...byHost.values()].filter(counts => counts[1] >= 2);
  return judged.length === 0 || judged.some(counts => counts[ERROR_WINDOWS - 1] >= counts[1]);
}
// D11 (round 133, govee CI 39408072351): when each state was last written — the template's dumpStates carries val and ack
// only, so D11 read no time, counted no data and was red for every adapter whose data kept arriving.
async function stampsOf(harness, ids) {
  const values = await harness.states.getStates(ids);
  return Object.fromEntries(ids.map((id, i) => [id, values[i]?.ts]));
}

// Round 138 (audit M11): a run that shares the workshop with other runs takes its mutex — until now only a hook that
// recognised the command text made sure of it. Walking up from the adapter, the first `.cache/locks` that holds the
// workshop lock decides: its holder must be an ancestor of this process (with-werkstatt-lock.py, pre-release.py). No such
// folder (the CI, a clone elsewhere): nothing to hold. Round 139 (govee 2026-10-21, krobi): the flock decides, not the
// holder file — a killed holder leaves its text behind, and a PID the system hands out again could name an ancestor.
// The probe is the system's lockf(1) (the workshop is a Mac; an adapter carries no Python, mcm1957): -k keeps the
// lock file (without it lockf deletes the file), -t 0 waits for nothing; exit 0 = free, 75 = held.
const LOCKF_HELD = 75;

function workshopMutexProblem(startDir) {
  const { execFileSync, spawnSync } = require("node:child_process");
  let dir = path.resolve(startDir);
  for (;;) {
    const locks = path.join(dir, ".cache", "locks");
    const lockFile = path.join(locks, "werkstatt-pruefung.lock");
    if (fs.existsSync(lockFile)) {
      const probe = spawnSync("lockf", ["-k", "-s", "-t", "0", lockFile, "/usr/bin/true"], { encoding: "utf8" });
      if (probe.status === 0) {
        return `the workshop mutex (${locks}) is not held — start the run through werkbank-run.py hand`;
      }
      if (probe.status !== LOCKF_HELD) {
        return `the workshop mutex (${locks}) cannot be probed (lockf: ${probe.error?.message ?? `exit ${probe.status}`})`;
      }
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(path.join(locks, "werkstatt-pruefung.holder.json"), "utf8")).pid;
      } catch {
        return `the workshop mutex (${locks}) is held, but names no holder — start the run through werkbank-run.py hand`;
      }
      let pid = process.pid;
      for (let hop = 0; hop < 64 && pid > 1; hop++) {
        if (pid === Number(holder)) {
          return null;
        }
        try {
          pid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
        } catch {
          break;
        }
      }
      return `the workshop mutex (${locks}) is held by PID ${holder}, which did not start this run`;
    }
    const up = path.dirname(dir);
    if (up === dir) {
      return null;
    }
    dir = up;
  }
}

module.exports = function fleetSuites(templateSuite, ctx) {
  const mutexProblem = workshopMutexProblem(ctx.ADAPTER_DIR);
  if (mutexProblem) {
    throw new Error(mutexProblem);
  }
  const suite = withProtocol(templateSuite);
  const {
    ADAPTER_DIR,
    ADAPTER,
    NS,
    FIRST_LANGUAGE,
    SECOND_LANGUAGE,
    NETWORK_HOOK,
    OUTAGE_FLAG,
    clearInstanceData,
    resetInstanceNative,
    fixtureNative,
    setSystemLanguage,
    playControllerRestarts,
    adapterEnv,
    feedFixtures,
    dumpObjects,
    dumpStates,
    withinDeadline,
    readCalls,
    RESOURCE_DIR,
    HANG_DEADLINE_MS,
    CHOSEN_ADDRESS,
  } = ctx;
  // round 165: every restart and wait of this file through the protocol, with its seconds — the starts and stops inside
  // them, like every other, at the harness (protocolHarness)
  const restartAsTheHost = (harness, ...rest) =>
    timed("restart", { why: rest[1] }, ctx.restartAsTheHost(harness, ...rest));
  const waitForAdapterWork = workWaitOf(ctx.waitForAdapterWork);
  // round 165: every record through recordLines — `from` bounds it to this suite (0: the whole run, RUN_WIDE)
  const netRecords = (from = 0) => recordLines(RESOURCE_DIR, ".net", from).filter(r => !r.hook);
  const FAULT_FLAG = path.join(RESOURCE_DIR, "fault");
  // network hook, section 4: `*` lets every counterpart hang
  const HANG_FILE = path.join(RESOURCE_DIR, "hang");
  // an adapter without a counterpart carries no network hook (counterpart.none in its sealed register, round 87)
  const NET = fs.existsSync(NETWORK_HOOK) ? [NETWORK_HOOK] : [];
  const noNet = what => {
    console.log(`      no test/network-hook.js — the adapter has no counterpart, ${what}`);
  };
  const httpCalls = (from, until = Infinity) =>
    readCalls(from).filter(c => c.kind === "http" && c.t >= from && c.t < until && !c.hook).length;
  // network hook: the JSON lines every process of the run wrote into RESOURCE_DIR/<pid><suffix>
  const probeLines = (suffix, from = 0) => recordLines(RESOURCE_DIR, suffix, from);
  const stateIds = objects => new Set(Object.keys(objects).filter(id => objects[id]?.type === "state"));
  // network hook, section 7: every HTTP request of the adapter with the fault it met
  const readRequests = (from, until = Infinity) =>
    recordLines(RESOURCE_DIR, ".requests", from).filter(r => r.t >= from && r.t < until);
  // round 157 (fleet-suite audit F20): the processes that ran before a restart — what the dying one sends while it stops
  // is no answer of the restarted adapter; `from` the suite's first start — an earlier suite's process is no answer either
  const pidsOf = (suffix, from) =>
    new Set(recordFiles(RESOURCE_DIR, suffix, from).map(f => f.slice(0, -suffix.length)));
  const declared = readDeclarations(ADAPTER_DIR);
  const manifest = require(path.join(ADAPTER_DIR, "io-package.json"));
  const takesMessages = Boolean(manifest.common?.messagebox || manifest.common?.supportedMessages);
  const own = l => l.from === `${ADAPTER}.0`;
  const loud = l => own(l) && !["debug", "silly"].includes(l.level);
  // D3 → D14: the error text of the cut connection test in the first language
  let firstLanguageError;

  async function start(harness, language, ...hooks) {
    clearInstanceData(harness);
    await resetInstanceNative(harness, await fixtureNative());
    await setSystemLanguage(harness, language);
    const restarts = playControllerRestarts(harness, null, ...hooks);
    await withinDeadline(
      harness.startAdapterAndWait(false, adapterEnv(...hooks)),
      FIRST_START_MS,
      "the adapter did not start",
    );
    await feedFixtures(harness);
    await restarts.done;
    await waitForAdapterWork(harness);
    return restarts;
  }

  function ask(harness, command, message) {
    const answer = new Promise(resolve => harness.sendTo(`${ADAPTER}.0`, command, message, resolve));
    return withinDeadline(answer, ANSWER_MS, `no answer to the message ${command}`);
  }

  suite("a quiet run and a clean stop", getHarness => {
    let harness;
    let quiet;
    let objects;
    before(async function () {
      this.timeout(QUIET_WINDOW_MS + 240000);
      harness = getHarness();
      await start(harness, FIRST_LANGUAGE, ...NET);
      const line = harness.getLogs().length;
      // round 157 (fleet-suite audit F13): a loud line is the verdict at once — only a quiet run needs the whole window
      await waitWindow("D7 a quiet run", QUIET_WINDOW_MS, () => harness.getLogs().slice(line).some(loud));
      quiet = harness
        .getLogs()
        .slice(line)
        .filter(loud)
        .map(l => `${l.level}: ${l.message}`);
      objects = await dumpObjects(harness);
    });

    it("logs nothing above debug once its start is done (D7)", function () {
      assert.deepStrictEqual(
        quiet,
        [],
        `log lines above debug in the ${QUIET_WINDOW_MS} ms after the start:\n${quiet.join("\n")}`,
      );
    });

    it("answers an unknown message with an error (D10)", async function () {
      this.timeout(ANSWER_MS + 5000);
      if (!takesMessages) {
        console.log("      the adapter takes no messages (no common.messagebox) — nothing to ask");
        return;
      }
      const answer = await ask(harness, "inventoryUnknownCommand", {});
      assert.ok(
        answer && typeof answer === "object" && typeof answer.error === "string" && answer.error.length > 0,
        `an unknown message got ${JSON.stringify(answer)} — an answer { error: "<text>" } is due`,
      );
    });

    it("lets every button fall back to false, confirmed (D9)", async function () {
      const buttons = Object.entries(objects)
        .filter(
          ([, o]) =>
            o.type === "state" && String(o.common?.role ?? "").startsWith("button") && o.common?.write === true,
        )
        .map(([id]) => id);
      this.timeout(PRESS_WINDOW_MS + buttons.length * 500 + 10000);
      const since = Date.now();
      // every button at once, one window for all — pressed one by one, 72 buttons took 18 minutes (homeconnect lab copy)
      for (const id of buttons) {
        await harness.states.setStateAsync(id, { val: true, ack: false });
      }
      let stuck = buttons;
      const fellBack = async () => {
        if (stuck.length > 0) {
          const states = await harness.states.getStates(stuck);
          stuck = stuck.filter((id, i) => !(states[i]?.val === false && states[i]?.ack === true));
        }
        return stuck.length === 0;
      };
      await waitWindow("D9 every button falls back", PRESS_WINDOW_MS, fellBack, 500);
      // round 142: only a button that is red so far is pressed again alone — a press that falls back stays judged as
      // before; once more a full window after the last press, so a call a slow queue sent late still marks it sent
      this.timeout(stuck.length * PRESS_TRIES * (PRESS_ALONE_MS + 1000) + PRESS_WINDOW_MS + 10000);
      const dropped = [];
      let told = Date.now();
      for (const [i, id] of stuck.entries()) {
        if (await droppedPress(harness, id, { adapter: ADAPTER, readCalls, since })) {
          dropped.push(id);
        }
        // a line now and then: the harness watchdog ends a run that stays silent for 20 minutes
        if (Date.now() - told >= 30000) {
          console.log(`      D9: ${i + 1} of ${stuck.length} pressed alone`);
          told = Date.now();
        }
      }
      if (dropped.length > 0) {
        await waitWindow("D9 a late call of a dropped press", PRESS_WINDOW_MS);
        const after = await harness.states.getStates(dropped);
        const late = dropped.filter(
          (id, i) =>
            !(after[i]?.val === true && after[i]?.ack === false && after[i]?.from !== `system.adapter.${ADAPTER}.0`) ||
            readCalls(since).some(c => c.cause === id && c.t >= since),
        );
        stuck = stuck.filter(id => !dropped.includes(id) || late.includes(id));
        console.log(
          `      ${dropped.length - late.length} press(es) the adapter dropped itself stay unconfirmed (GV-13)`,
        );
      }
      const shown = [];
      for (const id of stuck) {
        const s = await harness.states.getStateAsync(id);
        shown.push(`${id} = ${JSON.stringify(s?.val)} ack ${s?.ack}`);
      }
      assert.deepStrictEqual(
        shown,
        [],
        `buttons that did not fall back to false with ack within ${PRESS_WINDOW_MS} ms — and reached a counterpart or were written by the adapter, so no dropped press:\n${shown.join("\n")}`,
      );
    });

    it("answers result while its counterpart is there and error while it is cut (D3)", async function () {
      const test = declared("connectionTest");
      if (test === null) {
        return;
      }
      assert.ok(
        test && typeof test.command === "string",
        "fleet.json suites.connectionTest is { command, message } or { none }",
      );
      assert.ok(
        NET.length > 0,
        "fleet.json suites.connectionTest declares a test, but the adapter carries no test/network-hook.js to cut its counterpart",
      );
      const spacing = spacingOf(test);
      this.timeout(3 * ANSWER_MS + 10000 + 2 * spacing);
      const there = await ask(harness, test.command, test.message ?? {});
      await waitWindow("D3 spacing", spacing);
      let cut;
      let again;
      fs.writeFileSync(OUTAGE_FLAG, "");
      try {
        cut = await ask(harness, test.command, test.message ?? {});
        // round 157 (fleet-suite audit F4): the same cut twice — D14 compares this text with the second language, and a
        // text with changing parts (a time, a counter) would differ there without a word translated
        await waitWindow("D3 spacing", spacing);
        again = await ask(harness, test.command, test.message ?? {});
      } finally {
        fs.rmSync(OUTAGE_FLAG, { force: true });
      }
      firstLanguageError = typeof cut?.error === "string" ? cut.error : undefined;
      assert.ok(
        there && there.result !== undefined && there.error === undefined,
        `with the counterpart there the test answered ${JSON.stringify(there)} — { result } is due`,
      );
      assert.ok(
        typeof cut?.error === "string" && cut.error.length > 0,
        `with every counterpart cut the test answered ${JSON.stringify(cut)} — a test that asks for real gets { error }`,
      );
      assert.strictEqual(
        again?.error,
        cut.error,
        "the cut test answered two different texts — D14 cannot tell a translation from a changing text",
      );
    });

    it("stops with every marker offline, every reason Unknown and the sums at zero (D4)", async function () {
      this.timeout(STOP_MS + 30000);
      await withinDeadline(harness.stopAdapter(), STOP_MS, "the adapter did not stop");
      const states = await dumpStates(harness);
      const wrong = [];
      const val = id => states[id]?.val;
      if (`${NS}info.connection` in objects && val(`${NS}info.connection`) !== false) {
        wrong.push(`info.connection = ${JSON.stringify(val(`${NS}info.connection`))}, want false`);
      }
      for (const [id, o] of Object.entries(objects)) {
        if (o.type !== "state") {
          continue;
        }
        const rel = id.slice(NS.length);
        const role = String(o.common?.role ?? "");
        const leaf = rel.split(".").at(-1) ?? "";
        let want;
        if (role in STOPPED && rel !== "info.connection") {
          want = STOPPED[role];
        } else if (o.common?.type === "string" && REASON_LEAF.test(leaf) && rel.split(".").includes("info")) {
          want = "Unknown";
        } else if (SUM_ALL.test(rel)) {
          want = false;
        } else if (SUM_ONLINE.test(rel)) {
          want = 0;
        } else {
          continue;
        }
        if (val(id) !== want) {
          wrong.push(`${rel} = ${JSON.stringify(val(id))}, want ${JSON.stringify(want)}`);
        }
      }
      assert.deepStrictEqual(wrong, [], `after the stop:\n${wrong.join("\n")}`);
    });
  });

  suite("answers in the system language", getHarness => {
    let harness;
    let test;
    let there;
    let cut;
    before(async function () {
      this.timeout(240000 + 2 * ANSWER_MS + SPACING_CAP_MS);
      test = declared("connectionTest");
      if (test === null) {
        return;
      }
      harness = getHarness();
      await start(harness, SECOND_LANGUAGE, ...NET);
      // round 157 (fleet-suite audit F4): the test answers `result` first — a cut answer of a test not ready yet differs
      // from the first language for another reason than the language
      there = await ask(harness, test.command, test.message ?? {});
      await waitWindow("D14 spacing", spacingOf(test));
      fs.writeFileSync(OUTAGE_FLAG, "");
      try {
        cut = await ask(harness, test.command, test.message ?? {});
      } finally {
        fs.rmSync(OUTAGE_FLAG, { force: true });
      }
    });
    after(() => fs.rmSync(OUTAGE_FLAG, { force: true }));

    it("answers the cut connection test in other words than in the first language (D14)", function () {
      if (test === null) {
        return;
      }
      assert.ok(
        firstLanguageError !== undefined,
        'the test of D3 in "a quiet run and a clean stop" measured no error text to compare with',
      );
      assert.ok(
        there && there.result !== undefined && there.error === undefined,
        `with the counterpart there the test answered ${JSON.stringify(there)} in ${SECOND_LANGUAGE} — { result } is due`,
      );
      assert.ok(typeof cut?.error === "string" && cut.error.length > 0, `the cut test answered ${JSON.stringify(cut)}`);
      assert.notStrictEqual(
        cut.error,
        firstLanguageError,
        `the answer in ${SECOND_LANGUAGE} is the ${FIRST_LANGUAGE} text: ${cut.error}`,
      );
    });
  });

  suite("a group switch reports its balance", getHarness => {
    let harness;
    let switches;
    const lines = {};
    before(async function () {
      switches = declared("groupSwitches");
      if (switches === null) {
        return;
      }
      assert.ok(
        Array.isArray(switches) && switches.length > 0,
        "fleet.json suites.groupSwitches is a list of native keys or { none }",
      );
      this.timeout(switches.length * 120000 + 240000);
      harness = getHarness();
      await start(harness, FIRST_LANGUAGE);
      let native = await fixtureNative();
      for (const key of switches) {
        assert.strictEqual(
          typeof native[key],
          "boolean",
          `fleet.json suites.groupSwitches names ${key}, which is no boolean of the fixture native`,
        );
        native = { ...native, [key]: !native[key] };
        const before = stateIds(await dumpObjects(harness));
        await resetInstanceNative(harness, native);
        const line = harness.getLogs().length;
        await restartAsTheHost(harness, null, `for the group switch ${key}`);
        await waitForAdapterWork(harness);
        let seen = stateIds(await dumpObjects(harness));
        let still = 0;
        let paused = false;
        // the stillness counts the pauses only — the first answer, before any pause, compares nothing
        const settled = async () => {
          if (
            harness
              .getLogs()
              .slice(line)
              .some(l => own(l) && BALANCE_RE.test(l.message))
          ) {
            return true;
          }
          if (paused) {
            const now = stateIds(await dumpObjects(harness));
            still = sameIds(now, seen) ? still + 1 : 0;
            seen = now;
          }
          paused = true;
          return still >= SWITCH_STILL_POLLS;
        };
        await waitWindow(`D12 the tree settles after ${key}`, SWITCH_SETTLE_CAP_MS, settled);
        const after = stateIds(await dumpObjects(harness));
        lines[key] = {
          changed: [...after].filter(id => !before.has(id)).length + [...before].filter(id => !after.has(id)).length,
          found: harness
            .getLogs()
            .slice(line)
            .filter(l => own(l) && BALANCE_RE.test(l.message)),
        };
      }
    });

    it("logs one balance line when a flipped group switch changed datapoints, none when it changed none (D12)", function () {
      if (switches === null) {
        return;
      }
      // krobi 2026-08-26: one line per switch, silent at 0/0
      const wrong = Object.entries(lines)
        .filter(([, l]) => (l.changed > 0 ? l.found.length !== 1 || l.found[0].level !== "info" : l.found.length !== 0))
        .map(
          ([key, l]) =>
            `${key}: ${l.changed} datapoint(s) came or went, ${l.found.length} balance line(s)${l.found[0] ? ` at ${l.found[0].level}` : ""}`,
        );
      assert.deepStrictEqual(
        wrong,
        [],
        `a group switch logs exactly one info line "Object tree updated: created N datapoint(s), removed M datapoint(s)" when datapoints came or went, and none when nothing changed:\n${wrong.join("\n")}`,
      );
    });
  });

  suite("a renamed device keeps its name", getHarness => {
    let harness;
    let rename;
    let changed = [];
    before(async function () {
      this.timeout(360000);
      rename = declared("rename");
      if (rename === null) {
        return;
      }
      assert.strictEqual(
        rename,
        true,
        "fleet.json suites.rename is true (the fixture hooks honour INVENTORY_RENAME=1) or { none }",
      );
      harness = getHarness();
      await start(harness, FIRST_LANGUAGE);
      const names = objs =>
        Object.fromEntries(
          Object.entries(objs)
            .filter(([, o]) => o.type === "device" || o.type === "channel")
            .map(([id, o]) => [id, JSON.stringify(o.common?.name)]),
        );
      const before = names(await dumpObjects(harness));
      const renamed = async () => {
        const after = names(await dumpObjects(harness));
        return Object.keys(before).filter(id => id in after && after[id] !== before[id]);
      };
      process.env[RENAME_SWITCH] = "1";
      try {
        await restartAsTheHost(harness, null, "for the rename");
        await feedFixtures(harness);
        await waitForAdapterWork(harness);
        await waitWindow("D22 a renamed device follows", 10000, async () => (await renamed()).length > 0);
      } finally {
        delete process.env[RENAME_SWITCH];
      }
      changed = await renamed();
    });
    after(() => {
      delete process.env[RENAME_SWITCH];
    });

    it("carries the new name of a device the source renamed (D22)", function () {
      if (rename === null) {
        return;
      }
      assert.ok(
        changed.length > 0,
        `the fixture renamed a device (${RENAME_SWITCH}=1) and no device or channel name followed`,
      );
    });
  });

  // krobi 2026-10-16 07:36/07:38: a connection that shows true while no data arrives tells the user a lie — no
  // connection, then offline. info.connection tells whether data arrives; a rejected login that ends the data is no
  // connection, one the counterpart answers anyway (nut2 reads without authentication) is one.
  suite("a rejected login shows no connection", getHarness => {
    let harness;
    let reject;
    let verdict;
    before(async function () {
      this.timeout(360000);
      reject = declared("rejectLogin");
      if (reject === null) {
        return;
      }
      assert.strictEqual(
        reject,
        true,
        "fleet.json suites.rejectLogin is true (the fixture hooks honour INVENTORY_REJECT_LOGIN=1) or { none }",
      );
      harness = getHarness();
      const manifestIds = new Set((manifest.instanceObjects ?? []).map(o => `${NS}${o._id}`));
      process.env[REJECT_LOGIN_SWITCH] = "1";
      try {
        const since = Date.now();
        // no wait for a tree: after a rejected login none comes (red-proof run 2026-10-16 — the full start hung 6 min)
        clearInstanceData(harness);
        await resetInstanceNative(harness, await fixtureNative());
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        const restarts = playControllerRestarts(harness, null, ...NET);
        await withinDeadline(
          harness.startAdapterAndWait(false, adapterEnv(...NET)),
          FIRST_START_MS,
          "the adapter did not start with its login rejected",
        );
        await restarts.done;
        await waitWindow("D11 no data after a rejected login", QUIET_WINDOW_MS);
        const objects = await dumpObjects(harness);
        const states = await dumpStates(harness);
        const stamps = await stampsOf(harness, Object.keys(states));
        const connection = states[`${NS}info.connection`];
        // data = a value the counterpart sent: a state outside the manifest and outside info, written in this start with
        // ack and not its default
        const data = Object.entries(states).filter(
          ([id, s]) =>
            id.startsWith(NS) &&
            !id.startsWith(`${NS}info.`) &&
            !manifestIds.has(id) &&
            s?.ack === true &&
            stamps[id] >= since &&
            !EMPTY.has(s.val) &&
            s.val !== objects[id]?.common?.def,
        );
        verdict = { connection: connection?.val, data: data.length };
      } finally {
        delete process.env[REJECT_LOGIN_SWITCH];
      }
    });
    after(() => {
      delete process.env[REJECT_LOGIN_SWITCH];
    });

    it("shows info.connection true only while data still arrives (D11)", function () {
      if (reject === null) {
        return;
      }
      console.log(
        `      after a rejected login: info.connection ${JSON.stringify(verdict.connection)}, ${verdict.data} value(s) from the counterpart`,
      );
      assert.ok(
        !(verdict.connection === true && verdict.data === 0),
        "info.connection is true after a rejected login although no data arrived — no connection, then offline",
      );
    });
  });

  suite("a counterpart that answers wrong or refuses", getHarness => {
    let harness;
    const verdicts = {};
    const counts = { start: 0 };
    // every object the adapter deletes while a wrong answer is played — a delete followed by a re-creation in the same
    // window leaves no trace in a before/after comparison (red-proof run 2026-10-16)
    const deletions = [];
    const writes = [];
    let refusedCalls = [];
    let errorCalls = [];
    let errorSince = 0;
    // A cloud adapter asks at its start, then rides an event stream (homeconnect: no HTTP call in two minutes of
    // running, lab 2026-10-16) — so every wrong answer meets a restart as the host plays it, as on a real host whose
    // cloud answers wrong while the adapter comes up.
    before(async function () {
      this.timeout(
        6 * (START_MS + FAULT_CAP_MS + SETTLE_MS) + 2 * BACKOFF_WINDOW_MS + ERROR_WINDOWS * ERROR_WINDOW_MS + 240000,
      );
      if (NET.length === 0) {
        return;
      }
      harness = getHarness();
      const since = Date.now();
      await start(harness, FIRST_LANGUAGE, ...NET);
      counts.start = httpCalls(since);
      if (counts.start === 0) {
        return;
      }
      harness.on("objectChange", (id, obj) => {
        if (!obj && id.startsWith(NS)) {
          deletions.push([id, Date.now()]);
        }
      });
      harness.on("stateChange", (id, state) => {
        if (id === `system.adapter.${ADAPTER}.0.alive` && state?.from === "system.host.testing") {
          writes.push([GONE, false]);
        } else if (id.startsWith(NS) && state && state.from === `system.adapter.${ADAPTER}.0`) {
          writes.push([id, EMPTY.has(state.val)]);
        }
      });
      const clean = new Set(readRequests(since).map(r => r.key));
      const cleanStates = await dumpStates(harness);
      try {
        // round 163: the same restart with right answers, held until each value its new process emptied came back
        const cleanFrom = writes.length;
        await restartAsTheHost(harness, null, "with right answers", ...NET);
        const restarted = Date.now();
        await waitWindow("D6 a restart with right answers settles", SETTLE_MS);
        await waitWindow(
          "D6 the restart's emptied values come back",
          restarted + START_MS - Date.now(),
          () => restartEmpties(cleanStates, writes.slice(cleanFrom)).waiting.length === 0,
        );
        const restart = restartEmpties(cleanStates, writes.slice(cleanFrom)).lead;
        for (const mode of ["500", "empty", "drift"]) {
          const objects = await dumpObjects(harness);
          const states = await dumpStates(harness);
          fs.writeFileSync(FAULT_FLAG, mode);
          const at = Date.now();
          const from = writes.length;
          const old = pidsOf(".requests", since);
          await restartAsTheHost(harness, null, `with ${mode} answers`, ...NET);
          const met = () =>
            new Set(
              readRequests(at)
                .filter(r => r.fault === mode && !old.has(r.pid))
                .map(r => r.key),
            );
          let seen = 0;
          let lastNew = Date.now();
          const faultMet = () => {
            const now = met();
            if (now.size > seen) {
              seen = now.size;
              lastNew = Date.now();
            }
            if ([...clean].every(key => now.has(key))) {
              return true;
            }
            // the idle end only once the verdict below is met: a retry slower than the idle window is no fault of the
            // adapter, and cutting the hold before it would judge one
            const judged = [...now].filter(key => clean.has(key)).length >= Math.min(2, clean.size);
            return judged && Date.now() - lastNew >= FAULT_IDLE_MS;
          };
          await waitWindow(`D6 every request met with ${mode} answers`, at + FAULT_CAP_MS - Date.now(), faultMet, 2000);
          const reached = [...met()].filter(key => clean.has(key));
          fs.rmSync(FAULT_FLAG, { force: true });
          await waitWindow(`D6 settles after ${mode} answers`, SETTLE_MS);
          const after = await dumpStates(harness);
          const live = await dumpObjects(harness);
          verdicts[mode] = {
            reached,
            clean: clean.size,
            running: harness.isAdapterRunning(),
            deleted: [
              ...new Set([
                ...Object.keys(objects).filter(id => !(id in live)),
                ...deletions.filter(([id, when]) => when >= at && id in objects).map(([id]) => id),
              ]),
            ],
            emptied: [
              ...new Set([
                ...emptiedOf(cleanStates, states, after),
                ...emptiedDuring(cleanStates, states, writes.slice(from), restart),
              ]),
            ],
          };
          if (!verdicts[mode].running) {
            return;
          }
        }
        fs.writeFileSync(FAULT_FLAG, "429");
        const t1 = Date.now();
        const before429 = pidsOf(".calls", since);
        await restartAsTheHost(harness, null, "with 429 answers", ...NET);
        const refusedNow = () =>
          readCalls(t1).filter(c => c.kind === "http" && !c.hook && c.t >= t1 && !before429.has(c.pid));
        await waitWindow(
          "D21 a retry after a 429",
          t1 + BACKOFF_WINDOW_MS - Date.now(),
          () => retryTooEarly(refusedNow()).length > 0,
        );
        refusedCalls = refusedNow();
        fs.writeFileSync(FAULT_FLAG, "500all");
        errorSince = Date.now();
        const before500 = pidsOf(".calls", since);
        await restartAsTheHost(harness, null, "with a 500 to every answer", ...NET);
        const errorsNow = () =>
          readCalls(errorSince).filter(c => c.kind === "http" && !c.hook && c.t >= errorSince && !before500.has(c.pid));
        await waitWindow(
          "D21 calls under a series of errors",
          errorSince + ERROR_WINDOWS * ERROR_WINDOW_MS - Date.now(),
          () =>
            backoffSettled(
              errorCountsByHost(errorsNow(), errorSince),
              Math.floor((Date.now() - errorSince) / ERROR_WINDOW_MS),
            ),
        );
        errorCalls = errorsNow();
      } finally {
        fs.rmSync(FAULT_FLAG, { force: true });
      }
    });
    after(() => fs.rmSync(FAULT_FLAG, { force: true }));

    it("runs on and deletes or empties nothing on a 500, an empty 200 and drifted JSON (D6, C26b)", function () {
      if (NET.length === 0) {
        noNet("nothing to answer wrong");
        return;
      }
      if (counts.start === 0) {
        console.log("      the adapter makes no HTTP call — nothing to answer wrong");
        return;
      }
      const wrong = [];
      for (const [mode, v] of Object.entries(verdicts)) {
        console.log(`      ${mode}: ${v.reached.length} of ${v.clean} requests of a clean start answered wrong`);
        // past its first request: a login, a token or a discovery alone says nothing about the answers it acts on
        if (v.reached.length < Math.min(2, v.clean)) {
          wrong.push(
            `${mode}: the wrong answers reached ${v.reached.join(", ") || "no request"} of the ${v.clean} requests of a ` +
              "clean start — nothing past its first request was measured",
          );
        }
        if (!v.running) {
          wrong.push(`${mode}: the adapter stopped`);
        }
        wrong.push(...v.deleted.map(id => `${mode}: deleted ${id}`), ...v.emptied.map(id => `${mode}: emptied ${id}`));
      }
      assert.strictEqual(Object.keys(verdicts).length > 0, true, "no wrong answer was played");
      assert.deepStrictEqual(wrong, [], `while its HTTP counterpart answered wrong:\n${wrong.join("\n")}`);
    });

    it("waits the retry-after of a 429 before it calls that host again (D21)", function () {
      if (NET.length === 0) {
        noNet("nothing to refuse");
        return;
      }
      if (refusedCalls.length === 0) {
        console.log(`      no HTTP call in ${BACKOFF_WINDOW_MS} ms after a start answered with 429 — nothing to see`);
        return;
      }
      // network hook, section 7: every 429 says `retry-after: 60`; the calls of the first two seconds may be in flight
      // together, any later one before the minute is up ignores the rate limit (mcm1957: 429 is a rate limit)
      const early = retryTooEarly(refusedCalls);
      assert.deepStrictEqual(early, [], `calls before the retry-after of a 429 ran out:\n${early.join("\n")}`);
    });

    it("calls a host less often from minute to minute under a series of errors (D21)", function () {
      if (NET.length === 0) {
        noNet("nothing to answer with errors");
        return;
      }
      // a 500 to every answer for four minutes: the first minute holds the start, the second against the fourth is the
      // verdict — a host the adapter calls at least twice in the second minute and as often or more in the fourth gets no
      // backoff; a host called less is not measured here (printed, not judged)
      const byHost = errorCountsByHost(errorCalls, errorSince);
      const steady = [];
      for (const [host, counts] of byHost) {
        console.log(`      ${host}: ${counts.join(" / ")} call(s) per minute under a 500 to every answer`);
        if (counts[1] >= 2 && counts[ERROR_WINDOWS - 1] >= counts[1]) {
          steady.push(`${host}: ${counts.join(" / ")} call(s) per minute`);
        }
      }
      if (byHost.size === 0) {
        console.log("      no HTTP call under a 500 to every answer — nothing to see");
      }
      assert.deepStrictEqual(
        steady,
        [],
        `calls that did not get fewer under a series of errors (no backoff):\n${steady.join("\n")}`,
      );
    });
  });

  suite("one device gone while the channel lives", getHarness => {
    let harness;
    let drop;
    let verdict;
    before(async function () {
      this.timeout(360000);
      drop = declared("dropDevice");
      if (drop === null) {
        return;
      }
      assert.strictEqual(
        drop,
        true,
        "fleet.json suites.dropDevice is true (with INVENTORY_DROP_DEVICE=1 the fixture hooks keep one device listed and let it answer nothing) or { none }",
      );
      harness = getHarness();
      await start(harness, FIRST_LANGUAGE);
      const objects = await dumpObjects(harness);
      const markers = Object.entries(objects)
        .filter(
          ([id, o]) => o.type === "state" && String(o.common?.role ?? "") in STOPPED && id !== `${NS}info.connection`,
        )
        .map(([id, o]) => [id, STOPPED[o.common.role]]);
      const before = await dumpStates(harness);
      process.env[DROP_DEVICE_SWITCH] = "1";
      try {
        await restartAsTheHost(harness, null, "for the dropped device");
        await feedFixtures(harness);
        await waitForAdapterWork(harness);
        await waitWindow("D6 one device gone", FAULT_HOLD_MS);
      } finally {
        delete process.env[DROP_DEVICE_SWITCH];
      }
      const states = await dumpStates(harness);
      const live = await dumpObjects(harness);
      const down = devicesOf(newlyDown(markers, before, states), objects);
      verdict = {
        reachable: devicesOf(upBefore(markers, before), objects).length,
        down,
        deleted: Object.keys(objects).filter(id => !(id in live)),
        connection: states[`${NS}info.connection`]?.val,
      };
    });
    after(() => {
      delete process.env[DROP_DEVICE_SWITCH];
    });

    it("shows only the dropped device unreachable and deletes nothing (D6)", function () {
      if (drop === null) {
        return;
      }
      assert.ok(
        verdict.reachable >= 2,
        "fewer than two devices reachable before the drop — dropDevice needs a fixture with two (one recorded offline counts not)",
      );
      assert.strictEqual(
        verdict.down.length,
        1,
        `devices that went unreachable with the drop (the dropped one must be reachable before it): ${verdict.down.join(", ") || "none"}`,
      );
      assert.deepStrictEqual(
        verdict.deleted,
        [],
        `objects deleted after one device was dropped:\n${verdict.deleted.join("\n")}`,
      );
      assert.strictEqual(verdict.connection, true, "info.connection is not true while the channel lives");
    });
  });

  // The hang suites of the template end a process before a hung call is due (homeconnect: a command hangs 30 s, then
  // the stop — red-proof run 2026-10-16), so this suite starts once with every counterpart hung and holds the process
  // until each call of the first window has ended or is open past the deadline (hangDecided, round 157); the verdict
  // reads its records and those the hang suites left in RESOURCE_DIR.
  suite("every call to a hung counterpart ends", getHarness => {
    let since;
    before(async function () {
      this.timeout(START_MS + HANG_DEADLINE_MS + HANG_SLACK_MS + 60000);
      if (NET.length === 0) {
        return;
      }
      const harness = getHarness();
      clearInstanceData(harness);
      await resetInstanceNative(harness, await fixtureNative());
      await setSystemLanguage(harness, FIRST_LANGUAGE);
      fs.writeFileSync(HANG_FILE, "*");
      since = Date.now();
      try {
        const restarts = playControllerRestarts(harness, null, ...NET);
        await withinDeadline(
          harness.startAdapterAndWait(false, adapterEnv(...NET)),
          FIRST_START_MS,
          "the adapter did not start with every counterpart hung",
        );
        await restarts.done;
        const started = Date.now();
        const cap = since + START_MS + HANG_DEADLINE_MS + HANG_SLACK_MS;
        const decided = () => {
          const state = hangDecided(
            readCalls(since).filter(c => c.t >= since),
            HANG_SLACK_MS,
            HANG_DEADLINE_MS,
            Date.now(),
          );
          return state === "decided" || (state === "none" && Date.now() >= started + HANG_SLACK_MS);
        };
        await waitWindow("D21 every hung call decided", cap - Date.now(), decided);
      } finally {
        fs.rmSync(HANG_FILE, { force: true });
      }
    });
    after(() => fs.rmSync(HANG_FILE, { force: true }));

    it("ends every call to a hung counterpart within the deadline (D21)", function () {
      if (NET.length === 0) {
        noNet("nothing to hang");
        return;
      }
      const own = readCalls(since).filter(c => c.t >= since && c.kind === "hang-start").length;
      if (own === 0) {
        console.log("      no call while every counterpart hung — nothing of its own to judge");
      }
      // Judged per process (<pid>.calls): a call the regular stop of its process cut off never ends either — only a
      // process that lived past start + deadline owes the end (lab run 2026-10-16). How long it lived is its pulse
      // (network hook, <pid>.alive): a process blocked on the hung call writes no record after it (red-proof run).
      const late = [];
      // every process of the run (RUN_WIDE "every")
      const byProcess = new Map();
      for (const c of recordLines(RESOURCE_DIR, ".calls")) {
        byProcess.set(c.pid, [...(byProcess.get(c.pid) ?? []), c]);
      }
      for (const [pid, calls] of byProcess) {
        let lastSeen = calls.at(-1)?.t ?? 0;
        try {
          const beat = Number(fs.readFileSync(path.join(RESOURCE_DIR, `${pid}.alive`), "utf8"));
          lastSeen = Math.max(lastSeen, Number.isFinite(beat) ? beat : 0);
        } catch {
          // a process without the network hook has no pulse — its records are all there is
        }
        const open = new Map();
        for (const c of calls) {
          const key = `${c.host} ${c.port}`;
          if (c.kind === "hang-start") {
            open.set(key, [...(open.get(key) ?? []), c.t]);
          } else if (c.kind === "hang-end") {
            const began = (open.get(key) ?? []).shift();
            if (began !== undefined && c.t - began > HANG_DEADLINE_MS) {
              late.push(`${key}: ended after ${c.t - began} ms`);
            }
          }
        }
        for (const [key, starts] of open) {
          late.push(...starts.filter(s => lastSeen > s + HANG_DEADLINE_MS).map(() => `${key}: never ended`));
        }
      }
      assert.deepStrictEqual(
        late,
        [],
        `calls to a hung counterpart that did not end within ${HANG_DEADLINE_MS} ms:\n${late.join("\n")}`,
      );
    });
  });

  // No start of its own: the template's suite "a command nobody answers stays unconfirmed" writes every writable state
  // once; the resource probe notes each state the adapter's stateChange got.
  suite("every writable datapoint reaches the adapter", () => {
    it("hands every writable datapoint of the inventory to the adapter (D10)", function () {
      const inventory = JSON.parse(fs.readFileSync(path.join(ADAPTER_DIR, "test", "objects.inventory.json"), "utf8"));
      const writable = Object.entries(inventory)
        .filter(([, o]) => o?.type === "state" && o.common?.write === true)
        .map(([id]) => id);
      if (writable.length === 0) {
        console.log("      the inventory holds no writable datapoint — nothing to hand over");
        return;
      }
      const delivered = new Set(probeLines(".delivered").map(r => r.id));
      assert.ok(
        delivered.size > 0,
        'no write reached the adapter in this run — the suite "a command nobody answers stays unconfirmed" did not play its commands',
      );
      const missed = writable.filter(id => !delivered.has(id));
      assert.deepStrictEqual(
        missed,
        [],
        `writable datapoints whose write never reached the adapter's stateChange (not subscribed):\n${missed.join("\n")}`,
      );
    });
  });

  // Round 157 (fleet-suite audit): the records of the WHOLE run, read after its last start — in the first suite they saw
  // only the stops and network records up to there; every later stop (language, group switch, rename, the six processes of
  // the wrong answers, the dropped device, the hang) went unjudged. No start of its own.
  suite("the whole run", () => {
    it("writes nothing after its unload callback, in any stop of the run (D4)", function () {
      // resource probe: a write after the callback never reaches the database
      const records = probeLines(".unload");
      const late = [...new Set(records.filter(r => r.kind === "write").map(r => `${r.via} ${r.id}`))];
      if (!records.some(r => r.kind === "callback")) {
        console.log("      no stop of this run called its unload callback — js-controller ended it after stopTimeout");
      }
      assert.deepStrictEqual(
        late,
        [],
        `written after the unload callback (lost — callback() comes after the last write):\n${late.join("\n")}`,
      );
    });

    it("sends no datagram to 255.255.255.255 — a broadcast comes from address and netmask (D17)", function () {
      const wide = [
        ...new Set(
          netRecords()
            .filter(r => r.kind === "send" && r.host === "255.255.255.255")
            .map(r => `port ${r.port}`),
        ),
      ];
      assert.deepStrictEqual(wide, [], `datagrams to the limited broadcast address:\n${wide.join("\n")}`);
    });

    it("names only the chosen address of this machine to others (D17)", function () {
      const other = [
        ...new Set(
          netRecords()
            .filter(r => r.kind === "advertise" && r.address !== CHOSEN_ADDRESS)
            .map(r => `${r.via} ${r.address}`),
        ),
      ];
      assert.deepStrictEqual(
        other,
        [],
        `addresses of this machine named to others that are not the chosen one (${CHOSEN_ADDRESS}):\n${other.join("\n")}`,
      );
    });
  });
};
module.exports.workshopMutexProblem = workshopMutexProblem;
module.exports.withProtocol = withProtocol;
module.exports.timed = timed;
module.exports.workWaitOf = workWaitOf;
module.exports.waitWindow = waitWindow;
module.exports.spacingOf = spacingOf;
module.exports.newlyDown = newlyDown;
module.exports.upBefore = upBefore;
module.exports.emptiedOf = emptiedOf;
module.exports.devicesOf = devicesOf;
module.exports.stampsOf = stampsOf;
module.exports.droppedPress = droppedPress;
module.exports.hangDecided = hangDecided;
module.exports.errorCountsByHost = errorCountsByHost;
module.exports.backoffSettled = backoffSettled;
module.exports.emptiedDuring = emptiedDuring;
module.exports.restartEmpties = restartEmpties;
module.exports.retryTooEarly = retryTooEarly;
module.exports.sameIds = sameIds;
module.exports.recordFiles = recordFiles;
module.exports.recordLines = recordLines;
module.exports.stateText = stateText;
module.exports.leftBehind = leftBehind;
module.exports.tally = tally;
// Round 165: the suites that judge the records of the whole run — pre-release.py's run of single suites reads it through
// scripts/inventory-suites.mjs. "every" judges each record of every process (it runs along with every partial run, and a
// move of its own code runs D06 whole); a list names the suites whose records it needs (it runs with them, and they with
// it). Every other suite that reads an earlier suite's records needs every suite before it.
module.exports.RUN_WIDE = {
  "every call to a hung counterpart ends": "every",
  "every writable datapoint reaches the adapter": ["a command nobody answers stays unconfirmed"],
  "the whole run": "every",
};
