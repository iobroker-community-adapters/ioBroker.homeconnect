"use strict";
// Fleet master test/press-hook.js (round 171, krobi 2026-11-07 15:44, translated: "check closely whether day, hour and
// minute limits of every kind are checked and kept") — never edit the copy in an adapter. test/fleet-suites.js loads it in
// the suite "every limit holds when it is pressed", before the network hook. While RESOURCE_PROBE_DIR/press names a
// counterpart of src/lib/api-limits.json with a window and a maximum (`{ "<name>": { "<seconds>|concurrent": <max> } }`),
// every entry of that window gets that maximum as the adapter loads its declaration — the adapter reads its pace only
// from the declaration (round 140), so a limiter that keeps the declared limit keeps the lowered one too. The table the
// process loaded goes to RESOURCE_PROBE_DIR/<pid>.limits: the verdict judges the process against it, and a process that
// called a counterpart without one never loaded its declaration. Every loader before it (a tempo hook of the adapter)
// runs first; the lowered maximum is the last word.
const fs = require("node:fs");
const path = require("node:path");
// node's own loader table (`_extensions`) is no part of the typed node:module — the cast of test/resource-probe.js
const Module = /** @type {any} */ (require("node:module"));
const dir = process.env.RESOURCE_PROBE_DIR;
const LIMITS = path.join("src", "lib", "api-limits.json");
const load = Module._extensions[".json"];
Module._extensions[".json"] = function pressedLoad(module, filename) {
  load(module, filename);
  if (!dir || !filename.endsWith(LIMITS)) {
    return;
  }
  const file = path.join(dir, "press");
  /** @type {Record<string, Record<string, number>>} */
  const press = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  for (const counterpart of module.exports.counterparts) {
    for (const limit of counterpart.limits) {
      // the window key of test/fleet-suites.js limitKey()
      const errors = limit.errors === "successive" ? " successive errors" : limit.errors === true ? " errors" : "";
      const key = limit.concurrent === true ? "concurrent" : `${limit.seconds}${errors}`;
      const max = press[counterpart.name]?.[key];
      if (typeof max === "number") {
        limit.max = max;
      }
    }
  }
  fs.writeFileSync(path.join(dir, `${process.pid}.limits`), JSON.stringify(module.exports.counterparts));
};
