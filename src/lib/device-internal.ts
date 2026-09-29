// Keys that describe the appliance's own connection or firmware, not what it does (decision 48). They never
// become a datapoint on any appliance type: the extended data access delivers them undocumented, and some of
// them cut the adapter off. Sources, across appliance types (not one household): the appliance descriptions
// in `Ressourcen/homeconnect/device-dumps-2026-09-07/` and `werte-recherche-2026-09-28/uid_tables.json`
// (openHAB homeconnectdirect, chris-mc1, SMH4ECX14E, WQ46B2C40), hcpy, and Home Assistant `home_connect`,
// which creates entities from a fixed key list that names none of them.

/** The single keys of the class. */
const DEVICE_INTERNAL_KEYS: ReadonlySet<string> = new Set([
  // Always true over the cloud — a disconnected appliance reports nothing; reachability is `info.reachable`.
  "BSH.Common.Status.BackendConnected",
  // Writable: false forbids the cloud connection, and with it the adapter; only the app switches it back.
  "BSH.Common.Setting.AllowBackendConnection",
  // One press switches the appliance's Wi-Fi off — the adapter is gone.
  "BSH.Common.Command.DeactivateWiFi",
  // The appliance's internal number of an update transaction.
  "BSH.Common.Status.SoftwareUpdateTransactionID",
]);

/** Firmware identifiers: `LaundryCare.Common.Status.Version.Smm.DomainFw`, `…Version.E2e.Scope` … */
const FIRMWARE_VERSION = /\.Status\.Version\./;

/**
 * Whether a BSH key is one of the appliance-internal keys that never become a datapoint.
 *
 * @param key the fully-qualified BSH key
 * @returns whether the key is left out
 */
export function isDeviceInternalKey(key: string): boolean {
  return DEVICE_INTERNAL_KEYS.has(key) || FIRMWARE_VERSION.test(key);
}
