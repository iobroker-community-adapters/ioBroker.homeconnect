import { vi, describe, it, expect } from "vitest";

// value-transformer pulls in the adapter-core I18n for the adapter's own state
// names; loading the real module outside an adapter process exits Node.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: { getTranslatedObject: (key: string) => ({ en: key }), translate: (key: string) => key },
}));

import { EVENT_CATALOG, eventKeysForType, LOCKABLE_DOOR_TYPES, PROGRAMLESS_TYPES } from "./device-catalog";
import { stateIdForKey } from "./value-transformer";

describe("device catalog integrity", () => {
  it("covers every appliance type of the API", () => {
    // The 17 types the Home Connect API knows (device-type-catalog-2026-09-01.md).
    expect(Object.keys(EVENT_CATALOG).sort()).toEqual(
      [
        "AirConditioner",
        "CleaningRobot",
        "CoffeeMaker",
        "CookProcessor",
        "Dishwasher",
        "Dryer",
        "Freezer",
        "FridgeFreezer",
        "Hob",
        "Hood",
        "Microwave",
        "Oven",
        "Refrigerator",
        "WarmingDrawer",
        "Washer",
        "WasherDryer",
        "WineCooler",
      ].sort(),
    );
  });

  it("every catalog entry is an Event key that routes into the events channel", () => {
    for (const keys of Object.values(EVENT_CATALOG)) {
      for (const key of keys) {
        expect(key).toContain(".Event.");
        expect(stateIdForKey(key).channel).toBe("events");
      }
    }
  });

  it("holds the full per-type counts of the source catalog", () => {
    // Cross-checked against thoukydides' class registrations AND the 49 keys of
    // api-value-types.ts — a silently shrunken catalog would fail here.
    expect(eventKeysForType("CoffeeMaker")).toHaveLength(20);
    expect(eventKeysForType("Dishwasher")).toHaveLength(11);
    expect(eventKeysForType("WasherDryer")).toHaveLength(5);
    expect(eventKeysForType("CleaningRobot")).toHaveLength(7);
    expect(eventKeysForType("FridgeFreezer")).toHaveLength(3);
    expect(eventKeysForType("Hood")).toHaveLength(5);
    const union = new Set(Object.values(EVENT_CATALOG).flat());
    expect(union.size).toBe(49);
  });

  it("gives an unknown type no events (they still arrive via the stream)", () => {
    expect(eventKeysForType("SomethingNew")).toEqual([]);
    expect(eventKeysForType(undefined)).toEqual([]);
  });

  it("knows the door and program forms per type", () => {
    expect([...LOCKABLE_DOOR_TYPES].sort()).toEqual(["Dryer", "Microwave", "Oven", "Washer", "WasherDryer"]);
    expect(PROGRAMLESS_TYPES.has("FridgeFreezer")).toBe(true);
    expect(PROGRAMLESS_TYPES.has("WarmingDrawer")).toBe(false); // has programs despite zero events
    expect(PROGRAMLESS_TYPES.has("Dishwasher")).toBe(false);
    // The official API lists six air-conditioner programs (key research 2026-09-30).
    expect(PROGRAMLESS_TYPES.has("AirConditioner")).toBe(false);
  });
});
