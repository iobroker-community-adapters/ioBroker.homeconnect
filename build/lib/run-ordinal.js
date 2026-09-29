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
var run_ordinal_exports = {};
__export(run_ordinal_exports, {
  runSegment: () => runSegment
});
module.exports = __toCommonJS(run_ordinal_exports);
const ORDINAL_UNITS = [
  "",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth"
];
const CARDINAL_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ORDINAL_TENS = [
  "",
  "",
  "twentieth",
  "thirtieth",
  "fortieth",
  "fiftieth",
  "sixtieth",
  "seventieth",
  "eightieth",
  "ninetieth"
];
function ordinalWord(n) {
  if (n < 20) {
    return ORDINAL_UNITS[n];
  }
  const tens = Math.floor(n / 10);
  const unit = n % 10;
  if (unit === 0) {
    return ORDINAL_TENS[tens];
  }
  const word = ORDINAL_UNITS[unit];
  return `${CARDINAL_TENS[tens]}${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}
function runSegment(n) {
  if (n === 1) {
    return "latest";
  }
  if (n === 2) {
    return "previous";
  }
  if (n >= 3 && n <= 99 && Number.isInteger(n)) {
    return `${ordinalWord(n)}Latest`;
  }
  return `run${n}Latest`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  runSegment
});
//# sourceMappingURL=run-ordinal.js.map
