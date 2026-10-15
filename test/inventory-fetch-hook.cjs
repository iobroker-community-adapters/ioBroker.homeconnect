"use strict";
// Loaded into the ADAPTER process via NODE_OPTIONS=--require (test/inventory.js).
// Replaces global fetch with a routing table over test/fixtures/inventory/*.json and
// REFUSES every unknown address: no call leaves this machine, and a forgotten route
// surfaces as an error instead of silently going to the real Home Connect cloud.
// The adapter knows nothing about this hook; its pace is test/inventory-pacing-hook.cjs's business.
const fs = require("node:fs");
const path = require("node:path");

const BASE = "https://api.home-connect.com";
const DIR = path.join(__dirname, "fixtures", "inventory");
// Round 123 (LIMIT_ACCOUNT in test/inventory.js): an installation the limit tests judge gets a smaller account — at
// Home Connect's own 50 per minute the full one needs over a thousand requests, more than a day allows.
const LIMIT_ACCOUNT = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "limit-account.json"), "utf8"));
const TYPES = fs
  .readdirSync(DIR)
  .filter(f => f.endsWith(".json"))
  .map(f => f.replace(".json", ""))
  .filter(type => process.env.INVENTORY_COUNTED !== "1" || LIMIT_ACCOUNT.includes(type))
  .sort();

/** type → fixture, and the appliance record the account lists for it. */
const FIXTURES = new Map();
const APPLIANCES = [];
for (const type of TYPES) {
  const fixture = JSON.parse(fs.readFileSync(path.join(DIR, `${type}.json`), "utf8"));
  // Deterministic identity: the folder id is the model code (vib) plus the haId's last four characters.
  const haId = `SIEMENS-HCFIX${type.toUpperCase()}-0001`;
  FIXTURES.set(haId, fixture);
  APPLIANCES.push({
    haId,
    name: `Fixture ${type}`,
    type,
    brand: "Siemens",
    vib: `HCFIX${type}`,
    enumber: `HCFIX${type}/01`,
    connected: true,
  });
}

// test/inventory.js `feedReservedNames`: while this flag stands, the account lists one more appliance whose model is
// `info` and whose haId carries no letter or digit — without the adapter's guard its id would be exactly `info`. The
// open event stream announces it with a PAIRED event, as Home Connect does for a newly paired appliance.
const RESERVED_FLAG = path.join(process.env.RESOURCE_PROBE_DIR || __dirname, "reserved-names");
const RESERVED = {
  haId: "--",
  name: "info",
  type: "Washer",
  brand: "Siemens",
  vib: "info",
  enumber: "info/01",
  connected: true,
};
FIXTURES.set(RESERVED.haId, JSON.parse(fs.readFileSync(path.join(DIR, "Washer.json"), "utf8")));
const listed = () => (fs.existsSync(RESERVED_FLAG) ? [...APPLIANCES, RESERVED] : APPLIANCES);

const json = (data, status = 200) =>
  new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/vnd.bsh.sdk.v1+json" } });
const bshError = (key, status) =>
  new Response(JSON.stringify({ error: { key } }), { status, headers: { "content-type": "application/json" } });

/** The endless event stream: one KEEP-ALIVE, then quiet until the adapter aborts (a PAIRED once the reserved flag stands). */
function eventStream(signal) {
  let watch;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event:KEEP-ALIVE\ndata:\n\n"));
      watch = setInterval(() => {
        if (fs.existsSync(RESERVED_FLAG)) {
          clearInterval(watch);
          const data = JSON.stringify({ haId: RESERVED.haId, items: [] });
          controller.enqueue(new TextEncoder().encode(`event:PAIRED\nid:${RESERVED.haId}\ndata:${data}\n\n`));
        }
      }, 250);
      const close = () => {
        clearInterval(watch);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      if (signal) {
        signal.addEventListener("abort", close, { once: true });
      }
    },
    cancel() {
      clearInterval(watch);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * Answer one request from the fixtures.
 *
 * @param {string} url the full request URL
 * @param {RequestInit} init the fetch init (method, signal)
 * @returns {Response|undefined} the answer, or undefined for an unknown route
 */
function route(url, init) {
  const { pathname } = new URL(url);
  const method = (init && init.method) || "GET";

  if (pathname === "/security/oauth/device_authorization") {
    // interval 0 → the adapter falls back to its 5 s default; the sign-in flow runs for real.
    return new Response(
      JSON.stringify({
        device_code: "FIXTURE-DEVICE-CODE",
        user_code: "FIX-1234",
        verification_uri: "https://fixture.invalid/pair",
        verification_uri_complete: "https://fixture.invalid/pair?code=FIX-1234",
        interval: 0,
        expires_in: 600,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (pathname === "/security/oauth/token") {
    return new Response(
      JSON.stringify({
        access_token: "FIXTURE-ACCESS-TOKEN",
        refresh_token: "FIXTURE-REFRESH-TOKEN",
        expires_in: 86400,
        scope: "IdentifyAppliance Monitor Settings Control",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (pathname === "/api/homeappliances/events") {
    return eventStream(init && init.signal);
  }
  if (pathname === "/api/homeappliances") {
    return json({ homeappliances: listed() });
  }

  const m = /^\/api\/homeappliances\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) {
    return undefined;
  }
  const fixture = FIXTURES.get(decodeURIComponent(m[1]));
  if (!fixture) {
    return bshError("SDK.Error.HomeApplianceNotFound", 404);
  }
  const sub = m[2] || "";
  if (sub === "") {
    return json(listed().find(a => a.haId === decodeURIComponent(m[1])));
  }
  if (sub === "/status") {
    return json({ status: fixture.status });
  }
  if (sub === "/settings") {
    // The LIST carries no constraints — measured at a live installation on
    // 2026-09-12: every settings datapoint had `unit` but no min/max/step, and a
    // writable enum had exactly one candidate value (its own). Serving the full
    // entry here made the inventory look healthier than the cloud is, which is
    // what hid the missing single-endpoint fetch for eight releases. `unit` stays
    // (it IS in the list); the fixtures keep being the source for both answers.
    return json({ settings: fixture.settings.map(({ constraints: _drop, ...rest }) => rest) });
  }
  if (sub.startsWith("/settings/")) {
    const key = decodeURIComponent(sub.slice("/settings/".length));
    const setting = fixture.settings.find(s => s.key === key);
    if (!setting) {
      return bshError("SDK.Error.SettingNotFound", 404);
    }
    return json(setting);
  }
  if (sub === "/commands") {
    return json({ commands: fixture.commands });
  }
  if (sub === "/programs/available") {
    if (fixture.programs.length === 0) {
      return bshError("SDK.Error.UnsupportedOperation", 409);
    }
    return json({ programs: fixture.programs.map(key => ({ key })) });
  }
  if (sub.startsWith("/programs/available/")) {
    const key = decodeURIComponent(sub.slice("/programs/available/".length));
    if (!fixture.programs.includes(key)) {
      return bshError("SDK.Error.ProgramNotAvailable", 409);
    }
    // Every program of an appliance declares the same option set here — the
    // adapter builds the union across programs, which is what the tree shows.
    return json({ key, options: fixture.programOptions });
  }
  if (sub === "/programs/selected") {
    if (fixture.programs.length === 0) {
      return bshError("SDK.Error.NoProgramSelected", 404);
    }
    // The run values come with the selected program, as the real cloud sends them (decision 49) — never in a
    // program definition.
    return json({ key: fixture.programs[0], options: fixture.selectedOptions || [] });
  }
  if (sub === "/programs/active") {
    return bshError("SDK.Error.NoProgramActive", 404);
  }
  if (method === "PUT" || method === "DELETE") {
    return new Response("", { status: 204 });
  }
  return undefined;
}

globalThis.fetch = function fixtureFetch(input, init) {
  const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
  if (!url.startsWith(BASE)) {
    return Promise.reject(new Error(`inventory fixture: refusing a call outside the fixtures: ${url}`));
  }
  const res = route(url, init);
  if (!res) {
    return Promise.reject(new Error(`inventory fixture: no route for ${url}`));
  }
  return Promise.resolve(res);
};
