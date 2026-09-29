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
  carryPlan: () => carryPlan,
  enumsHolding: () => enumsHolding,
  moveAllWithEnums: () => moveAllWithEnums,
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
function carryPlan(enums, successors) {
  var _a;
  const plan = /* @__PURE__ */ new Map();
  for (const enumId of Object.keys(enums != null ? enums : {}).sort()) {
    for (const member of membersOf(enums == null ? void 0 : enums[enumId])) {
      const next = successors(member);
      if (next.length > 0) {
        const moves = (_a = plan.get(enumId)) != null ? _a : /* @__PURE__ */ new Map();
        moves.set(member, next);
        plan.set(enumId, moves);
      }
    }
  }
  return plan;
}
async function carry(adapter, successors, remove, describeError, subject) {
  let plan = /* @__PURE__ */ new Map();
  try {
    plan = carryPlan(await adapter.getForeignObjectsAsync("enum.*", "enum"), successors);
  } catch (err) {
    adapter.log.warn(`Room and function assignments${subject} could not be read: ${describeError(err)}`);
  }
  await remove();
  const carried = [];
  for (const [enumId, moves] of plan) {
    const newIds = [...new Set([...moves.values()].flat())];
    try {
      const fresh = await adapter.getForeignObjectAsync(enumId);
      if (!fresh) {
        continue;
      }
      const members = membersOf(fresh).filter((m) => !moves.has(m));
      for (const id of newIds) {
        if (!members.includes(id)) {
          members.push(id);
        }
      }
      await adapter.setForeignObject(enumId, { ...fresh, common: { ...fresh.common, members } });
      carried.push({ enumId, newIds });
    } catch (err) {
      adapter.log.warn(`Assignment ${enumId} could not be carried to ${newIds.join(", ")}: ${describeError(err)}`);
    }
  }
  return carried;
}
async function moveAllWithEnums(adapter, successors, remove, describeError) {
  return carry(adapter, successors, remove, describeError, "");
}
async function moveWithEnums(adapter, oldId, newId, remove, describeError) {
  const carried = await carry(adapter, (id) => id === oldId ? [newId] : [], remove, describeError, ` of ${oldId}`);
  return carried.map((c) => c.enumId);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  carryPlan,
  enumsHolding,
  moveAllWithEnums,
  moveWithEnums
});
//# sourceMappingURL=enum-carry.js.map
