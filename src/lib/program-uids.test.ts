import { describe, expect, it } from "vitest";

import { PROGRAM_UIDS } from "./program-uids";

describe("PROGRAM_UIDS", () => {
  // Two series of one type can fill the same block of numbers with different programs: the oven dish programs from
  // 12288 on are Dish.Recommendation.Konv.* on a NEFF B47CS22G0 and Dish.Automatic.Conv.* on a BOSCH HRG7784B1 (Kessel
  // test profile oven-tls.zip, FeatureMapping) — 12296 is a white loaf in a tin on one and a vegetable stew on the other.
  it("leaves out the oven dish block that two series number differently", () => {
    const oven = PROGRAM_UIDS.Oven ?? {};
    const inBlock = Object.keys(oven)
      .map(Number)
      .filter(uid => uid >= 12288 && uid <= 12341);
    expect(inBlock).toEqual([]);
  });

  it("keeps the oven heating modes and the cleaning both descriptions agree on", () => {
    const oven = PROGRAM_UIDS.Oven ?? {};
    expect(oven[8208]).toBe("Cooking.Oven.Program.HeatingMode.HotAir");
    expect(oven[8209]).toBe("Cooking.Oven.Program.HeatingMode.TopBottomHeating");
    expect(oven[8233]).toBe("Cooking.Oven.Program.HeatingMode.Defrost");
    expect(oven[9226]).toBe("Cooking.Oven.Program.Cleaning.EasyClean");
  });
});
