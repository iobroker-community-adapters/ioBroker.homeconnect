import { describe, it, expect } from "vitest";
import { isSwitchKey, isSwitchValueSet, switchRole, switchState, switchValue } from "./switch-values";

describe("on/off switches (decision 47)", () => {
  it("takes a value set as a switch only for On plus an off-like value, and nothing else but Undefined", () => {
    expect(isSwitchValueSet(["Off", "On"])).toBe(true);
    expect(isSwitchValueSet(["On", "Standby", "Undefined"])).toBe(true);
    expect(isSwitchValueSet(["X.EnumType.P.MainsOff", "X.EnumType.P.On"])).toBe(true);
    // No off value: nothing to switch to.
    expect(isSwitchValueSet(["On", "Undefined"])).toBe(false);
    // Only off: the other values are unknown, not absent.
    expect(isSwitchValueSet(["Off"])).toBe(false);
    // On and Off among further choices: a list.
    expect(isSwitchValueSet(["Off", "On", "Plus1", "Plus2"])).toBe(false);
    expect(isSwitchValueSet([])).toBe(false);
    expect(isSwitchValueSet(undefined)).toBe(false);
  });

  it("knows the switch keys of the catalogue", () => {
    expect(isSwitchKey("BSH.Common.Setting.PowerState")).toBe(true);
    expect(isSwitchKey("Dishcare.Dishwasher.Setting.TimeLight")).toBe(true);
    expect(isSwitchKey("Cooking.Oven.Option.SteamAssistLevel")).toBe(true);
    expect(isSwitchKey("LaundryCare.Washer.Option.MultipleSoak")).toBe(false);
    expect(isSwitchKey("Cooking.Oven.Option.MicrowavePower")).toBe(false);
    expect(isSwitchKey("X.Y.Setting.Unknown")).toBe(false);
  });

  it("reads On as on, an off-like value as off, anything else as no value", () => {
    expect(switchState("BSH.Common.EnumType.PowerState.On")).toBe(true);
    expect(switchState("BSH.Common.EnumType.PowerState.Standby")).toBe(false);
    expect(switchState("on")).toBe(true);
    expect(switchState("BSH.Common.EnumType.PowerState.Undefined")).toBeUndefined();
    expect(switchState("")).toBeUndefined();
    expect(switchState(1)).toBeUndefined();
  });

  it("switches off with Off first, then Standby, then MainsOff", () => {
    const p = "BSH.Common.EnumType.PowerState";
    expect(switchValue(true, [`${p}.Off`, `${p}.On`])).toBe(`${p}.On`);
    expect(switchValue(false, [`${p}.Standby`, `${p}.Off`, `${p}.On`])).toBe(`${p}.Off`);
    expect(switchValue(false, [`${p}.MainsOff`, `${p}.Standby`, `${p}.On`])).toBe(`${p}.Standby`);
    expect(switchValue(false, [`${p}.MainsOff`, `${p}.On`])).toBe(`${p}.MainsOff`);
    expect(switchValue(false, [`${p}.On`])).toBeUndefined();
  });

  it("gives the power its own role and a switch the appliance only reports an indicator", () => {
    expect(switchRole("BSH.Common.Setting.PowerState", true)).toBe("switch.power");
    expect(switchRole("Dishcare.Dishwasher.Setting.TimeLight", true)).toBe("switch");
    expect(switchRole("BSH.Common.Setting.PowerState", false)).toBe("indicator");
  });
});
