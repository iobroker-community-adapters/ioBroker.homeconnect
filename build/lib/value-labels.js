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
var value_labels_exports = {};
__export(value_labels_exports, {
  DEFAULT_LABEL_LANGUAGE: () => DEFAULT_LABEL_LANGUAGE,
  catalogValues: () => catalogValues,
  noProgramLabel: () => noProgramLabel,
  ownValueLabel: () => ownValueLabel,
  programLabels: () => programLabels,
  unknownProgramLabel: () => unknownProgramLabel,
  valueLabel: () => valueLabel
});
module.exports = __toCommonJS(value_labels_exports);
var import_pure_helpers = require("./pure-helpers");
var import_value_label_table = require("./value-label-table");
var import_enum_catalog = require("./enum-catalog");
const DEFAULT_LABEL_LANGUAGE = "en";
const LANGUAGE_SETTING_KEY = "BSH.Common.Setting.Language";
function ownValueLabel(bshValue, lang) {
  var _a;
  const row = import_value_label_table.VALUE_LABELS[lastSegment(bshValue).toLowerCase()];
  if (!row) {
    return void 0;
  }
  const col = import_value_label_table.LABEL_LANGUAGES.indexOf(lang);
  return (_a = row[col >= 0 ? col : 0]) != null ? _a : row[0];
}
const NO_PROGRAM = [
  "No program",
  "Kein Programm",
  "\u041D\u0435\u0442 \u043F\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u044B",
  "Nenhum programa",
  "Geen programma",
  "Aucun programme",
  "Nessun programma",
  "Ning\xFAn programa",
  "Brak programu",
  "\u041D\u0435\u043C\u0430\u0454 \u043F\u0440\u043E\u0433\u0440\u0430\u043C\u0438",
  "\u65E0\u7A0B\u5E8F"
];
function noProgramLabel(lang) {
  var _a;
  const col = import_value_label_table.LABEL_LANGUAGES.indexOf(lang);
  return (_a = NO_PROGRAM[col >= 0 ? col : 0]) != null ? _a : NO_PROGRAM[0];
}
const UNKNOWN_PROGRAM = [
  "Program %s (not identified yet)",
  "Programm %s (noch nicht zugeordnet)",
  "\u041F\u0440\u043E\u0433\u0440\u0430\u043C\u043C\u0430 %s (\u0435\u0449\u0451 \u043D\u0435 \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0435\u043D\u0430)",
  "Programa %s (ainda n\xE3o identificado)",
  "Programma %s (nog niet herkend)",
  "Programme %s (pas encore identifi\xE9)",
  "Programma %s (non ancora identificato)",
  "Programa %s (a\xFAn sin identificar)",
  "Program %s (jeszcze nierozpoznany)",
  "\u041F\u0440\u043E\u0433\u0440\u0430\u043C\u0430 %s (\u0449\u0435 \u043D\u0435 \u0432\u0438\u0437\u043D\u0430\u0447\u0435\u043D\u0430)",
  "\u7A0B\u5E8F %s\uFF08\u5C1A\u672A\u8BC6\u522B\uFF09"
];
function unknownProgramLabel(uid, lang) {
  var _a;
  const col = import_value_label_table.LABEL_LANGUAGES.indexOf(lang);
  return ((_a = UNKNOWN_PROGRAM[col >= 0 ? col : 0]) != null ? _a : UNKNOWN_PROGRAM[0]).replace("%s", String(uid));
}
function programLabels(programKey) {
  const names = Object.fromEntries(import_value_label_table.LABEL_LANGUAGES.map((l) => [l, valueLabel(programKey, l)]));
  return { ...names, en: valueLabel(programKey, "en") };
}
function languageName(code, lang) {
  const tag = code.replace(/([a-z])([A-Z])/g, "$1-$2");
  try {
    const name = new Intl.DisplayNames([lang === "zh-cn" ? "zh-CN" : lang], { type: "language" }).of(tag);
    return name && name.toLowerCase() !== tag.toLowerCase() ? name : void 0;
  } catch {
    return void 0;
  }
}
function valueLabel(bshValue, lang, cloudLabel, key) {
  const own = key === LANGUAGE_SETTING_KEY ? languageName(lastSegment(bshValue), lang) : ownValueLabel(bshValue, lang);
  if (own !== void 0) {
    return own;
  }
  if (typeof cloudLabel === "string" && cloudLabel.trim().length > 0) {
    return cloudLabel.trim();
  }
  return (0, import_pure_helpers.humanizeId)(lastSegment(bshValue));
}
function catalogValues(key, value) {
  const type = import_enum_catalog.KEY_ENUM_TYPES[key];
  if (type !== void 0) {
    return import_enum_catalog.ENUM_TYPE_VALUES[type];
  }
  const names = import_enum_catalog.KEY_VALUE_NAMES[key];
  if (!names || typeof value !== "string" || !value.includes(".")) {
    return void 0;
  }
  const prefix = value.slice(0, value.lastIndexOf("."));
  return names.map((n) => `${prefix}.${n}`);
}
function lastSegment(bshValue) {
  return bshValue.slice(bshValue.lastIndexOf(".") + 1);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_LABEL_LANGUAGE,
  catalogValues,
  noProgramLabel,
  ownValueLabel,
  programLabels,
  unknownProgramLabel,
  valueLabel
});
//# sourceMappingURL=value-labels.js.map
