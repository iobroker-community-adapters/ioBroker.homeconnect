"use strict";
// test/inventory-pacing-hook.cjs (PACING_HOOKS): widens the adapter's declared limits as the adapter loads them — the
// adapter reads its pace only from src/lib/api-limits.json; the installations the limit tests judge run without this hook.
// The fixtures list every program of every model of a type, over a thousand requests for a cold start: held to Home
// Connect's 50 per minute and 100 ms that is more than twenty minutes per suite (tooling round 140, the template body).
const Module = require("node:module");
const path = require("node:path");
const LIMITS = path.join("src", "lib", "api-limits.json");
const load = Module._extensions[".json"];
Module._extensions[".json"] = function (module, filename) {
  load(module, filename);
  if (filename.endsWith(LIMITS)) {
    for (const counterpart of module.exports.counterparts) {
      for (const limit of counterpart.limits) {
        limit.max *= 1000;
      }
    }
  }
};
