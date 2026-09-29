"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var value_units_exports = {};
__export(value_units_exports, {
  RUN_ENERGY: () => RUN_ENERGY,
  boundShown: () => boundShown,
  fromShown: () => fromShown,
  presentationFor: () => presentationFor,
  shownPresentation: () => shownPresentation,
  shownUnit: () => shownUnit,
  toShown: () => toShown
});
module.exports = __toCommonJS(value_units_exports);
const MINUTES = { unit: "min", factor: 60, decimals: 0, from: ["seconds", "s"] };
const LITRES_FROM_ML = { unit: "l", factor: 1e3, decimals: 1, from: ["ml"] };
const PRESENTATIONS = {
  // Lifetime totals of a laundry appliance: 2,011,440 s read as 558.7 h, 139,858 Wh as 139.86 kWh.
  "BSH.Common.Status.Program.All.Time.Effective": { unit: "h", factor: 3600, decimals: 1, from: ["seconds", "s"] },
  "BSH.Common.Status.Program.All.Energy.Consumed": { unit: "kWh", factor: 1e3, decimals: 2, from: ["Wh"] },
  // The cloud sends the water counter as millilitres, measured with the unit "ml" and — decision 45 — with "l"
  // on a value that is millilitres all the same (12,171,000 "l" after 339 runs).
  "BSH.Common.Status.Program.All.Water.Consumed": { unit: "l", factor: 1e3, decimals: 1, from: ["ml", "l"] },
  "LaundryCare.Washer.Status.Detergent.All.Consumed": LITRES_FROM_ML,
  "LaundryCare.Washer.Status.Softener.All.Consumed": LITRES_FROM_ML,
  "LaundryCare.Common.Option.LoadRecommendation": { unit: "kg", factor: 1e3, decimals: 1, from: ["gram", "g"] },
  // Durations: whole minutes — 9,060 s of remaining time read as 151 min.
  "BSH.Common.Status.RemoteControlStartAllowedSince": MINUTES,
  "BSH.Common.Option.RemainingProgramTime": MINUTES,
  "BSH.Common.Option.EstimatedTotalProgramTime": MINUTES,
  "BSH.Common.Option.FinishInRelative": MINUTES,
  "BSH.Common.Option.StartInRelative": MINUTES,
  "BSH.Common.Option.Duration": MINUTES,
  "BSH.Common.Option.ElapsedProgramTime": MINUTES,
  "BSH.Common.Option.CurrentStepRemainingTime": MINUTES,
  "BSH.Common.Setting.AlarmClock": MINUTES
};
const RUN_ENERGY = { unit: "kWh", factor: 1e3, decimals: 2, from: ["Wh"] };
const UNIT_WORDS = { seconds: "s", gram: "g" };
function presentationFor(key, unit) {
  const p = key === void 0 ? void 0 : PRESENTATIONS[key];
  return p && unit !== void 0 && p.from.includes(unit) ? p : void 0;
}
function shownPresentation(key) {
  return key === void 0 ? void 0 : PRESENTATIONS[key];
}
function toShown(value, p) {
  const scale = 10 ** p.decimals;
  return Math.round(value / p.factor * scale) / scale;
}
function fromShown(value, p) {
  return Math.round(value * p.factor);
}
function shownUnit(key, unit) {
  var _a;
  const p = presentationFor(key, unit);
  if (p) {
    return p.unit;
  }
  return unit === void 0 ? void 0 : (_a = UNIT_WORDS[unit]) != null ? _a : unit;
}
function boundShown(value, p, kind) {
  const scale = 10 ** p.decimals;
  const exact = value / p.factor * scale;
  if (kind === "step") {
    return Math.max(Math.round(exact), 1) / scale;
  }
  const bound = (kind === "min" ? Math.ceil(exact - 1e-9) : Math.floor(exact + 1e-9)) / scale;
  return bound + 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RUN_ENERGY,
  boundShown,
  fromShown,
  presentationFor,
  shownPresentation,
  shownUnit,
  toShown
});
//# sourceMappingURL=value-units.js.map
