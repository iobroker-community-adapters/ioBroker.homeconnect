"use strict";
// Loaded into the ADAPTER process via NODE_OPTIONS=--require (test/inventory.js, PACING_HOOKS): it changes only the
// adapter's pace. The fixtures list every program of every model of a type, over a thousand requests for a cold start;
// held to Home Connect's 50 per minute that is more than twenty minutes per suite, so the adapter's budget is widened
// here. The 100 ms gap made a cold start two minutes, and the suites give one 120 s (inventory run 2026-10-20: the
// second-language start missed it by seconds) — narrowed here to 20 ms. The installations the limit tests judge run
// without this hook, at the adapter's own pace (round 123). The production default is untouched.
process.env.HOMECONNECT_REQUESTS_PER_MINUTE = "100000";
process.env.HOMECONNECT_REQUEST_GAP_MS = "20";
