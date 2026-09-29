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
const COMPARED = ["name", "desc", "role", "type", "unit"];
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

/**
 * Adapter-specific config the fixtures need. The values only ever reach the fake endpoint; the
 * Client ID has the portal's form (64 hexadecimal characters) — any other form draws a warning.
 */
const FIXTURE_NATIVE = {
  clientID: "F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7F1C7",
  clientSecret: "fixture-client-secret",
};

/** The environment that puts the fixtures in front of the adapter's own fetch. */
const FIXTURE_ENV = { NODE_OPTIONS: `--require ${HOOK}` };

/**
 * Wait for a STATE of the adapter, never for "the tree stopped growing": the
 * per-appliance syncs are staggered, so a quiet moment can mean "four appliances
 * still only have their skeleton" — a green inventory without the very datapoints
 * the gate exists for.
 *
 * @param {import("@iobroker/testing").TestHarness} harness the running harness
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
 * @param {import("@iobroker/testing").TestHarness} harness the running harness
 */
async function feedFixtures(harness) {
  await waitForEveryAppliance(harness);
}

/**
 * Dump every object of the instance in the object-structure bot's format.
 *
 * @param {import("@iobroker/testing").TestHarness} harness the running harness
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

tests.integration(ADAPTER_DIR, {
  controllerVersion: "stable",
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      const writes = new Map();
      before(async function () {
        this.timeout(360000);
        harness = getHarness();
        // Before the first await of the suite: every start, direct or through a helper, is counted. Only the
        // adapter's own writes (`from`, set by js-controller on setObject/extendObject) — a seed the harness
        // writes before the start is not the adapter's.
        harness.on("objectChange", (id, obj) => {
          if (obj && id.startsWith(NS) && obj.from === `system.adapter.${ADAPTER}.0`) {
            writes.set(id, (writes.get(id) ?? 0) + 1);
          }
        });
        await harness.changeAdapterConfig(ADAPTER, { native: FIXTURE_NATIVE });
        await setSystemLanguage(harness, FIRST_LANGUAGE);
        await harness.startAdapterAndWait(false, FIXTURE_ENV);
        await feedFixtures(harness);
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
        const churn = [...writes].filter(([, n]) => n > MAX_OBJECT_WRITES).map(([id, n]) => `${id} ×${n}`);
        assert.deepStrictEqual(churn, [], `objects written more than ${MAX_OBJECT_WRITES} times in one start`);
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
      before(async function () {
        this.timeout(360000);
        harness = getHarness();
        await harness.changeAdapterConfig(ADAPTER, { native: FIXTURE_NATIVE });
        await setSystemLanguage(harness, SECOND_LANGUAGE);
        await harness.startAdapterAndWait(false, FIXTURE_ENV);
        await feedFixtures(harness);
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
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(360000);
          harness = getHarness();
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          for (const [id, obj] of Object.entries(previous)) {
            await harness.objects.setObjectAsync(id, obj);
          }
          await harness.changeAdapterConfig(ADAPTER, { native: FIXTURE_NATIVE });
          await harness.startAdapterAndWait(false, FIXTURE_ENV);
          await feedFixtures(harness);
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
            for (const f of COMPARED) {
              if (canonical(got.common?.[f]) !== canonical(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
            // The object's KIND (state/channel/device/folder) sits one level ABOVE
            // `common`; the `type` in COMPARED is the VALUE type and something else
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
      });
    }
  },
});
