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
const INVENTORY = path.join(__dirname, "objects.inventory.json");
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
  // ~40 requests per appliance × 17 appliances ≈ 70 s before devicesTotal is
  // written. Real clouds answer slower than the spacing, so users never wait
  // for it — the fixture does.
  const deadline = Date.now() + 300000;
  for (;;) {
    const total = await harness.states.getStateAsync(`${NS}info.devicesTotal`);
    if (total && total.val === APPLIANCE_COUNT) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`only ${total ? total.val : 0} of ${APPLIANCE_COUNT} appliances reached the tree`);
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

tests.integration(ADAPTER_DIR, {
  controllerVersion: "stable",
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      before(async function () {
        this.timeout(360000);
        harness = getHarness();
        await harness.changeAdapterConfig(ADAPTER, { native: FIXTURE_NATIVE });
        await harness.startAdapterAndWait(false, FIXTURE_ENV);
        await feedFixtures(harness);
      });

      it("writes test/objects.inventory.json", async function () {
        this.timeout(60000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
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
