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
var device_internal_exports = {};
__export(device_internal_exports, {
  isDeviceInternalKey: () => isDeviceInternalKey
});
module.exports = __toCommonJS(device_internal_exports);
const DEVICE_INTERNAL_KEYS = /* @__PURE__ */ new Set([
  // Always true over the cloud — a disconnected appliance reports nothing; reachability is `info.reachable`.
  "BSH.Common.Status.BackendConnected",
  // Writable: false forbids the cloud connection, and with it the adapter; only the app switches it back.
  "BSH.Common.Setting.AllowBackendConnection",
  // One press switches the appliance's Wi-Fi off — the adapter is gone.
  "BSH.Common.Command.DeactivateWiFi",
  // The appliance's internal number of an update transaction.
  "BSH.Common.Status.SoftwareUpdateTransactionID"
]);
const FIRMWARE_VERSION = /\.Status\.Version\./;
function isDeviceInternalKey(key) {
  return DEVICE_INTERNAL_KEYS.has(key) || FIRMWARE_VERSION.test(key);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isDeviceInternalKey
});
//# sourceMappingURL=device-internal.js.map
