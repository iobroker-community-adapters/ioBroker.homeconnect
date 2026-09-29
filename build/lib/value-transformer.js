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
var value_transformer_exports = {};
__export(value_transformer_exports, {
  UNNAMED_EVENT_KEY: () => UNNAMED_EVENT_KEY,
  expandBshItem: () => expandBshItem,
  isDoorStatusKey: () => isDoorStatusKey,
  parseConstraints: () => parseConstraints,
  shortEnum: () => shortEnum,
  shortEnumIn: () => shortEnumIn,
  stateIdForKey: () => stateIdForKey,
  transformItem: () => transformItem,
  transformOptionDefinition: () => transformOptionDefinition
});
module.exports = __toCommonJS(value_transformer_exports);
var import_pure_helpers = require("./pure-helpers");
var import_i18n = require("./i18n");
var import_state_texts = require("./state-texts");
var import_value_labels = require("./value-labels");
var import_program_records = require("./program-records");
var import_value_units = require("./value-units");
var import_switch_values = require("./switch-values");
const EVENT_PRESENT = "BSH.Common.EnumType.EventPresentState.Present";
const UNNAMED_EVENT_KEY = "BSH.Common.EnumType.EventPresentState";
const KIND_TO_CHANNEL = {
  Status: "status",
  Setting: "settings",
  Event: "events",
  Option: "options",
  Command: "commands",
  Root: "programs"
};
function shortEnum(bshValue) {
  var _a;
  const parts = bshValue.split(".");
  const tail = (_a = parts[parts.length - 1]) != null ? _a : bshValue;
  return tail.toLowerCase();
}
function shortEnumIn(bshValue, candidates) {
  const short = shortEnum(bshValue);
  if (!(candidates == null ? void 0 : candidates.some((c) => c !== bshValue && shortEnum(c) === short))) {
    return short;
  }
  return bshValue.split(".").slice(-2).join(".").toLowerCase();
}
function parseConstraints(rawConstraints) {
  if (!(0, import_pure_helpers.isRecord)(rawConstraints)) {
    return void 0;
  }
  return {
    min: (0, import_pure_helpers.numberOrUndef)(rawConstraints.min),
    max: (0, import_pure_helpers.numberOrUndef)(rawConstraints.max),
    stepsize: (0, import_pure_helpers.numberOrUndef)(rawConstraints.stepsize),
    allowedvalues: (0, import_pure_helpers.stringArrayOrUndef)(rawConstraints.allowedvalues),
    displayvalues: (0, import_pure_helpers.stringArrayOrUndef)(rawConstraints.displayvalues),
    default: rawConstraints.default,
    access: typeof rawConstraints.access === "string" ? rawConstraints.access : void 0
  };
}
function lowerFirst(s) {
  return s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
function stateIdForKey(key) {
  var _a, _b;
  if (key === UNNAMED_EVENT_KEY) {
    return { channel: "events", id: "unnamedEvent" };
  }
  const parts = key.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const channel = KIND_TO_CHANNEL[(_a = parts[i]) != null ? _a : ""];
    if (channel) {
      return { channel, id: camelJoin(parts.slice(i + 1)) };
    }
  }
  return { channel: "misc", id: lowerFirst((_b = parts[parts.length - 1]) != null ? _b : key) };
}
function camelJoin(segments) {
  return segments.map((s, i) => i === 0 ? lowerFirst(s) : s.charAt(0).toUpperCase() + s.slice(1)).join("");
}
function transformItem(item) {
  const { channel, id } = stateIdForKey(item.key);
  const { common, value, bshValues, nameSource, seenValues } = transformValue(item);
  return { channel, id, common, nameSource, value, bshValues, ...seenValues ? { seenValues } : {} };
}
const PROGRAM_ITEM_NAMES = {
  "BSH.Common.Root.SelectedProgram": "selectedProgram",
  "BSH.Common.Root.ActiveProgram": "activeProgram"
};
function itemLabel(key, apiName, id) {
  const texts = (0, import_state_texts.stateText)(key);
  const desc = (texts == null ? void 0 : texts.desc) ? (0, import_i18n.tName)(texts.desc) : void 0;
  if (texts == null ? void 0 : texts.name) {
    return { name: (0, import_i18n.tName)(texts.name), nameSource: "i18n", desc };
  }
  const own = PROGRAM_ITEM_NAMES[key];
  if (own) {
    return { name: (0, import_i18n.tName)(own), nameSource: "i18n", desc };
  }
  const cleaned = (0, import_pure_helpers.cleanLabel)(apiName);
  if (cleaned.length > 0) {
    return { name: cleaned, nameSource: "api", desc };
  }
  return { name: (0, import_pure_helpers.humanizeId)(id), nameSource: "derived", desc };
}
const DOOR_STATE_KEY = "BSH.Common.Status.DoorState";
const OPERATION_STATE_KEY = "BSH.Common.Status.OperationState";
function isDoorStatusKey(key) {
  return key === DOOR_STATE_KEY || key.includes(".Status.Door.");
}
function expandBshItem(item, lockableDoor) {
  var _a;
  if ((0, import_program_records.isProgramRecordKey)(item.key)) {
    return [];
  }
  if (isDoorStatusKey(item.key)) {
    const short = typeof item.value === "string" ? shortEnum(item.value) : void 0;
    if (item.key === DOOR_STATE_KEY) {
      const states = [
        {
          channel: "status",
          id: "doorOpen",
          common: { ...booleanCommon((0, import_i18n.tName)("doorOpen"), "sensor.door", false), desc: (0, import_i18n.tName)("doorOpenDesc") },
          nameSource: "i18n",
          value: short === void 0 ? void 0 : short === "open"
        }
      ];
      if (lockableDoor) {
        states.push({
          channel: "status",
          id: "doorLocked",
          common: { ...booleanCommon((0, import_i18n.tName)("doorLocked"), "indicator", false), desc: (0, import_i18n.tName)("doorLockedDesc") },
          nameSource: "i18n",
          value: short === void 0 ? void 0 : short === "locked"
        });
      }
      return states;
    }
    const id = `${stateIdForKey(item.key).id}Open`;
    const compartment = (_a = item.key.split(".").at(-1)) != null ? _a : "";
    const named = import_state_texts.DOOR_COMPARTMENT_NAMES[compartment];
    return [
      {
        channel: "status",
        id,
        common: {
          ...booleanCommon(named ? (0, import_i18n.tName)(named) : (0, import_i18n.tName)("doorCompartmentOpen", compartment), "sensor.door", false),
          desc: (0, import_i18n.tName)("doorCompartmentOpenDesc")
        },
        nameSource: "i18n",
        value: short === void 0 ? void 0 : short === "open"
      }
    ];
  }
  const t = transformItem(item);
  if (item.key === OPERATION_STATE_KEY) {
    return [
      t,
      {
        channel: "status",
        id: "programRunning",
        common: {
          ...booleanCommon((0, import_i18n.tName)("programRunning"), "indicator.working", false),
          desc: (0, import_i18n.tName)("programRunningDesc")
        },
        nameSource: "i18n",
        value: t.value === void 0 ? void 0 : t.value === "run"
      }
    ];
  }
  return [t];
}
function transformOptionDefinition(opt) {
  var _a, _b;
  const { channel, id } = stateIdForKey(opt.key);
  const { name, nameSource, desc } = itemLabel(opt.key, opt.name, id);
  const c = opt.constraints;
  const writable = (c == null ? void 0 : c.access) !== "read";
  if (opt.type === "Boolean") {
    const common2 = {
      name,
      desc,
      type: "boolean",
      role: writable ? "switch" : "indicator",
      read: true,
      write: writable,
      def: false
    };
    return { channel, id, common: common2, nameSource, value: typeof (c == null ? void 0 : c.default) === "boolean" ? c.default : void 0 };
  }
  if (opt.type === "Int" || opt.type === "Double") {
    const common2 = numberCommon(name, desc, writable, opt.key, opt.unit, c);
    const p = (0, import_value_units.presentationFor)(opt.key, opt.unit);
    const def = typeof (c == null ? void 0 : c.default) === "number" ? c.default : void 0;
    return { channel, id, common: common2, nameSource, value: def !== void 0 && p ? (0, import_value_units.toShown)(def, p) : def };
  }
  const allowed = (_a = c == null ? void 0 : c.allowedvalues) == null ? void 0 : _a.filter((v) => v.length > 0);
  if ((0, import_switch_values.isSwitchKey)(opt.key) && allowed && allowed.length > 0) {
    const common2 = {
      ...booleanCommon(name, (0, import_switch_values.switchRole)(opt.key, writable), writable),
      desc
    };
    return { channel, id, common: common2, nameSource, value: (0, import_switch_values.switchState)(c == null ? void 0 : c.default), bshValues: allowed };
  }
  const common = { name, desc, type: "string", role: "text", read: true, write: writable };
  let bshValues;
  if (allowed && allowed.length > 0) {
    common.states = allowedStates(allowed, c == null ? void 0 : c.displayvalues, shortEnum, (_b = opt.lang) != null ? _b : import_value_labels.DEFAULT_LABEL_LANGUAGE, opt.key);
    bshValues = allowed;
  }
  const value = typeof (c == null ? void 0 : c.default) === "string" ? shortEnum(c.default) : void 0;
  return { channel, id, common, nameSource, value, bshValues };
}
function allowedStates(allowed, displayvalues, shortOf, lang, key) {
  const cloud = displayvalues && displayvalues.length === allowed.length ? displayvalues : void 0;
  const states = {};
  allowed.forEach((v, i) => {
    states[shortOf(v)] = (0, import_value_labels.valueLabel)(v, lang, cloud == null ? void 0 : cloud[i], key);
  });
  return states;
}
function isWritable(key) {
  const { channel, id } = stateIdForKey(key);
  return channel === "settings" || channel === "programs" && id === "selectedProgram";
}
const COLOR_KEYS = /* @__PURE__ */ new Set(["BSH.Common.Setting.AmbientLightCustomColor"]);
function transformValue(item) {
  var _a, _b, _c, _d, _e, _f;
  const { key, value } = item;
  const { name, nameSource, desc } = itemLabel(key, item.name, stateIdForKey(key).id);
  const writable = isWritable(key) && ((_a = item.constraints) == null ? void 0 : _a.access) !== "read";
  const allowed = (_c = (_b = item.constraints) == null ? void 0 : _b.allowedvalues) == null ? void 0 : _c.filter((v) => v.length > 0);
  if (key.includes(".Event.") || key === UNNAMED_EVENT_KEY) {
    return {
      common: { ...booleanCommon(name, "indicator.alarm", false), desc },
      nameSource,
      value: value === void 0 || value === null ? void 0 : value === EVENT_PRESENT
    };
  }
  if (typeof value === "number") {
    const p = (0, import_value_units.presentationFor)(key, item.unit);
    const common = numberCommon(name, desc, writable, key, item.unit, item.constraints);
    return { common, nameSource, value: p ? (0, import_value_units.toShown)(value, p) : value };
  }
  if ((0, import_switch_values.isSwitchKey)(key)) {
    const catalogue2 = (0, import_value_labels.catalogValues)(key, value);
    const bshValues = !writable ? void 0 : allowed && allowed.length > 0 ? allowed : catalogue2 && catalogue2.length > 0 ? [...catalogue2] : typeof value === "string" && value.length > 0 ? [value] : void 0;
    return {
      common: { ...booleanCommon(name, (0, import_switch_values.switchRole)(key, writable), writable), desc },
      nameSource,
      value: (0, import_switch_values.switchState)(value),
      bshValues
    };
  }
  if (typeof value === "boolean") {
    return {
      common: { ...booleanCommon(name, writable ? "switch" : "indicator", writable), desc },
      nameSource,
      value
    };
  }
  const isEnumString = typeof value === "string" && (value.includes(".EnumType.") || value.includes(".Program."));
  const catalogue = allowed && allowed.length > 0 ? void 0 : (0, import_value_labels.catalogValues)(key, value);
  if (isEnumString || allowed && allowed.length > 0 || catalogue !== void 0) {
    const base = allowed && allowed.length > 0 ? allowed : [...catalogue != null ? catalogue : []];
    const seenValues = [...(_d = item.seen) != null ? _d : []];
    if (typeof value === "string" && value.length > 0 && !base.includes(value) && !seenValues.includes(value)) {
      seenValues.push(value);
    }
    const full = [...base, ...seenValues.filter((v) => !base.includes(v))];
    const inList = stateIdForKey(item.key).channel !== "options" ? full : void 0;
    const shortOf = (v) => inList ? shortEnumIn(v, inList) : shortEnum(v);
    const short = typeof value === "string" ? value.length > 0 ? shortOf(value) : "" : void 0;
    const common = { name, desc, type: "string", role: "text", read: true, write: writable };
    const lang = (_e = item.lang) != null ? _e : import_value_labels.DEFAULT_LABEL_LANGUAGE;
    const display = (_f = item.constraints) == null ? void 0 : _f.displayvalues;
    const cloudLabels = allowed && display && display.length === allowed.length ? display : void 0;
    const states = {};
    if (PROGRAM_ITEM_NAMES[key]) {
      states[""] = (0, import_value_labels.noProgramLabel)(lang);
    }
    for (const v of full) {
      const i = allowed ? allowed.indexOf(v) : -1;
      states[shortOf(v)] = (0, import_value_labels.valueLabel)(v, lang, i >= 0 ? cloudLabels == null ? void 0 : cloudLabels[i] : void 0, key);
    }
    if (full.length > 0) {
      common.states = states;
    }
    const bshValues = allowed && allowed.length > 0 ? allowed : writable ? catalogue && catalogue.length > 0 ? [...catalogue] : short !== void 0 && short.length > 0 ? [value] : void 0 : void 0;
    return {
      common,
      nameSource,
      value: short,
      bshValues,
      ...seenValues.length > 0 ? { seenValues } : {}
    };
  }
  const role = COLOR_KEYS.has(key) && writable ? "level.color.rgb" : "text";
  return {
    common: { name, desc, type: "string", role, read: true, write: writable },
    nameSource,
    value: typeof value === "string" ? value : value === void 0 || value === null ? void 0 : JSON.stringify(value)
  };
}
function numberCommon(name, desc, writable, key, unit, constraints) {
  const common = {
    name,
    desc,
    type: "number",
    role: writable ? "level" : "value",
    read: true,
    write: writable
  };
  const p = (0, import_value_units.presentationFor)(key, unit);
  const shown = (0, import_value_units.shownUnit)(key, unit);
  if (shown) {
    common.unit = shown;
  }
  if (typeof (constraints == null ? void 0 : constraints.min) === "number") {
    common.min = p ? (0, import_value_units.boundShown)(constraints.min, p, "min") : constraints.min;
  }
  if (typeof (constraints == null ? void 0 : constraints.max) === "number") {
    common.max = p ? (0, import_value_units.boundShown)(constraints.max, p, "max") : constraints.max;
  }
  if (typeof (constraints == null ? void 0 : constraints.stepsize) === "number") {
    common.step = p ? (0, import_value_units.boundShown)(constraints.stepsize, p, "step") : constraints.stepsize;
  }
  return common;
}
function booleanCommon(name, role, writable) {
  return { name, type: "boolean", role, read: true, write: writable, def: false };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  UNNAMED_EVENT_KEY,
  expandBshItem,
  isDoorStatusKey,
  parseConstraints,
  shortEnum,
  shortEnumIn,
  stateIdForKey,
  transformItem,
  transformOptionDefinition
});
//# sourceMappingURL=value-transformer.js.map
