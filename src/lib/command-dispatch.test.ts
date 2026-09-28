import { vi, describe, it, expect } from "vitest";

// value-transformer pulls in the adapter-core I18n for the adapter's own state
// names; loading the real module outside an adapter process exits Node.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

import { resolveWrite, resolveEnum, ambiguousCandidates } from "./command-dispatch";

const HA = "SIEMENS-HCS02DWH1-0123456789AB";
const base = `/api/homeappliances/${HA}`;

describe("resolveWrite", () => {
  it("writes a boolean setting through as-is", () => {
    expect(
      resolveWrite({
        haId: HA,
        channel: "settings",
        id: "childLock",
        bshKey: "BSH.Common.Setting.ChildLock",
        value: true,
      }),
    ).toEqual({
      method: "PUT",
      path: `${base}/settings/BSH.Common.Setting.ChildLock`,
      body: { key: "BSH.Common.Setting.ChildLock", value: true },
    });
  });

  it("resolves a short enum setting back to its full BSH value", () => {
    const req = resolveWrite({
      haId: HA,
      channel: "settings",
      id: "powerState",
      bshKey: "BSH.Common.Setting.PowerState",
      bshValues: ["BSH.Common.EnumType.PowerState.On", "BSH.Common.EnumType.PowerState.Standby"],
      value: "standby",
    });
    expect(req?.body?.value).toBe("BSH.Common.EnumType.PowerState.Standby");
  });

  it("ignores an enum setting write whose short value matches no candidate", () => {
    expect(
      resolveWrite({
        haId: HA,
        channel: "settings",
        id: "powerState",
        bshKey: "BSH.Common.Setting.PowerState",
        bshValues: ["BSH.Common.EnumType.PowerState.On"],
        value: "bogus",
      }),
    ).toBeNull();
  });

  it("fires a command only on a true write", () => {
    const key = "BSH.Common.Command.PauseProgram";
    expect(resolveWrite({ haId: HA, channel: "commands", id: "pauseProgram", bshKey: key, value: true })).toEqual({
      method: "PUT",
      path: `${base}/commands/${key}`,
      body: { key, value: true },
    });
    expect(resolveWrite({ haId: HA, channel: "commands", id: "pauseProgram", bshKey: key, value: false })).toBeNull();
  });

  it("selects a program by resolving the short value to its full program key", () => {
    const req = resolveWrite({
      haId: HA,
      channel: "programs",
      id: "selectedProgram",
      bshKey: "BSH.Common.Root.SelectedProgram",
      bshValues: ["Dishcare.Dishwasher.Program.Eco50", "Dishcare.Dishwasher.Program.Auto2"],
      value: "auto2",
    });
    expect(req).toEqual({
      method: "PUT",
      path: `${base}/programs/selected`,
      body: { key: "Dishcare.Dishwasher.Program.Auto2" },
    });
  });

  it("writes a program option to the selected program, resolving an enum value", () => {
    const req = resolveWrite({
      haId: HA,
      channel: "options",
      id: "spinSpeed",
      bshKey: "LaundryCare.Washer.Option.SpinSpeed",
      bshValues: ["LaundryCare.Washer.EnumType.SpinSpeed.RPM800", "LaundryCare.Washer.EnumType.SpinSpeed.RPM1200"],
      value: "rpm800",
    });
    expect(req).toEqual({
      method: "PUT",
      path: `${base}/programs/selected/options/LaundryCare.Washer.Option.SpinSpeed`,
      body: { key: "LaundryCare.Washer.Option.SpinSpeed", value: "LaundryCare.Washer.EnumType.SpinSpeed.RPM800" },
    });
  });

  it("writes a numeric option through as-is", () => {
    const req = resolveWrite({
      haId: HA,
      channel: "options",
      id: "startInRelative",
      bshKey: "BSH.Common.Option.StartInRelative",
      value: 3600,
    });
    expect(req?.body).toEqual({ key: "BSH.Common.Option.StartInRelative", value: 3600 });
  });

  it("starts the currently selected program", () => {
    expect(
      resolveWrite({
        haId: HA,
        channel: "programs",
        id: "start",
        value: true,
        selectedProgramKey: "Dishcare.Dishwasher.Program.Eco50",
      }),
    ).toEqual({ method: "PUT", path: `${base}/programs/active`, body: { key: "Dishcare.Dishwasher.Program.Eco50" } });
  });

  it("starts with the collected options when there are any", () => {
    const req = resolveWrite({
      haId: HA,
      channel: "programs",
      id: "start",
      value: true,
      selectedProgramKey: "LaundryCare.Washer.Program.Cotton",
      selectedOptions: [
        { key: "LaundryCare.Washer.Option.SpinSpeed", value: "LaundryCare.Washer.EnumType.SpinSpeed.RPM1200" },
      ],
    });
    expect(req?.body).toEqual({
      key: "LaundryCare.Washer.Program.Cotton",
      options: [{ key: "LaundryCare.Washer.Option.SpinSpeed", value: "LaundryCare.Washer.EnumType.SpinSpeed.RPM1200" }],
    });
  });

  it("ignores start when no program is selected", () => {
    expect(resolveWrite({ haId: HA, channel: "programs", id: "start", value: true })).toBeNull();
  });

  it("stops the active program with a DELETE", () => {
    expect(resolveWrite({ haId: HA, channel: "programs", id: "stop", value: true })).toEqual({
      method: "DELETE",
      path: `${base}/programs/active`,
    });
  });

  it("ignores an unrecognized state", () => {
    expect(resolveWrite({ haId: HA, channel: "status", id: "operationState", value: "run" })).toBeNull();
  });
});

describe("resolveWrite remaining paths", () => {
  const base = { haId: "HA-1", value: 1 as ioBroker.StateValue };

  it("sends an option to the SELECTED program, not the active one", () => {
    // Writing to the active program 409s in most appliance states — one
    // predictable target beats a write that works only while idle.
    expect(
      resolveWrite({ ...base, channel: "options", id: "spinSpeed", bshKey: "LaundryCare.Washer.Option.SpinSpeed" }),
    ).toEqual({
      method: "PUT",
      path: "/api/homeappliances/HA-1/programs/selected/options/LaundryCare.Washer.Option.SpinSpeed",
      body: { key: "LaundryCare.Washer.Option.SpinSpeed", value: 1 },
    });
  });

  it("ignores an option written with a value outside its candidates", () => {
    expect(
      resolveWrite({
        ...base,
        channel: "options",
        id: "temperature",
        bshKey: "LaundryCare.Washer.Option.Temperature",
        bshValues: ["LaundryCare.Washer.EnumType.Temperature.GC40"],
        value: "gc90",
      }),
    ).toBeNull();
  });

  it("stops the active program with a DELETE, and only on a true", () => {
    expect(resolveWrite({ ...base, channel: "programs", id: "stop", value: true })).toEqual({
      method: "DELETE",
      path: "/api/homeappliances/HA-1/programs/active",
    });
    // A button falling back to false is the reset, not a second command.
    expect(resolveWrite({ ...base, channel: "programs", id: "stop", value: false })).toBeNull();
  });

  it("ignores a state it has no mapping for", () => {
    expect(resolveWrite({ ...base, channel: "status", id: "doorState" })).toBeNull();
    expect(resolveWrite({ ...base, channel: "programs", id: "somethingElse", value: true })).toBeNull();
    // Without a BSH key there is no endpoint to send to.
    expect(resolveWrite({ ...base, channel: "settings", id: "powerState" })).toBeNull();
    expect(resolveWrite({ ...base, channel: "options", id: "spinSpeed" })).toBeNull();
    expect(resolveWrite({ ...base, channel: "commands", id: "pause", value: true })).toBeNull();
  });
});

describe("resolveWrite enum spelling (2026-09-15, §7.2)", () => {
  const ctx = {
    haId: HA,
    channel: "settings",
    id: "powerState",
    bshKey: "BSH.Common.Setting.PowerState",
    bshValues: ["BSH.Common.EnumType.PowerState.On", "BSH.Common.EnumType.PowerState.Standby"],
  };

  it("accepts any casing and the full BSH value", () => {
    // "On" from a script or the full key from a copied value meant the same
    // thing — and were refused on debug, invisible to the user.
    for (const value of ["on", "On", "ON", "BSH.Common.EnumType.PowerState.On", "bsh.common.enumtype.powerstate.on"]) {
      expect(resolveWrite({ ...ctx, value })?.body?.value).toBe("BSH.Common.EnumType.PowerState.On");
    }
  });

  it("still refuses a value the appliance does not offer", () => {
    expect(resolveWrite({ ...ctx, value: "off" })).toBeNull();
    expect(resolveWrite({ ...ctx, value: "Standby!" })).toBeNull();
  });
});

describe("resolveEnum (audit 2026-09-24, F6/F7)", () => {
  const heat = "Cooking.Oven.Program.HeatingMode.DoughProving";
  const steam = "Cooking.Oven.Program.SteamModes.DoughProving";
  const bake = "Cooking.Oven.Program.HeatingMode.PizzaSetting";

  it("resolves the full value, the list-unique short value and an unambiguous bare word", () => {
    expect(resolveEnum(steam, [heat, steam, bake])).toBe(steam);
    expect(resolveEnum("steammodes.doughproving", [heat, steam, bake])).toBe(steam);
    expect(resolveEnum("PizzaSetting", [heat, steam, bake])).toBe(bake);
  });

  it("resolves the two-segment form the dropdown shows when only the offered list is at hand", () => {
    // The dropdown makes short values unique across the offer PLUS the programs
    // the appliance only ran; the write candidates are the offer alone — there the
    // program has no collision, yet the dropdown value is its two-segment form.
    expect(resolveEnum("heatingmode.doughproving", [heat, bake])).toBe(heat);
  });

  it("refuses a bare word that names two different programs", () => {
    expect(resolveEnum("doughproving", [heat, steam])).toBeUndefined();
    expect(ambiguousCandidates("DoughProving", [heat, steam, bake])).toEqual([heat, steam]);
    expect(ambiguousCandidates("pizzasetting", [heat, steam, bake])).toEqual([]);
  });

  it("takes the first of several matches when they mean the same thing (one option, two families)", () => {
    const dryer = "LaundryCare.Dryer.EnumType.DryingTarget.IronDry";
    const wd = "LaundryCare.WasherDryer.EnumType.DryingTargetWD.IronDry";
    expect(resolveEnum("irondry", [dryer, wd], true)).toBe(dryer);
    expect(resolveEnum(42, [dryer])).toBeUndefined();
  });
});
