/* global it, before, after */
"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller,
//   drive it with fixtures covering EVERY appliance type Home Connect knows
//   (test/fixtures/inventory/*.json, derived from the verbatim type source
//   Ressourcen/homeconnect/upstream-refs/api-value-types.ts — not the maintainer's
//   own three appliances), then dump every homeconnect.0.* object to
//   test/objects.inventory.json in the ioBroker object-structure bot's format.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is
//   set — pre-release.py exports the last tag's inventory).
//
// The adapter is a pure cloud client, so the fixtures reach it through the
// ENVIRONMENT: NODE_OPTIONS=--require test/inventory-fetch-hook.cjs replaces
// global fetch inside the adapter process and refuses every unknown address.
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
// Value dumps for the readable-values judge (`iobroker-adapter-checks values`): the states after the
// fixture run, and the objects once more after a restart in a second system language. Generated, not
// committed — timestamps and counters would make a golden file drift on every run.
const STATES_INVENTORY = path.join(__dirname, "states.inventory.json");
const OBJECTS_SECOND_LANGUAGE = path.join(__dirname, "objects.inventory.de.json");
const FIRST_LANGUAGE = "en";
const SECOND_LANGUAGE = "de";
const HOOK = path.join(__dirname, "inventory-fetch-hook.cjs");
const FIXTURE_DIR = path.join(__dirname, "fixtures", "inventory");
const APPLIANCE_COUNT = fs.readdirSync(FIXTURE_DIR).filter(f => f.endsWith(".json")).length;
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
// in memory; a database read of one in the quiet window after the verdict is a finding.
const READ_ONLY = new Set();

/**
 * The environment of every adapter start: the resource probe first, then the test hooks of this adapter.
 *
 * @param {...string} hooks absolute paths of `--require` hooks (fixture servers, DNS)
 * @returns {Record<string, string>} the environment
 */
function adapterEnv(...hooks) {
  return {
    NODE_OPTIONS: [RESOURCE_PROBE, ...hooks].map(file => `--require ${file}`).join(" "),
    RESOURCE_PROBE_DIR: RESOURCE_DIR,
    RESOURCE_PROBE_NS: NS,
  };
}

/**
 * Every object write of the adapter in this suite, and which of them changed nothing (round 61). An unchanged
 * rewrite still goes to the database and to every subscriber — the adapter writes only what differs. The FIRST
 * write of an `instanceObjects` entry is js-controller's own (`_createInstancesObjects` extends every entry before
 * `onReady`, 7.2.2) and not the adapter's choice. Called as the suite's first await, so the start is watched from
 * its first write; the known content comes from the database, a seed included.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness the running harness
 * @returns {Promise<object>} the watch
 */
async function watchObjectWrites(harness) {
  const watch = { writes: new Map(), peak: new Map(), unchanged: [], deleted: [], times: [], unchangedIndicators: [] };
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
  harness.on("stateChange", (id, state) => {
    if (!id.startsWith(NS) || !state || state.from !== `system.adapter.${ADAPTER}.0`) {
      return;
    }
    const now =
      state.val !== null && typeof state.val === "object" ? null : canonical([state.val, state.ack, state.q, state.c]);
    if (now !== null && states.get(id) === now && String(roles.get(id)).startsWith("indicator")) {
      watch.unchangedIndicators.push(id);
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
 * Adapter-specific config the fixtures need. The values only ever reach the fake endpoint; the
 * Client ID has the portal's form (64 hexadecimal characters) — any other form draws a warning.
 */
const FIXTURE_NATIVE = {
  clientID: "F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7",
  clientSecret: "fixture-client-secret",
};

/**
 * Wait for a STATE of the adapter, never for "the tree stopped growing": the
 * per-appliance syncs are staggered, so a quiet moment can mean "four appliances
 * still only have their skeleton" — a green inventory without the very datapoints
 * the gate exists for.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness the running harness
 */
async function waitForEveryAppliance(harness) {
  // Since 1.20.0 the adapter spaces its REST requests 100 ms apart (the API's
  // 10/s limit). Against the instant fixture server that spacing IS the pass:
  // ~40 requests per appliance × 17 appliances ≈ 70 s before the last
  // appliance is online. Real clouds answer slower than the spacing, so users
  // never wait for it — the fixture does.
  //
  // The criterion is devicesOnline, not devicesTotal: a start stamps every known
  // appliance offline, and only THIS run's sync brings them online. devicesTotal
  // is written at start from the device objects already in the database — on the
  // upgrade suite's seeded tree it read 17 before any sync ran, and the suite
  // checked a tree the new version had not built yet.
  const deadline = Date.now() + 300000;
  for (;;) {
    const online = await harness.states.getStateAsync(`${NS}info.devicesOnline`);
    if (online && online.val === APPLIANCE_COUNT) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`only ${online ? online.val : 0} of ${APPLIANCE_COUNT} appliances came online in this run`);
    }
    await new Promise(r => setTimeout(r, 250));
  }
  // Every appliance is known; now let the per-appliance resources settle.
  let previous = -1;
  for (;;) {
    const count = Object.keys(await dumpObjects(harness)).length;
    if (count === previous) {
      return;
    }
    previous = count;
    await new Promise(r => setTimeout(r, 1000));
  }
}

/**
 * Adapter-specific: make the adapter create every object it can create.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness the running harness
 */
async function feedFixtures(harness) {
  await waitForEveryAppliance(harness);
}

/**
 * Upgrade suite: wait until the start chain has run to its end on top of the SEEDED tree. The seed writes objects,
 * never values; the two values below are written by this run only. `info.devicesOnline` is flushed once at the end
 * of the whole appliance pass (the start stamps every appliance offline first), and `info.connection` turns true
 * only after the pass, the subscription and the event stream — the last step of the chain. The fixture stream sends
 * one keep-alive and nothing else, so nothing is written after it.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness the running harness
 */
async function waitForAdapterWork(harness) {
  const deadline = Date.now() + 300000;
  for (;;) {
    const online = await harness.states.getStateAsync(`${NS}info.devicesOnline`);
    const connection = await harness.states.getStateAsync(`${NS}info.connection`);
    if (online && online.val === APPLIANCE_COUNT && connection && connection.val === true) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no completed start chain — ${online ? online.val : 0} of ${APPLIANCE_COUNT} appliances online, ` +
          `connection ${connection ? connection.val : "unset"}`,
      );
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

/**
 * Dump every object of the instance in the object-structure bot's format.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness the running harness
 * @returns {Promise<Record<string, unknown>>} id → object, sorted, without volatile fields
 */
async function dumpObjects(harness) {
  // The range starts at "homeconnect.0." — the instance root object itself is not part of the tree.
  const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  const out = {};
  for (const row of list.rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const obj = { ...row.value };
    for (const key of VOLATILE) {
      delete obj[key];
    }
    out[row.id] = obj;
  }
  return out;
}

/**
 * Set the throwaway controller's system language — what the adapter reads from `system.config`.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness the running harness
 * @param {string} language an ioBroker language code
 */
async function setSystemLanguage(harness, language) {
  const config = await harness.objects.getObject("system.config");
  config.common.language = language;
  await harness.objects.setObject("system.config", config);
}

/**
 * Dump the value of every state of the instance: `{ "<id>": { val, ack } }`, sorted.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness the running harness
 * @returns {Promise<Record<string, {val: unknown, ack: boolean}>>} id → value
 */
async function dumpStates(harness) {
  const keys = (await harness.states.getKeys(`${NS}*`)).sort();
  const values = await harness.states.getStates(keys);
  const out = {};
  keys.forEach((key, i) => {
    if (values[i]) {
      out[key] = { val: values[i].val, ack: values[i].ack };
    }
  });
  return out;
}

/**
 * The throwaway js-controller keeps its instance object between runs, and changeAdapterConfig only
 * EXTENDS native — a key that an older version of this adapter wrote would survive and trigger the
 * start-up key migration and with it a host restart (played since round 64) in every suite. Null every key the
 * fixture does not know, then apply the fixture (null is the post-migration state of a renamed key).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness the running harness
 */
async function resetInstanceNative(harness) {
  const instance = await harness.objects.getObjectAsync(`system.adapter.${ADAPTER}.0`);
  const stale = {};
  for (const key of Object.keys(instance?.native ?? {})) {
    if (!Object.hasOwn(FIXTURE_NATIVE, key)) {
      stale[key] = null;
    }
  }
  await harness.changeAdapterConfig(ADAPTER, { native: { ...stale, ...FIXTURE_NATIVE } });
}

/**
 * js-controller 7.2.2 restarts an instance on EVERY change of its instance object while it runs (controller main.ts,
 * objects `change` handler: `stopInstance`, then `startInstance` after `stopTimeout` + 2.5 s) — whoever wrote it, the
 * adapter's own settings migration or device table included. The harness has no host; this plays it (round 64): the
 * first change while the adapter runs stops it and starts it once more with the same hooks, so what the adapter did
 * after that write in the same start is cut off here as it is on a real host. A change after that restart is a finding:
 * on a host the instance would restart again, for good.
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness the running harness
 * @param {object | null} watch the suite's write watcher (watchObjectWrites), null in a suite without one
 * @param {...string} hooks the test hooks the suite starts the adapter with (as for adapterEnv)
 * @returns {{count: number, again: number[], done: Promise<void>}} the restart record
 */
function playControllerRestarts(harness, watch, ...hooks) {
  const restarts = { count: 0, again: [], done: Promise.resolve() };
  harness.on("objectChange", id => {
    if (id !== `system.adapter.${ADAPTER}.0` || !harness.isAdapterRunning()) {
      return;
    }
    if (restarts.count > 0) {
      restarts.again.push(Date.now());
      return;
    }
    restarts.count++;
    restarts.done = (async () => {
      await harness.stopAdapter();
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
      assert.ok(
        !harness.didAdapterStop(),
        "@iobroker/testing changed its exit marker — the restart play needs a new form",
      );
      await harness.startAdapterAndWait(false, adapterEnv(...hooks));
    })();
  });
  return restarts;
}

/** Round 64: the host's wait before it starts a stopped instance again (controller main.ts, `stopTimeout || 500` + 2.5 s). */
const RESTART_DELAY_MS = (require(path.join(ADAPTER_DIR, "io-package.json")).common.stopTimeout || 500) + 2500;
/** Round 64: the recording marker every seeded state carries in `common.custom`, naming the id it was seeded under. */
const RECORDING = "inventory-recording.0";

/**
 * Seed the previous release's objects before the start. Every state carries a recording marker (round 64): what hangs
 * on a datapoint is the user's — it goes on with the SAME datapoint (its id, or the one id a move gives it), never onto
 * a new datapoint, and never decides what the adapter creates, keeps or deletes (that shows up as a leftover or a
 * missing object against the committed inventory).
 *
 * @param {import("@iobroker/testing").IntegrationTestHarness} harness the running harness
 * @param {Record<string, any>} previous the previous release's inventory
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

tests.integration(ADAPTER_DIR, {
  controllerVersion: "stable",
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      let watch;
      let restarts;
      before(async function () {
        this.timeout(360000);
        harness = getHarness();
        watch = await watchObjectWrites(harness);
        await resetInstanceNative(harness);
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        restarts = playControllerRestarts(harness, watch, HOOK);
        await harness.startAdapterAndWait(false, adapterEnv(HOOK));
        await feedFixtures(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
      });

      it("writes test/objects.inventory.json", async function () {
        this.timeout(60000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
      });

      it("writes test/states.inventory.json", async function () {
        this.timeout(60000);
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

      it("rewrites no indicator state unchanged", function () {
        const idle = [...new Set(watch.unchangedIndicators)];
        assert.deepStrictEqual(idle, [], `indicator states written without a change:\n${idle.join("\n")}`);
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });

      it("covers every appliance type Home Connect knows", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        const devices = Object.values(objects).filter(o => o.type === "device");
        assert.strictEqual(
          devices.length,
          APPLIANCE_COUNT,
          "the inventory must prove the datapoints of appliances the maintainer does not own",
        );
      });
    });

    // The same run once more in a second system language: a label that stays the same in both was never
    // translated. A suite of its own — the harness starts an adapter only once per suite.
    suite("second system language", getHarness => {
      let harness;
      let restarts;
      before(async function () {
        this.timeout(360000);
        harness = getHarness();
        await resetInstanceNative(harness);
        await setSystemLanguage(harness, SECOND_LANGUAGE);
        restarts = playControllerRestarts(harness, null, HOOK);
        await harness.startAdapterAndWait(false, adapterEnv(HOOK));
        await feedFixtures(harness);
        await restarts.done;
        await waitForAdapterWork(harness);
      });

      it("restarts at most once for its own instance object", function () {
        assert.deepStrictEqual(restarts.again, [], "the instance object changed again after the restart it caused");
      });

      it("writes test/objects.inventory.de.json", async function () {
        this.timeout(60000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(OBJECTS_SECOND_LANGUAGE, `${JSON.stringify(objects, null, 2)}\n`);
      });
    });

    const previousFile = process.env.INVENTORY_PREVIOUS;
    if (previousFile && fs.existsSync(previousFile)) {
      suite("upgrade from the previous release", getHarness => {
        let harness;
        let watch;
        let restarts;
        let verdictAt;
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(360000);
          harness = getHarness();
          watch = await watchObjectWrites(harness);
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          await seedPrevious(harness, previous);
          await resetInstanceNative(harness);
          // The inventory was written in FIRST_LANGUAGE: labels the adapter localises itself (`states`) only
          // compare in the same language.
          await setSystemLanguage(harness, FIRST_LANGUAGE);
          restarts = playControllerRestarts(harness, watch, HOOK);
          await harness.startAdapterAndWait(false, adapterEnv(HOOK));
          await feedFixtures(harness);
          await waitForAdapterWork(harness);
          // A migration that wrote the instance object restarts the instance (round 64) — the verdict comes after
          // the second start has done its work.
          await restarts.done;
          await waitForAdapterWork(harness);
          verdictAt = Date.now();
          fs.writeFileSync(
            path.join(RESOURCE_DIR, "window.json"),
            JSON.stringify({ start: verdictAt, end: verdictAt + SETTLE_MS }),
          );
        });

        it("every current object carries the current texts and roles", async function () {
          this.timeout(60000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const stale = [];
          for (const [id, obj] of Object.entries(current)) {
            const got = live[id];
            if (!got) {
              stale.push(`${id}: missing after upgrade`);
              continue;
            }
            // Every field of `common`, not a chosen few: the adapter writes only what differs (round 61), so
            // every changed field must reach an existing installation.
            for (const f of new Set([...Object.keys(obj.common ?? {}), ...Object.keys(got.common ?? {})])) {
              if (f === "custom") {
                continue; // the user's recording — judged on its own below (round 64)
              }
              if (canonical(got.common?.[f]) !== canonical(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
            // The object's KIND (state/channel/device/folder) sits one level ABOVE
            // `common`; `common.type` is the VALUE type and something else
            // entirely — they only share a name. Without this a failed type migration
            // stays green while every datapoint under the wrong container is an E2001.
            if (got.type !== obj.type) {
              stale.push(`${id}: type still ${JSON.stringify(got.type)}, want ${JSON.stringify(obj.type)}`);
            }
          }
          assert.deepStrictEqual(stale, [], `objects an update did not reach:\n${stale.join("\n")}`);
        });

        it("objects the release removed are gone (no leftovers)", async function () {
          this.timeout(60000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
          assert.deepStrictEqual(leftovers, [], `leftover objects:\n${leftovers.join("\n")}`);
        });

        it("rewrites no object unchanged", function () {
          const idle = [...new Set(watch.unchanged)];
          assert.deepStrictEqual(idle, [], `objects written without a change:\n${idle.join("\n")}`);
        });

        it("rewrites no indicator state unchanged", function () {
          const idle = [...new Set(watch.unchangedIndicators)];
          assert.deepStrictEqual(idle, [], `indicator states written without a change:\n${idle.join("\n")}`);
        });

        // A kept object that is deleted and created anew makes the suite judge a fresh object, not the upgraded
        // one (hassemu v1.43.1: the stale cleanup removed 18 seeded clients before the dump).
        it("deletes no object the release keeps", function () {
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const lost = [...new Set(watch.deleted)].filter(id => id in previous && id in current);
          assert.deepStrictEqual(lost, [], `kept objects deleted during the upgrade:\n${lost.join("\n")}`);
        });

        it("a recording goes on only with its own datapoint", async function () {
          this.timeout(60000);
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
            } else if (ids[0] !== origin && origin in live) {
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
          assert.deepStrictEqual(wrong, [], `recordings that left their datapoint:\n${wrong.join("\n")}`);
        });

        // What a fresh installation does not have, an upgrade must not have either — whatever made it (round 64:
        // a datapoint created because the old one was recorded is exactly that).
        it("creates nothing a fresh installation lacks", async function () {
          this.timeout(60000);
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
  fs.rmSync(RESOURCE_DIR, { recursive: true, force: true });
  assert.ok(starts.length > 0, "no adapter start loaded the resource probe — a start without adapterEnv()");
  assert.deepStrictEqual(silent, [], "adapter processes that never reached their exit (killed or crashed)");
  assert.deepStrictEqual(left, [], `left open after onUnload:\n${left.join("\n")}`);
  assert.deepStrictEqual(
    reread,
    [],
    `read-only states read back from the database while nothing changed:\n${reread.join("\n")}`,
  );
});
