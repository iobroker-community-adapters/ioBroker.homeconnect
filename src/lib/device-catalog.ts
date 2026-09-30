// Device-type catalog — which events exist per appliance type, which door form a
// type has, and which types have no programs at all. Events never appear in any
// REST response (they only ever arrive over the stream), so creating them upfront
// — every datapoint exists from the first sync, none appears only on first use —
// requires this catalog. Source, verbatim and cross-checked against the full type
// list in api-value-types.ts: Ressourcen/homeconnect/device-type-catalog-2026-09-01.md
// (thoukydides/homebridge-homeconnect, the most complete typed API mapping).
//
// Every Home Connect appliance type is first-class here — the adapter is built
// for the whole community of users and whatever appliances they own.

const PROGRAM_FINISHED = "BSH.Common.Event.ProgramFinished";
const PROGRAM_ABORTED = "BSH.Common.Event.ProgramAborted";
const ALARM_CLOCK_ELAPSED = "BSH.Common.Event.AlarmClockElapsed";
const FAVORITE_1 = "BSH.Common.Event.Favorite.001.ExternalTrigger";
const FAVORITE_2 = "BSH.Common.Event.Favorite.002.ExternalTrigger";

/** The catalog of event keys per appliance type (`homeappliances[].type`). */
export const EVENT_CATALOG: Readonly<Record<string, readonly string[]>> = {
  Dishwasher: [
    PROGRAM_FINISHED,
    PROGRAM_ABORTED,
    "Dishcare.Dishwasher.Event.SaltNearlyEmpty",
    "Dishcare.Dishwasher.Event.SaltLack",
    "Dishcare.Dishwasher.Event.ProgramBlockedSaltLack",
    "Dishcare.Dishwasher.Event.RinseAidNearlyEmpty",
    "Dishcare.Dishwasher.Event.RinseAidLack",
    "Dishcare.Dishwasher.Event.MachineCareReminder",
    "Dishcare.Dishwasher.Event.MachineCareAndFilterCleaningReminder",
    "Dishcare.Dishwasher.Event.MachineCareAndLowMaintenanceFilterCleaningReminder",
    "Dishcare.Dishwasher.Event.SmartFilterCleaningReminder",
  ],
  Washer: [
    PROGRAM_FINISHED,
    PROGRAM_ABORTED,
    "LaundryCare.Washer.Event.IDos1FillLevelPoor",
    "LaundryCare.Washer.Event.IDos2FillLevelPoor",
  ],
  Dryer: [PROGRAM_FINISHED, PROGRAM_ABORTED, "LaundryCare.Dryer.Event.DryingProcessFinished"],
  WasherDryer: [
    PROGRAM_FINISHED,
    PROGRAM_ABORTED,
    "LaundryCare.Washer.Event.IDos1FillLevelPoor",
    "LaundryCare.Washer.Event.IDos2FillLevelPoor",
    "LaundryCare.Dryer.Event.DryingProcessFinished",
  ],
  CleaningRobot: [
    PROGRAM_FINISHED,
    PROGRAM_ABORTED,
    "ConsumerProducts.CleaningRobot.Event.EmptyDustBoxAndCleanFilter",
    "ConsumerProducts.CleaningRobot.Event.RobotIsStuck",
    "ConsumerProducts.CleaningRobot.Event.DockingStationNotFound",
    "ConsumerProducts.CleaningRobot.Event.DustBin.NotInstalled",
    "ConsumerProducts.CleaningRobot.Event.Robot.Lifted",
  ],
  CoffeeMaker: [
    "ConsumerProducts.CoffeeMaker.Event.BeanContainerEmpty",
    "ConsumerProducts.CoffeeMaker.Event.WaterTankEmpty",
    "ConsumerProducts.CoffeeMaker.Event.DripTrayFull",
    "ConsumerProducts.CoffeeMaker.Event.DescalingIn20Cups",
    "ConsumerProducts.CoffeeMaker.Event.DescalingIn15Cups",
    "ConsumerProducts.CoffeeMaker.Event.DescalingIn10Cups",
    "ConsumerProducts.CoffeeMaker.Event.DescalingIn5Cups",
    "ConsumerProducts.CoffeeMaker.Event.DeviceShouldBeDescaled",
    "ConsumerProducts.CoffeeMaker.Event.DeviceDescalingOverdue",
    "ConsumerProducts.CoffeeMaker.Event.DeviceDescalingBlockage",
    "ConsumerProducts.CoffeeMaker.Event.DeviceShouldBeCleaned",
    "ConsumerProducts.CoffeeMaker.Event.DeviceCleaningOverdue",
    "ConsumerProducts.CoffeeMaker.Event.CalcNCleanIn20Cups",
    "ConsumerProducts.CoffeeMaker.Event.CalcNCleanIn15Cups",
    "ConsumerProducts.CoffeeMaker.Event.CalcNCleanIn10Cups",
    "ConsumerProducts.CoffeeMaker.Event.CalcNCleanIn5Cups",
    "ConsumerProducts.CoffeeMaker.Event.DeviceShouldBeCalcNCleaned",
    "ConsumerProducts.CoffeeMaker.Event.DeviceCalcNCleanOverdue",
    "ConsumerProducts.CoffeeMaker.Event.DeviceCalcNCleanBlockage",
    "ConsumerProducts.CoffeeMaker.Event.KeepMilkTankCool",
  ],
  Oven: [
    PROGRAM_FINISHED,
    PROGRAM_ABORTED,
    ALARM_CLOCK_ELAPSED,
    "Cooking.Oven.Event.PreheatFinished",
    "Cooking.Oven.Event.RegularPreheatFinished",
  ],
  Microwave: [PROGRAM_FINISHED, PROGRAM_ABORTED],
  // No ProgramAborted on a hob — verified against the class registrations.
  Hob: [PROGRAM_FINISHED, ALARM_CLOCK_ELAPSED, "Cooking.Oven.Event.PreheatFinished", FAVORITE_1, FAVORITE_2],
  Hood: [
    PROGRAM_FINISHED,
    "Cooking.Common.Event.Hood.GreaseFilterMaxSaturationNearlyReached",
    "Cooking.Common.Event.Hood.GreaseFilterMaxSaturationReached",
    FAVORITE_1,
    FAVORITE_2,
  ],
  CookProcessor: [PROGRAM_FINISHED, PROGRAM_ABORTED],
  WarmingDrawer: [],
  FridgeFreezer: [
    "Refrigeration.FridgeFreezer.Event.DoorAlarmFreezer",
    "Refrigeration.FridgeFreezer.Event.DoorAlarmRefrigerator",
    "Refrigeration.FridgeFreezer.Event.TemperatureAlarmFreezer",
  ],
  Freezer: [
    "Refrigeration.FridgeFreezer.Event.DoorAlarmFreezer",
    "Refrigeration.FridgeFreezer.Event.TemperatureAlarmFreezer",
  ],
  Refrigerator: ["Refrigeration.FridgeFreezer.Event.DoorAlarmRefrigerator"],
  WineCooler: [],
  AirConditioner: [],
};

/**
 * The event keys to create upfront for an appliance type. An unknown type gets
 * none — events for it are still created the moment they first arrive over the
 * stream (nothing is lost, just not pre-created; the catalog is then extended).
 *
 * @param haType the appliance type from the API (e.g. "WasherDryer")
 * @returns the catalog event keys, or an empty list for an unknown type
 */
export function eventKeysForType(haType: string | undefined): readonly string[] {
  return (haType && EVENT_CATALOG[haType]) || [];
}

/** Types whose door can be locked → they get `status.doorLocked` next to `status.doorOpen`. */
export const LOCKABLE_DOOR_TYPES: ReadonlySet<string> = new Set([
  "Oven",
  "Microwave",
  "Washer",
  "Dryer",
  "WasherDryer",
]);

/**
 * Types without any programs → no `programs.*` channel is created (an existing one is migrated away). The air
 * conditioner is not one of them: the official API lists six programs and three options for it (Active clean,
 * Auto, Cool, Dry, Fan, Heat; key research 2026-09-30) — the type source's class only lacks the mixin.
 */
export const PROGRAMLESS_TYPES: ReadonlySet<string> = new Set([
  "Freezer",
  "FridgeFreezer",
  "Refrigerator",
  "WineCooler",
]);
