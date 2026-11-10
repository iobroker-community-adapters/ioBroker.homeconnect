import { describe, expect, it } from "vitest";

import { ownValueLabel, valueLabel } from "./value-labels";

describe("ownValueLabel", () => {
  it("labels a word tail the same in every family", () => {
    expect(ownValueLabel("LaundryCare.Washer.Program.Wool", "en")).toBe(
      ownValueLabel("LaundryCare.WasherDryer.Program.Wool.Wool.Wool", "en"),
    );
  });

  // A number names nothing on its own: "90" is a wash-and-dry program in one family and a hob power level of 9.0 in
  // another (Cooking.Hob.EnumType.PowerLevel.90, displayvalue "9.0" — aiohomeconnect PR #203, ekutner#547/#553).
  it("labels a numeric tail only together with the segment before it", () => {
    expect(ownValueLabel("LaundryCare.Washer.Program.WashAndDry.60", "de")).toBe("Waschen & Trocknen 60'");
    expect(ownValueLabel("LaundryCare.WasherDryer.Program.WashAndDry.120", "en")).toBe("Wash & dry 120'");
    expect(ownValueLabel("BSH.Common.Program.Favorite.001", "de")).toBe("Favorit 1");
    expect(ownValueLabel("Cooking.Hob.EnumType.PowerLevel.90", "de")).toBe("9.0");
    expect(ownValueLabel("LaundryCare.Washer.Program.Cotton.20", "en")).toBeUndefined();
  });

  it("gives a bare number no label", () => {
    expect(ownValueLabel("60", "en")).toBeUndefined();
    expect(ownValueLabel("001", "en")).toBeUndefined();
  });

  it("labels the two-segment short value of a colliding list like the full value", () => {
    expect(ownValueLabel("washanddry.60", "en")).toBe("Wash & dry 60'");
  });
});

describe("valueLabel", () => {
  it("takes its own label of a hob power level over the cloud's, in the system language", () => {
    expect(valueLabel("Cooking.Hob.EnumType.PowerLevel.90", "ru", "9.0")).toBe("9,0");
  });
});

// The values of the hob options, as the Home Connect app names them (app 12.6.0, key catalogue and resources):
// zones by position, levels in tenths up to 12.0, two boosts, frying levels 1–5.
describe("hob values", () => {
  it("labels the cooking zones by their position", () => {
    expect(ownValueLabel("Cooking.Hob.EnumType.ZoneSelector.FrontLeft", "de")).toBe("Vorne links");
    expect(ownValueLabel("Cooking.Hob.EnumType.ZoneSelector.RearRightAdd1", "en")).toBe("Rear right, extension");
    expect(ownValueLabel("Cooking.Hob.EnumType.ZoneSelector.LeftPartOfRight", "en")).toBe("Right zone, left part");
    expect(ownValueLabel("Cooking.Hob.EnumType.ZoneSelector.Moveable003", "de")).toBe("Kochzone 3");
  });

  it("labels the power levels in tenths and the two boosts", () => {
    expect(ownValueLabel("Cooking.Hob.EnumType.PowerLevel.15", "en")).toBe("1.5");
    expect(ownValueLabel("Cooking.Hob.EnumType.PowerLevel.120", "fr")).toBe("12,0");
    expect(ownValueLabel("Cooking.Hob.EnumType.PowerLevel.PowerLevel07", "de")).toBe("7.0");
    expect(ownValueLabel("Cooking.Hob.EnumType.PowerLevel.Boost1", "de")).toBe("Pfannen-Boost");
    expect(ownValueLabel("Cooking.Hob.EnumType.PowerLevel.Boost2", "de")).toBe("Topf-Boost");
  });

  it("labels every frying sensor level", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(ownValueLabel(`Cooking.Hob.EnumType.FryingSensorLevel.Level0${n}`, "de")).toBe(`Stufe ${n}`);
    }
  });
});
