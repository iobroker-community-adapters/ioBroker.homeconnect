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
    expect(ownValueLabel("Cooking.Hob.EnumType.PowerLevel.90", "de")).toBeUndefined();
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
  it("keeps the cloud's label of a hob power level", () => {
    expect(valueLabel("Cooking.Hob.EnumType.PowerLevel.90", "de", "9.0")).toBe("9.0");
  });
});
