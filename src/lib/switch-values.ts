// On/off as a switch (README "on/off as switches", decision 47, core decision H-02): a key whose every known value is on
// or off-like is a boolean datapoint, and the appliance's own value goes back on a write. Pure. The mapping follows Home
// Assistant's `home_connect` power switch (homeassistant/components/home_connect/switch.py, HomeConnectPowerSwitch): On
// is on; Off or Standby is off; switching off sends the off value the appliance reported itself, and only before it has
// reported one does Home Assistant fall back to "Off before Standby". Here that fallback first asks Home Connect's own
// PowerState table for the appliance type: an oven lists Off among its values, but takes only Standby.

import { ENUM_TYPE_VALUES, KEY_ENUM_TYPES, KEY_VALUE_NAMES } from "./enum-catalog";

/** Value tails that mean "off" — MainsOff too (the appliance off at the mains). */
const OFF_TAILS = ["off", "standby", "mainsoff"] as const;
/** Value tails a switch key may carry besides on/off: `Undefined` is no value at all. */
const NO_VALUE_TAILS = ["undefined"];

/**
 * The lower-case last segment of a value.
 *
 * @param value a full BSH value or a bare name
 * @returns its tail
 */
function tail(value: string): string {
  return (value.split(".").at(-1) ?? "").toLowerCase();
}

/**
 * Whether a key is an on/off switch: every value the catalogue knows for it is on, off-like or "undefined", and it
 * has On plus an off-like value. `MicrowavePower` or `MeatProbeTemperatureV2`, of which the sources only know "Off",
 * stay lists — their other values are unknown, not absent.
 *
 * @param key the fully-qualified BSH key
 * @returns whether the key's datapoint is a boolean
 */
export function isSwitchKey(key: string): boolean {
  const type = KEY_ENUM_TYPES[key];
  return isSwitchValueSet(type !== undefined ? ENUM_TYPE_VALUES[type] : KEY_VALUE_NAMES[key]);
}

/**
 * Whether a set of values is an on/off switch: On plus an off-like value, and nothing else but "undefined".
 *
 * @param names the full values or bare value names
 * @returns whether they make a switch
 */
export function isSwitchValueSet(names: readonly string[] | undefined): boolean {
  if (!names || names.length === 0) {
    return false;
  }
  const tails = names.map(tail);
  return (
    tails.includes("on") &&
    tails.some(t => (OFF_TAILS as readonly string[]).includes(t)) &&
    tails.every(t => t === "on" || (OFF_TAILS as readonly string[]).includes(t) || NO_VALUE_TAILS.includes(t))
  );
}

/**
 * The switch state of a value the appliance sent.
 *
 * @param value the value off the wire
 * @returns true for On, false for an off-like value, undefined for anything else (no value)
 */
export function switchState(value: unknown): boolean | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const t = tail(value);
  if (t === "on") {
    return true;
  }
  return (OFF_TAILS as readonly string[]).includes(t) ? false : undefined;
}

/** The appliance's power, the one on/off key with a role of its own (`switch.power`). */
const POWER_STATE_KEY = "BSH.Common.Setting.PowerState";

/**
 * Home Connect's PowerState table: the off values each appliance type takes (api-docs.home-connect.com, the docs
 * bundle's `power-state-availability.json`, read 2026-11-05). The table names Cooktop and CoffeeMachine; the API types
 * are Hob and CoffeeMaker. A type the table lists no off value for (refrigeration, laundry) is not here. The list an
 * appliance itself sends can name a value the table does not: an oven offers MainsOff, Off, On and Standby and refuses
 * Off with `NotAvailableByList` (Siemens HN878G4S6, forum 85641; HM836GNB6, Home Assistant #146889).
 */
const POWER_OFF_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  AirConditioner: ["standby"],
  Oven: ["standby"],
  WarmingDrawer: ["standby"],
  Dishwasher: ["off"],
  Microwave: ["off", "standby"],
  CoffeeMaker: ["standby"],
  Hob: ["off"],
  Hood: ["off"],
  CleaningRobot: ["standby"],
  CookProcessor: ["standby"],
};

/** What a switch-off write knows besides the offered values. */
export interface SwitchHint {
  /** The off value the appliance last reported itself for this key. */
  reported?: string;
  /** The appliance type ("Oven", …). */
  applianceType?: string;
  /** The fully-qualified BSH key written. */
  key?: string;
}

/**
 * The appliance's value for a switch write. On is On. Off is, in this order: the off value the appliance last reported
 * itself; for the power state, the one off value Home Connect's table names for the appliance type; Off, else Standby,
 * else MainsOff. Each only where the appliance offers it.
 *
 * @param on the written switch state
 * @param bshValues the full values the appliance offers
 * @param hint what else is known about the appliance
 * @returns the full value to send, or undefined when the appliance offers none for that state
 */
export function switchValue(on: boolean, bshValues: readonly string[], hint: SwitchHint = {}): string | undefined {
  const offered = (t: string): string | undefined => bshValues.find(v => tail(v) === t);
  if (on) {
    return offered("on");
  }
  if (hint.reported !== undefined && switchState(hint.reported) === false) {
    const hit = offered(tail(hint.reported));
    if (hit) {
      return hit;
    }
  }
  const listed = hint.key === POWER_STATE_KEY ? POWER_OFF_BY_TYPE[hint.applianceType ?? ""] : undefined;
  if (listed?.length === 1) {
    const hit = offered(listed[0]);
    if (hit) {
      return hit;
    }
  }
  for (const t of OFF_TAILS) {
    const hit = offered(t);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/**
 * The role of an on/off switch: `switch.power` for the appliance's power, `switch` for any other, `indicator` where
 * the appliance only reports it.
 *
 * @param key the fully-qualified BSH key
 * @param writable whether it can be switched
 * @returns the role
 */
export function switchRole(key: string, writable: boolean): string {
  if (!writable) {
    return "indicator";
  }
  return key === POWER_STATE_KEY ? "switch.power" : "switch";
}
