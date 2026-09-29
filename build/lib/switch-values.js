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
var switch_values_exports = {};
__export(switch_values_exports, {
  isSwitchKey: () => isSwitchKey,
  isSwitchValueSet: () => isSwitchValueSet,
  switchRole: () => switchRole,
  switchState: () => switchState,
  switchValue: () => switchValue
});
module.exports = __toCommonJS(switch_values_exports);
var import_enum_catalog = require("./enum-catalog");
const OFF_TAILS = ["off", "standby", "mainsoff"];
const NO_VALUE_TAILS = ["undefined"];
function tail(value) {
  var _a;
  return ((_a = value.split(".").at(-1)) != null ? _a : "").toLowerCase();
}
function isSwitchKey(key) {
  const type = import_enum_catalog.KEY_ENUM_TYPES[key];
  return isSwitchValueSet(type !== void 0 ? import_enum_catalog.ENUM_TYPE_VALUES[type] : import_enum_catalog.KEY_VALUE_NAMES[key]);
}
function isSwitchValueSet(names) {
  if (!names || names.length === 0) {
    return false;
  }
  const tails = names.map(tail);
  return tails.includes("on") && tails.some((t) => OFF_TAILS.includes(t)) && tails.every((t) => t === "on" || OFF_TAILS.includes(t) || NO_VALUE_TAILS.includes(t));
}
function switchState(value) {
  if (typeof value !== "string" || value.length === 0) {
    return void 0;
  }
  const t = tail(value);
  if (t === "on") {
    return true;
  }
  return OFF_TAILS.includes(t) ? false : void 0;
}
function switchValue(on, bshValues) {
  const wanted = on ? ["on"] : OFF_TAILS;
  for (const w of wanted) {
    const hit = bshValues.find((v) => tail(v) === w);
    if (hit) {
      return hit;
    }
  }
  return void 0;
}
const POWER_STATE_KEY = "BSH.Common.Setting.PowerState";
function switchRole(key, writable) {
  if (!writable) {
    return "indicator";
  }
  return key === POWER_STATE_KEY ? "switch.power" : "switch";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isSwitchKey,
  isSwitchValueSet,
  switchRole,
  switchState,
  switchValue
});
//# sourceMappingURL=switch-values.js.map
