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
var enum_carry_exports = {};
__export(enum_carry_exports, {
  enumsHolding: () => enumsHolding,
  moveWithEnums: () => moveWithEnums
});
module.exports = __toCommonJS(enum_carry_exports);
const membersOf = (obj) => {
  var _a;
  const members = (_a = obj == null ? void 0 : obj.common) == null ? void 0 : _a.members;
  return Array.isArray(members) ? members.filter((m) => typeof m === "string") : [];
};
function enumsHolding(enums, id) {
  return Object.entries(enums != null ? enums : {}).filter(([, obj]) => membersOf(obj).includes(id)).map(([enumId]) => enumId).sort();
}
async function moveWithEnums(adapter, oldId, newId, remove, describeError) {
  let holders = [];
  try {
    holders = enumsHolding(await adapter.getForeignObjectsAsync("enum.*", "enum"), oldId);
  } catch (err) {
    adapter.log.warn(`Room and function assignments of ${oldId} could not be read: ${describeError(err)}`);
  }
  await remove();
  const carried = [];
  for (const enumId of holders) {
    try {
      const fresh = await adapter.getForeignObjectAsync(enumId);
      if (!fresh) {
        continue;
      }
      const members = membersOf(fresh).filter((m) => m !== oldId);
      if (!members.includes(newId)) {
        members.push(newId);
      }
      await adapter.setForeignObject(enumId, { ...fresh, common: { ...fresh.common, members } });
      carried.push(enumId);
    } catch (err) {
      adapter.log.warn(`Assignment ${enumId} could not be carried to ${newId}: ${describeError(err)}`);
    }
  }
  return carried;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  enumsHolding,
  moveWithEnums
});
//# sourceMappingURL=enum-carry.js.map
