// On/off as a switch (README "on/off as switches", decision 47): a key whose every known value is on or off-like is a
// boolean datapoint, and the appliance's own value goes back on a write. Pure. The mapping follows Home Assistant's
// `home_connect` power switch (homeassistant/components/home_connect/switch.py, HomeConnectPowerSwitch): On is on; Off
// or Standby is off; switching off sends Off where the appliance offers it, else Standby.

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

/**
 * The appliance's value for a switch write: On, or the first off-like value it offers (Off, else Standby, else
 * MainsOff).
 *
 * @param on the written switch state
 * @param bshValues the full values the appliance offers
 * @returns the full value to send, or undefined when the appliance offers none for that state
 */
export function switchValue(on: boolean, bshValues: readonly string[]): string | undefined {
  const wanted = on ? ["on"] : OFF_TAILS;
  for (const w of wanted) {
    const hit = bshValues.find(v => tail(v) === w);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/** The appliance's power, the one on/off key with a role of its own (`switch.power`). */
const POWER_STATE_KEY = "BSH.Common.Setting.PowerState";

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
