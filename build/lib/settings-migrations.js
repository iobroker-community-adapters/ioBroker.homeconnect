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
var settings_migrations_exports = {};
__export(settings_migrations_exports, {
  SETTINGS_MIGRATIONS: () => SETTINGS_MIGRATIONS
});
module.exports = __toCommonJS(settings_migrations_exports);
const SETTINGS_MIGRATIONS = [
  { drop: "authUri" },
  { drop: "disableFetchConnect" },
  { drop: "language" },
  { drop: "mySelect" },
  { drop: "ownRequest" },
  { drop: "password" },
  { drop: "resetAccess" },
  { drop: "scope" },
  { drop: "test1" },
  { drop: "test2" },
  { drop: "username" },
  { commonDrop: "license" },
  { commonDrop: "main" },
  { commonDrop: "materialize" },
  { commonDrop: "nogit" },
  { commonDrop: "plugins" },
  { commonDrop: "restartAdapters" },
  { commonDrop: "supportCustoms" }
];
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SETTINGS_MIGRATIONS
});
//# sourceMappingURL=settings-migrations.js.map
