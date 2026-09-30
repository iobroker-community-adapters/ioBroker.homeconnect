"use strict";
// Loaded into the ADAPTER process via NODE_OPTIONS=--require (test/inventory.js).
// Replaces global fetch with a routing table over test/fixtures/inventory/*.json and
// REFUSES every unknown address: no call leaves this machine, and a forgotten route
// surfaces as an error instead of silently going to the real Home Connect cloud.
// The adapter knows neither this hook nor a "fixture mode".
const fs = require("node:fs");
const path = require("node:path");

const BASE = "https://api.home-connect.com";
const DIR = path.join(__dirname, "fixtures", "inventory");
const TYPES = fs
  .readdirSync(DIR)
  .filter(f => f.endsWith(".json"))
  .map(f => f.replace(".json", ""))
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

const json = (data, status = 200) =>
  new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/vnd.bsh.sdk.v1+json" } });
const bshError = (key, status) =>
  new Response(JSON.stringify({ error: { key } }), { status, headers: { "content-type": "application/json" } });

/** The endless event stream: one KEEP-ALIVE, then quiet until the adapter aborts. */
function eventStream(signal) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event:KEEP-ALIVE\ndata:\n\n"));
      const close = () => {
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
    return json({ homeappliances: APPLIANCES });
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
    return json(APPLIANCES.find(a => a.haId === decodeURIComponent(m[1])));
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
    return json({ key: fixture.programs[0], options: [] });
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
