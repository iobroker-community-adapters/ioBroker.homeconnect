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
var device_move_exports = {};
__export(device_move_exports, {
  copyDeviceTree: () => copyDeviceTree,
  enumMembersUnder: () => enumMembersUnder,
  keepHistoryUnder: () => keepHistoryUnder,
  movedAliasTarget: () => movedAliasTarget,
  movedId: () => movedId,
  retargetAliases: () => retargetAliases,
  rewriteMovedObject: () => rewriteMovedObject
});
module.exports = __toCommonJS(device_move_exports);
var import_device_id = require("./device-id");
function movedId(id, fromFull, toFull) {
  if (id === fromFull) {
    return toFull;
  }
  return id.startsWith(`${fromFull}.`) ? `${toFull}${id.slice(fromFull.length)}` : void 0;
}
function keepHistoryUnder(custom, oldId) {
  if (!custom || typeof custom !== "object") {
    return 0;
  }
  let pointed = 0;
  for (const settings of Object.values(custom)) {
    if (settings && typeof settings === "object") {
      const entry = settings;
      if (entry.enabled && (typeof entry.aliasId !== "string" || entry.aliasId === "")) {
        entry.aliasId = oldId;
        pointed++;
      }
    }
  }
  return pointed;
}
function rewriteMovedObject(id, obj, fromFull, toFull) {
  var _a, _b;
  const copy = JSON.parse(JSON.stringify({ type: obj.type, common: obj.common, native: (_a = obj.native) != null ? _a : {} }));
  if (id === fromFull) {
    delete copy.native.movingTo;
    const status = copy.common.statusStates;
    if (status && typeof status.onlineId === "string") {
      status.onlineId = (_b = movedId(status.onlineId, fromFull, toFull)) != null ? _b : status.onlineId;
    }
  }
  const history = obj.type === "state" ? keepHistoryUnder(copy.common.custom, id) : 0;
  return { object: copy, history };
}
function movedAliasTarget(target, move) {
  if (typeof target === "string") {
    return move(target);
  }
  if (target && typeof target === "object") {
    const pair = target;
    const read = typeof pair.read === "string" ? move(pair.read) : void 0;
    const write = typeof pair.write === "string" ? move(pair.write) : void 0;
    if (read === void 0 && write === void 0) {
      return void 0;
    }
    return { ...pair, ...read !== void 0 ? { read } : {}, ...write !== void 0 ? { write } : {} };
  }
  return void 0;
}
async function retargetAliases(aliases, move, write) {
  var _a;
  let rewritten = 0;
  for (const [id, obj] of Object.entries(aliases)) {
    const alias = (_a = obj == null ? void 0 : obj.common) == null ? void 0 : _a.alias;
    if (!obj || !alias) {
      continue;
    }
    const moved = movedAliasTarget(alias.id, move);
    if (moved === void 0) {
      continue;
    }
    await write(id, { ...obj, common: { ...obj.common, alias: { ...alias, id: moved } } });
    rewritten++;
  }
  return rewritten;
}
function enumMembersUnder(enums, rootFull) {
  var _a;
  const ids = /* @__PURE__ */ new Set();
  for (const obj of Object.values(enums != null ? enums : {})) {
    const members = (_a = obj == null ? void 0 : obj.common) == null ? void 0 : _a.members;
    if (Array.isArray(members)) {
      for (const member of members) {
        if (typeof member === "string" && (member === rootFull || member.startsWith(`${rootFull}.`))) {
          ids.add(member);
        }
      }
    }
  }
  return [...ids].sort();
}
async function copyDeviceTree(deps, from, to, fillOnly = false) {
  var _a, _b;
  const fromFull = `${deps.namespace}.${from}`;
  const toFull = `${deps.namespace}.${to}`;
  const report = { datapoints: 0, enums: 0, aliases: 0, history: 0 };
  const all = await deps.objects();
  const complete = !fillOnly && ((_b = (_a = all[toFull]) == null ? void 0 : _a.native) == null ? void 0 : _b.idScheme) === import_device_id.ID_SCHEME;
  if (!complete) {
    const present = fillOnly ? await deps.states(`${toFull}.*`) : {};
    const tree = Object.entries(all).filter(
      (entry) => !!entry[1] && movedId(entry[0], fromFull, toFull) !== void 0
    ).sort(([a], [b]) => a.length - b.length);
    let deviceObject;
    for (const [id, obj] of tree) {
      const next = movedId(id, fromFull, toFull);
      if (fillOnly && all[next]) {
        continue;
      }
      const { object, history } = rewriteMovedObject(id, obj, fromFull, toFull);
      report.history += history;
      if (id === fromFull) {
        deviceObject = object;
        continue;
      }
      await deps.setObject(next, object);
      if (obj.type === "state") {
        report.datapoints++;
      }
    }
    if (deviceObject) {
      await deps.setObject(toFull, deviceObject);
    }
    const states = await deps.states(`${fromFull}.*`);
    for (const [id, state] of Object.entries(states)) {
      const next = movedId(id, fromFull, toFull);
      if (!next || !state || state.val === void 0) {
        continue;
      }
      const had = present[next];
      if (fillOnly && had && had.val !== null && had.val !== void 0) {
        continue;
      }
      await deps.setState(next, {
        val: state.val,
        ack: state.ack,
        ...typeof state.ts === "number" ? { ts: state.ts } : {},
        ...typeof state.lc === "number" ? { lc: state.lc } : {},
        ...typeof state.q === "number" ? { q: state.q } : {}
      });
    }
  }
  report.aliases = await retargetAliases(
    await deps.aliases(),
    (id) => movedId(id, fromFull, toFull),
    (id, obj) => deps.setObject(id, obj)
  );
  if (!complete && !fillOnly) {
    await deps.extendObject(toFull, { native: { idScheme: import_device_id.ID_SCHEME } });
  }
  return report;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  copyDeviceTree,
  enumMembersUnder,
  keepHistoryUnder,
  movedAliasTarget,
  movedId,
  retargetAliases,
  rewriteMovedObject
});
//# sourceMappingURL=device-move.js.map
