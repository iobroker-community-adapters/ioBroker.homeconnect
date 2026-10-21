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
//                                       error · D9 a button falls back to false, confirmed · D4 the stop leaves every
//                                       marker offline, every reason text `Unknown`, the sums at 0/false, and nothing is
//                                       written after the unload callback (resource probe) · D17 no datagram to
//                                       255.255.255.255, and every own address it names to others is the chosen one
//                                       (network hook, section 8 — the records of every suite before count too)
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
//                                       deletes no object and empties no value, each met by a restart (network hook,
//                                       section 7 `fault`: the first answer to each request wrong, the repeat right),
//                                       red as well when the wrong answers reached no request past the first one of a
//                                       clean start · D21 after a 429 with retry-after 60 no call to that host before
//                                       the minute is up · D21 under a series of errors (a 500 to every answer) the calls
//                                       to a host get fewer from minute to minute
//   "one device gone while the channel lives" D6 one device stays in the account's list and stops answering: only
//                                       that one goes unreachable (a marker already down before counts not)
//   "every call to a hung counterpart ends" D21 a start with every counterpart hung, held past the deadline: every
//                                       call that hung — there and in the hang suites of the template — ended within
//                                       the deadline while its process lived
//   "every writable datapoint reaches the adapter" D10 (no start) every writable state of the inventory reached the
//                                       adapter's stateChange in this run (resource probe; the commands of the
//                                       template's suite "a command nobody answers stays unconfirmed")
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");

// D7: how long the run stays watched after its start is done — several cycles of every fleet poll.
const QUIET_WINDOW_MS = 60000;
// D9: how long a pressed button may take to fall back.
const PRESS_WINDOW_MS = 15000;
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
// D6/C26b: how long each wrong answer lasts — several cycles of every fleet poll; D21: the window the calls are counted in.
const FAULT_HOLD_MS = 60000;
// D6/C26b (round 124, red-proof run 2026-10-16): a wrong answer lasts until every request of a clean start met one, or
// no new request met one for longer than a 60 s backoff, at most three minutes.
const FAULT_IDLE_MS = 70000;
const FAULT_CAP_MS = 180000;
const BACKOFF_WINDOW_MS = 120000;
const SETTLE_MS = 10000;
const START_MS = 60000;
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
        return `the workshop mutex (${locks}) is not held — start the run through with-werkstatt-lock.py`;
      }
      if (probe.status !== LOCKF_HELD) {
        return `the workshop mutex (${locks}) cannot be probed (lockf: ${probe.error?.message ?? `exit ${probe.status}`})`;
      }
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(path.join(locks, "werkstatt-pruefung.holder.json"), "utf8")).pid;
      } catch {
        return `the workshop mutex (${locks}) is held, but names no holder — start the run through with-werkstatt-lock.py`;
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

module.exports = function fleetSuites(suite, ctx) {
  const mutexProblem = workshopMutexProblem(ctx.ADAPTER_DIR);
  if (mutexProblem) {
    throw new Error(mutexProblem);
  }
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
    restartAsTheHost,
    adapterEnv,
    feedFixtures,
    waitForAdapterWork,
    dumpObjects,
    dumpStates,
    withinDeadline,
    readCalls,
    RESOURCE_DIR,
    HANG_DEADLINE_MS,
    CHOSEN_ADDRESS,
  } = ctx;
  const netRecords = () =>
    fs
      .readdirSync(RESOURCE_DIR)
      .filter(f => f.endsWith(".net"))
      .flatMap(f =>
        fs
          .readFileSync(path.join(RESOURCE_DIR, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map(l => JSON.parse(l)),
      )
      .filter(r => !r.hook);
  const FAULT_FLAG = path.join(RESOURCE_DIR, "fault");
  // network hook, section 4: `*` lets every counterpart hang
  const HANG_FILE = path.join(RESOURCE_DIR, "hang");
  // an adapter without a counterpart carries no network hook (counterpart.none in its sealed register, round 87)
  const NET = fs.existsSync(NETWORK_HOOK) ? [NETWORK_HOOK] : [];
  const noNet = what => {
    console.log(`      no test/network-hook.js — the adapter has no counterpart, ${what}`);
  };
  const httpCalls = (from, until = Infinity) =>
    readCalls().filter(c => c.kind === "http" && c.t >= from && c.t < until && !c.hook).length;
  // network hook: the JSON lines every process of the run wrote into RESOURCE_DIR/<pid><suffix>
  const probeLines = suffix =>
    fs
      .readdirSync(RESOURCE_DIR)
      .filter(f => f.endsWith(suffix))
      .flatMap(f =>
        fs
          .readFileSync(path.join(RESOURCE_DIR, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map(l => JSON.parse(l)),
      );
  const stateIds = objects => new Set(Object.keys(objects).filter(id => objects[id]?.type === "state"));
  // network hook, section 7: every HTTP request of the adapter with the fault it met
  const readRequests = (from, until = Infinity) =>
    fs
      .readdirSync(RESOURCE_DIR)
      // a file last written before `from` holds nothing after it — the run's earlier starts are not read again
      .filter(f => f.endsWith(".requests") && fs.statSync(path.join(RESOURCE_DIR, f)).mtimeMs >= from)
      .flatMap(f =>
        fs
          .readFileSync(path.join(RESOURCE_DIR, f), "utf8")
          .split("\n")
          .filter(Boolean)
          .map(l => JSON.parse(l)),
      )
      .filter(r => r.t >= from && r.t < until);
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
    await harness.startAdapterAndWait(false, adapterEnv(...hooks));
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
      await sleep(QUIET_WINDOW_MS);
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
      // every button at once, one window for all — pressed one by one, 72 buttons took 18 minutes (homeconnect lab copy)
      for (const id of buttons) {
        await harness.states.setStateAsync(id, { val: true, ack: false });
      }
      const deadline = Date.now() + PRESS_WINDOW_MS;
      let stuck = buttons;
      while (stuck.length > 0 && Date.now() < deadline) {
        await sleep(500);
        const states = await harness.states.getStates(stuck);
        stuck = stuck.filter((id, i) => !(states[i]?.val === false && states[i]?.ack === true));
      }
      const shown = [];
      for (const id of stuck) {
        const s = await harness.states.getStateAsync(id);
        shown.push(`${id} = ${JSON.stringify(s?.val)} ack ${s?.ack}`);
      }
      assert.deepStrictEqual(
        shown,
        [],
        `buttons that did not fall back to false with ack within ${PRESS_WINDOW_MS} ms:\n${shown.join("\n")}`,
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
      this.timeout(2 * ANSWER_MS + 10000 + spacing);
      const there = await ask(harness, test.command, test.message ?? {});
      await sleep(spacing);
      let cut;
      fs.writeFileSync(OUTAGE_FLAG, "");
      try {
        cut = await ask(harness, test.command, test.message ?? {});
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
        const leaf = rel.split(".").at(-1);
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

    it("writes nothing after its unload callback (D4)", function () {
      // resource probe: every stop of this run — a write after the callback never reaches the database
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
  });

  suite("answers in the system language", getHarness => {
    let harness;
    let test;
    let cut;
    before(async function () {
      this.timeout(240000);
      test = declared("connectionTest");
      if (test === null) {
        return;
      }
      harness = getHarness();
      await start(harness, SECOND_LANGUAGE, ...NET);
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
      process.env[RENAME_SWITCH] = "1";
      try {
        await restartAsTheHost(harness, null, "for the rename");
        await feedFixtures(harness);
        await waitForAdapterWork(harness);
        await sleep(10000);
      } finally {
        delete process.env[RENAME_SWITCH];
      }
      const after = names(await dumpObjects(harness));
      changed = Object.keys(before).filter(id => id in after && after[id] !== before[id]);
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
        await harness.startAdapterAndWait(false, adapterEnv(...NET));
        await restarts.done;
        await sleep(QUIET_WINDOW_MS);
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
    let refusedCalls = [];
    let errorCalls = [];
    let errorSince = 0;
    // A cloud adapter asks at its start, then rides an event stream (homeconnect: no HTTP call in two minutes of
    // running, lab 2026-10-16) — so every wrong answer meets a restart as the host plays it, as on a real host whose
    // cloud answers wrong while the adapter comes up.
    before(async function () {
      this.timeout(
        5 * (START_MS + FAULT_CAP_MS + SETTLE_MS) + 2 * BACKOFF_WINDOW_MS + ERROR_WINDOWS * ERROR_WINDOW_MS + 240000,
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
      const clean = new Set(readRequests(since).map(r => r.key));
      try {
        for (const mode of ["500", "empty", "drift"]) {
          const objects = await dumpObjects(harness);
          const states = await dumpStates(harness);
          fs.writeFileSync(FAULT_FLAG, mode);
          const at = Date.now();
          await restartAsTheHost(harness, null, `with ${mode} answers`, ...NET);
          const met = () =>
            new Set(
              readRequests(at)
                .filter(r => r.fault === mode)
                .map(r => r.key),
            );
          let seen = 0;
          let lastNew = Date.now();
          while (Date.now() - at < FAULT_CAP_MS) {
            await sleep(2000);
            const now = met();
            if (now.size > seen) {
              seen = now.size;
              lastNew = Date.now();
            }
            if ([...clean].every(key => now.has(key))) {
              break;
            }
            // the idle end only once the verdict below is met: a retry slower than the idle window is no fault of the
            // adapter, and cutting the hold before it would judge one
            const judged = [...now].filter(key => clean.has(key)).length >= Math.min(2, clean.size);
            if (judged && Date.now() - lastNew >= FAULT_IDLE_MS) {
              break;
            }
          }
          const reached = [...met()].filter(key => clean.has(key));
          fs.rmSync(FAULT_FLAG, { force: true });
          await sleep(SETTLE_MS);
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
            emptied: Object.keys(states).filter(
              id => !EMPTY.has(states[id]?.val) && (!(id in after) || EMPTY.has(after[id]?.val)),
            ),
          };
          if (!verdicts[mode].running) {
            return;
          }
        }
        fs.writeFileSync(FAULT_FLAG, "429");
        const t1 = Date.now();
        await restartAsTheHost(harness, null, "with 429 answers", ...NET);
        await sleep(BACKOFF_WINDOW_MS);
        refusedCalls = readCalls().filter(c => c.kind === "http" && !c.hook && c.t >= t1);
        fs.writeFileSync(FAULT_FLAG, "500all");
        errorSince = Date.now();
        await restartAsTheHost(harness, null, "with a 500 to every answer", ...NET);
        await sleep(Math.max(0, errorSince + ERROR_WINDOWS * ERROR_WINDOW_MS - Date.now()));
        errorCalls = readCalls().filter(c => c.kind === "http" && !c.hook && c.t >= errorSince);
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
      const early = [];
      const byHost = new Map();
      for (const c of refusedCalls) {
        byHost.set(c.host, [...(byHost.get(c.host) ?? []), c.t]);
      }
      for (const [host, times] of byHost) {
        const first = Math.min(...times);
        const again = times.filter(
          when => when > first + RETRY_GRACE_MS && when < first + RETRY_AFTER_MS - RETRY_GRACE_MS,
        );
        if (again.length > 0) {
          early.push(
            `${host}: ${again.length} call(s), the first ${again[0] - first} ms after a 429 with retry-after 60`,
          );
        }
      }
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
      const byHost = new Map();
      for (const c of errorCalls) {
        const w = Math.floor((c.t - errorSince) / ERROR_WINDOW_MS);
        if (w < ERROR_WINDOWS) {
          const counts = byHost.get(c.host) ?? new Array(ERROR_WINDOWS).fill(0);
          counts[w]++;
          byHost.set(c.host, counts);
        }
      }
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
        await sleep(FAULT_HOLD_MS);
      } finally {
        delete process.env[DROP_DEVICE_SWITCH];
      }
      const states = await dumpStates(harness);
      const live = await dumpObjects(harness);
      const down = newlyDown(markers, before, states);
      verdict = {
        reachable: upBefore(markers, before).length,
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
  // past the deadline; the verdict reads its records and those the hang suites left in RESOURCE_DIR.
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
        await harness.startAdapterAndWait(false, adapterEnv(...NET));
        await restarts.done;
        await sleep(Math.max(0, since + HANG_DEADLINE_MS + HANG_SLACK_MS - Date.now()));
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
      const own = readCalls().filter(c => c.t >= since && c.kind === "hang-start").length;
      if (own === 0) {
        console.log("      no call while every counterpart hung — nothing of its own to judge");
      }
      // Judged per process (<pid>.calls): a call the regular stop of its process cut off never ends either — only a
      // process that lived past start + deadline owes the end (lab run 2026-10-16). How long it lived is its pulse
      // (network hook, <pid>.alive): a process blocked on the hung call writes no record after it (red-proof run).
      const late = [];
      for (const file of fs.readdirSync(RESOURCE_DIR).filter(f => f.endsWith(".calls"))) {
        const calls = fs
          .readFileSync(path.join(RESOURCE_DIR, file), "utf8")
          .split("\n")
          .filter(Boolean)
          .map(l => JSON.parse(l));
        let lastSeen = calls.at(-1)?.t ?? 0;
        try {
          const beat = Number(
            fs.readFileSync(path.join(RESOURCE_DIR, `${file.slice(0, -".calls".length)}.alive`), "utf8"),
          );
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
};
module.exports.workshopMutexProblem = workshopMutexProblem;
module.exports.spacingOf = spacingOf;
module.exports.newlyDown = newlyDown;
module.exports.upBefore = upBefore;
module.exports.stampsOf = stampsOf;
