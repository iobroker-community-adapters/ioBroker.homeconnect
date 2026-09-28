// The adapter's own texts for the datapoints it knows: a readable name where
// Home Connect delivers none (the catalog events never appear in a REST answer),
// and a short plain-language description for every datapoint whose meaning is
// the same on every appliance.
//
// Fleet rule (krobi 2026-09-02): the description is an explanation a user can
// read, never the manufacturer's key. And EVERY datapoint gets one — krobi
// 2026-09-07: "why can't you translate EVERYTHING, whether my machines use it or
// anybody else's". Where the manufacturer documents nothing and
// the value is opaque, the honest sentence says exactly that; what is never
// allowed is an invented meaning, and what is no longer allowed is silence.
//
// Every appliance type is first-class here, not only the ones we can test with.

import type { I18nKey } from "./i18n";

/** The texts for one BSH key: our own name (events) and the explanation. */
export interface StateText {
  /**
   * Translation key for `common.name`. A name of OURS always wins over the
   * cloud's: it reaches all eleven languages, while the cloud sends one — and
   * measured at a live installation on 2026-09-12, not reliably the one that was
   * asked for. `Accept-Language: de-DE` still answered "Power status" and
   * "Childproof lock", and the very same key came back German on one appliance
   * and English on another. Where this table has no entry, the cloud name fills
   * the gap; `humanizeId` is the last resort.
   */
  name?: I18nKey;
  /** Translation key for `common.desc`. */
  desc?: I18nKey;
}

/**
 * The compartments a refrigeration appliance can have, each with a fully
 * translated door name. A placeholder would not do: `%s` is filled with the SAME
 * text in every language, so a German tree ended up with "Tür Freezer offen".
 * An unknown compartment still falls back to the placeholder form — a new one
 * arrives readable, just in English.
 *
 * Lives here and not next to the door expansion in `value-transformer`: a door
 * status is a TYPE special case (one enum key becomes one or two booleans with
 * their own ids), not a text one. The expansion stays where it is, the texts
 * belong where every other text is — otherwise a completeness check over
 * {@link STATE_TEXTS} reports eleven translated datapoints as unnamed.
 */
export const DOOR_COMPARTMENT_NAMES: Partial<Record<string, I18nKey>> = {
  Refrigerator: "doorOpenRefrigerator",
  Refrigerator2: "doorOpenRefrigerator2",
  Refrigerator3: "doorOpenRefrigerator3",
  Freezer: "doorOpenFreezer",
  BottleCooler: "doorOpenBottleCooler",
  Chiller: "doorOpenChiller",
  ChillerCommon: "doorOpenChillerCommon",
  ChillerLeft: "doorOpenChillerLeft",
  ChillerRight: "doorOpenChillerRight",
  FlexCompartment: "doorOpenFlexCompartment",
  WineCompartment: "doorOpenWineCompartment",
};

const DESCALING_ADVANCE: I18nKey = "evDescalingAdvanceDesc";
const CALC_N_CLEAN_ADVANCE: I18nKey = "evCalcNCleanAdvanceDesc";

/**
 * BSH key → the adapter's texts. Every entry carries the adapter's own name AND
 * its explanation: since 2026-09-12 the own name beats the cloud's (the cloud
 * answers in whatever language it likes, ours reaches eleven).
 */
const STATE_TEXTS: Readonly<Record<string, StateText>> = {
  // ─── events: common ────────────────────────────────────────────────────────
  "BSH.Common.Event.ProgramFinished": { name: "evProgramFinished", desc: "evProgramFinishedDesc" },
  // Listed by the type source among the EVENT keys; it names only the value type.
  "BSH.Common.EnumType.EventPresentState": { name: "evUnnamed", desc: "evUnnamedDesc" },
  "BSH.Common.Event.ProgramAborted": { name: "evProgramAborted", desc: "evProgramAbortedDesc" },
  "BSH.Common.Event.AlarmClockElapsed": { name: "evAlarmClockElapsed", desc: "evAlarmClockElapsedDesc" },
  "BSH.Common.Event.Favorite.001.ExternalTrigger": { name: "evFavorite1", desc: "evFavorite1Desc" },
  "BSH.Common.Event.Favorite.002.ExternalTrigger": { name: "evFavorite2", desc: "evFavorite1Desc" },
  // ─── events: dishwasher ────────────────────────────────────────────────────
  "Dishcare.Dishwasher.Event.SaltNearlyEmpty": { name: "evSaltNearlyEmpty", desc: "evSaltNearlyEmptyDesc" },
  "Dishcare.Dishwasher.Event.SaltLack": { name: "evSaltLack", desc: "evSaltLackDesc" },
  "Dishcare.Dishwasher.Event.ProgramBlockedSaltLack": {
    name: "evProgramBlockedSaltLack",
    desc: "evProgramBlockedSaltLackDesc",
  },
  "Dishcare.Dishwasher.Event.RinseAidNearlyEmpty": {
    name: "evRinseAidNearlyEmpty",
    desc: "evRinseAidNearlyEmptyDesc",
  },
  "Dishcare.Dishwasher.Event.RinseAidLack": { name: "evRinseAidLack", desc: "evRinseAidLackDesc" },
  "Dishcare.Dishwasher.Event.MachineCareReminder": {
    name: "evMachineCareReminder",
    desc: "evMachineCareReminderDesc",
  },
  "Dishcare.Dishwasher.Event.MachineCareAndFilterCleaningReminder": {
    name: "evMachineCareAndFilterCleaningReminder",
    desc: "evMachineCareAndFilterCleaningReminderDesc",
  },
  "Dishcare.Dishwasher.Event.MachineCareAndLowMaintenanceFilterCleaningReminder": {
    name: "evMachineCareAndLowMaintenanceFilterCleaningReminder",
    desc: "evMachineCareAndLowMaintenanceFilterCleaningReminderDesc",
  },
  "Dishcare.Dishwasher.Event.SmartFilterCleaningReminder": {
    name: "evSmartFilterCleaningReminder",
    desc: "evSmartFilterCleaningReminderDesc",
  },
  // ─── events: laundry ───────────────────────────────────────────────────────
  "LaundryCare.Washer.Event.IDos1FillLevelPoor": { name: "evIDos1FillLevelPoor", desc: "evIDos1FillLevelPoorDesc" },
  "LaundryCare.Washer.Event.IDos2FillLevelPoor": { name: "evIDos2FillLevelPoor", desc: "evIDos2FillLevelPoorDesc" },
  "LaundryCare.Dryer.Event.DryingProcessFinished": {
    name: "evDryingProcessFinished",
    desc: "evDryingProcessFinishedDesc",
  },
  // ─── events: cleaning robot ────────────────────────────────────────────────
  "ConsumerProducts.CleaningRobot.Event.EmptyDustBoxAndCleanFilter": {
    name: "evEmptyDustBoxAndCleanFilter",
    desc: "evEmptyDustBoxAndCleanFilterDesc",
  },
  "ConsumerProducts.CleaningRobot.Event.RobotIsStuck": { name: "evRobotIsStuck", desc: "evRobotIsStuckDesc" },
  "ConsumerProducts.CleaningRobot.Event.DockingStationNotFound": {
    name: "evDockingStationNotFound",
    desc: "evDockingStationNotFoundDesc",
  },
  "ConsumerProducts.CleaningRobot.Event.DustBin.NotInstalled": {
    name: "evDustBinNotInstalled",
    desc: "evDustBinNotInstalledDesc",
  },
  "ConsumerProducts.CleaningRobot.Event.Robot.Lifted": { name: "evRobotLifted", desc: "evRobotLiftedDesc" },
  // ─── events: coffee maker ──────────────────────────────────────────────────
  "ConsumerProducts.CoffeeMaker.Event.BeanContainerEmpty": {
    name: "evBeanContainerEmpty",
    desc: "evBeanContainerEmptyDesc",
  },
  "ConsumerProducts.CoffeeMaker.Event.WaterTankEmpty": { name: "evWaterTankEmpty", desc: "evWaterTankEmptyDesc" },
  "ConsumerProducts.CoffeeMaker.Event.DripTrayFull": { name: "evDripTrayFull", desc: "evDripTrayFullDesc" },
  "ConsumerProducts.CoffeeMaker.Event.DescalingIn20Cups": { name: "evDescalingIn20Cups", desc: DESCALING_ADVANCE },
  "ConsumerProducts.CoffeeMaker.Event.DescalingIn15Cups": { name: "evDescalingIn15Cups", desc: DESCALING_ADVANCE },
  "ConsumerProducts.CoffeeMaker.Event.DescalingIn10Cups": { name: "evDescalingIn10Cups", desc: DESCALING_ADVANCE },
  "ConsumerProducts.CoffeeMaker.Event.DescalingIn5Cups": { name: "evDescalingIn5Cups", desc: DESCALING_ADVANCE },
  "ConsumerProducts.CoffeeMaker.Event.DeviceShouldBeDescaled": {
    name: "evDeviceShouldBeDescaled",
    desc: "evDeviceShouldBeDescaledDesc",
  },
  "ConsumerProducts.CoffeeMaker.Event.DeviceDescalingOverdue": {
    name: "evDeviceDescalingOverdue",
    desc: "evDeviceDescalingOverdueDesc",
  },
  "ConsumerProducts.CoffeeMaker.Event.DeviceDescalingBlockage": {
    name: "evDeviceDescalingBlockage",
    desc: "evDeviceDescalingBlockageDesc",
  },
  "ConsumerProducts.CoffeeMaker.Event.DeviceShouldBeCleaned": {
    name: "evDeviceShouldBeCleaned",
    desc: "evDeviceShouldBeCleanedDesc",
  },
  "ConsumerProducts.CoffeeMaker.Event.DeviceCleaningOverdue": {
    name: "evDeviceCleaningOverdue",
    desc: "evDeviceCleaningOverdueDesc",
  },
  "ConsumerProducts.CoffeeMaker.Event.CalcNCleanIn20Cups": {
    name: "evCalcNCleanIn20Cups",
    desc: CALC_N_CLEAN_ADVANCE,
  },
  "ConsumerProducts.CoffeeMaker.Event.CalcNCleanIn15Cups": {
    name: "evCalcNCleanIn15Cups",
    desc: CALC_N_CLEAN_ADVANCE,
  },
  "ConsumerProducts.CoffeeMaker.Event.CalcNCleanIn10Cups": {
    name: "evCalcNCleanIn10Cups",
    desc: CALC_N_CLEAN_ADVANCE,
  },
  "ConsumerProducts.CoffeeMaker.Event.CalcNCleanIn5Cups": { name: "evCalcNCleanIn5Cups", desc: CALC_N_CLEAN_ADVANCE },
  "ConsumerProducts.CoffeeMaker.Event.DeviceShouldBeCalcNCleaned": {
    name: "evDeviceShouldBeCalcNCleaned",
    desc: "evDeviceShouldBeCalcNCleanedDesc",
  },
  "ConsumerProducts.CoffeeMaker.Event.DeviceCalcNCleanOverdue": {
    name: "evDeviceCalcNCleanOverdue",
    desc: "evDeviceCalcNCleanOverdueDesc",
  },
  "ConsumerProducts.CoffeeMaker.Event.DeviceCalcNCleanBlockage": {
    name: "evDeviceCalcNCleanBlockage",
    desc: "evDeviceCalcNCleanBlockageDesc",
  },
  "ConsumerProducts.CoffeeMaker.Event.KeepMilkTankCool": { name: "evKeepMilkTankCool", desc: "evKeepMilkTankCoolDesc" },
  // ─── events: cooking ───────────────────────────────────────────────────────
  "Cooking.Oven.Event.PreheatFinished": { name: "evPreheatFinished", desc: "evPreheatFinishedDesc" },
  "Cooking.Oven.Event.RegularPreheatFinished": {
    name: "evRegularPreheatFinished",
    desc: "evRegularPreheatFinishedDesc",
  },
  "Cooking.Common.Event.Hood.GreaseFilterMaxSaturationNearlyReached": {
    name: "evGreaseFilterNearlySaturated",
    desc: "evGreaseFilterNearlySaturatedDesc",
  },
  "Cooking.Common.Event.Hood.GreaseFilterMaxSaturationReached": {
    name: "evGreaseFilterSaturated",
    desc: "evGreaseFilterSaturatedDesc",
  },
  // ─── events: refrigeration ─────────────────────────────────────────────────
  "Refrigeration.FridgeFreezer.Event.DoorAlarmFreezer": { name: "evDoorAlarmFreezer", desc: "evDoorAlarmFreezerDesc" },
  "Refrigeration.FridgeFreezer.Event.DoorAlarmRefrigerator": {
    name: "evDoorAlarmRefrigerator",
    desc: "evDoorAlarmRefrigeratorDesc",
  },
  "Refrigeration.FridgeFreezer.Event.TemperatureAlarmFreezer": {
    name: "evTemperatureAlarmFreezer",
    desc: "evTemperatureAlarmFreezerDesc",
  },
  // ─── the common appliance data (the cloud names these too, but not reliably
  //     in the language that was asked for) ────────────────────────────────────
  "BSH.Common.Status.OperationState": { name: "stOperationState", desc: "operationStateDesc" },
  "BSH.Common.Status.RemoteControlActive": { name: "stRemoteControlActive", desc: "remoteControlActiveDesc" },
  "BSH.Common.Status.RemoteControlStartAllowed": {
    name: "stRemoteStartAllowed",
    desc: "remoteControlStartAllowedDesc",
  },
  "BSH.Common.Status.LocalControlActive": { name: "stLocalControlActive", desc: "localControlActiveDesc" },
  "BSH.Common.Status.InteriorIlluminationActive": {
    name: "stInteriorIlluminationActive",
    desc: "interiorIlluminationActiveDesc",
  },
  "BSH.Common.Setting.PowerState": { name: "setPowerState", desc: "powerStateDesc" },
  "BSH.Common.Setting.ChildLock": { name: "setChildLock", desc: "childLockDesc" },
  "BSH.Common.Option.RemainingProgramTime": {
    name: "optRemainingProgramTime",
    desc: "remainingProgramTimeDesc",
  },
  "BSH.Common.Option.RemainingProgramTimeIsEstimated": {
    name: "optRemainingProgramTimeIsEstimated",
    desc: "remainingProgramTimeIsEstimatedDesc",
  },
  "BSH.Common.Option.EstimatedTotalProgramTime": {
    name: "optEstimatedTotalProgramTime",
    desc: "estimatedTotalProgramTimeDesc",
  },
  "BSH.Common.Option.ProgramProgress": { name: "optProgramProgress", desc: "programProgressDesc" },
  "BSH.Common.Option.StartInRelative": { name: "optStartInRelative", desc: "startInRelativeDesc" },
  "BSH.Common.Option.FinishInRelative": { name: "optFinishInRelative", desc: "finishInRelativeDesc" },
  "BSH.Common.Root.SelectedProgram": { desc: "selectedProgramDesc" },
  "BSH.Common.Root.ActiveProgram": { desc: "activeProgramDesc" },
  "BSH.Common.Command.AcknowledgeEvent": { name: "acknowledgeEvent", desc: "acknowledgeEventDesc" },
  // ─── program options: our own name where the cloud sends none ──────────────
  // The cloud names an option only in a program definition, and those are only
  // fetchable while the appliance is ON. A dishwasher that spends the day
  // switched off would otherwise carry English auto-labels forever.
  // Every appliance type is first-class here, not only the ones we can test with.
  "BSH.Common.Option.BaseProgram": { name: "optBaseProgram", desc: "baseProgramDesc" },
  "BSH.Common.Option.CurrentStepRemainingTime": {
    name: "optCurrentStepRemainingTime",
    desc: "currentStepRemainingTimeDesc",
  },
  "BSH.Common.Option.Duration": { name: "optDuration", desc: "durationOptionDesc" },
  "BSH.Common.Option.ElapsedProgramTime": { name: "optElapsedProgramTime", desc: "elapsedProgramTimeDesc" },
  "BSH.Common.Option.EnergyForecast": { name: "optEnergyForecast", desc: "energyForecastDesc" },
  "BSH.Common.Option.ProgramName": { name: "optProgramName", desc: "programNameDesc" },
  "BSH.Common.Option.RemainingProgramTimeEstimationState": {
    name: "optRemainingProgramTimeEstimationState",
    desc: "remainingProgramTimeEstimationStateDesc",
  },
  "BSH.Common.Option.SmartEnergyService.SmartStartEnabled": {
    name: "optSmartStartEnabled",
    desc: "smartEnergyServiceSmartStartEnabledDesc",
  },
  "BSH.Common.Option.WaterForecast": { name: "optWaterForecast", desc: "waterForecastDesc" },
  "Dishcare.Dishwasher.Option.BrillianceDry": { name: "optBrillianceDry", desc: "brillianceDryDesc" },
  "Dishcare.Dishwasher.Option.DelicateBasket": { name: "optDelicateBasket", desc: "delicateBasketDesc" },
  "Dishcare.Dishwasher.Option.EcoDry": { name: "optEcoDry", desc: "ecoDryDesc" },
  "Dishcare.Dishwasher.Option.EnergySafe": { name: "optEnergySafe", desc: "energySafeDesc" },
  "Dishcare.Dishwasher.Option.ExtraDry": { name: "optExtraDry", desc: "extraDryDesc" },
  "Dishcare.Dishwasher.Option.ExtraRinse": { name: "optExtraRinse", desc: "extraRinseDesc" },
  "Dishcare.Dishwasher.Option.FixedZone": { name: "optFixedZone", desc: "fixedZoneDesc" },
  "Dishcare.Dishwasher.Option.FlexSpray.BackLeft": {
    name: "optFlexSprayBackLeft",
    desc: "flexSprayBackLeftDesc",
  },
  "Dishcare.Dishwasher.Option.FlexSpray.BackRight": {
    name: "optFlexSprayBackRight",
    desc: "flexSprayBackRightDesc",
  },
  "Dishcare.Dishwasher.Option.FlexSpray.FrontLeft": {
    name: "optFlexSprayFrontLeft",
    desc: "flexSprayFrontLeftDesc",
  },
  "Dishcare.Dishwasher.Option.FlexSpray.FrontRight": {
    name: "optFlexSprayFrontRight",
    desc: "flexSprayFrontRightDesc",
  },
  "Dishcare.Dishwasher.Option.FlexSpray.Type": { name: "optFlexSprayType", desc: "flexSprayTypeDesc" },
  "Dishcare.Dishwasher.Option.HalfLoad": { name: "optHalfLoad", desc: "halfLoadDesc" },
  "Dishcare.Dishwasher.Option.HolidayMode": { name: "optHolidayMode", desc: "holidayModeDesc" },
  "Dishcare.Dishwasher.Option.HygienePlus": { name: "optHygienePlus", desc: "hygienePlusDesc" },
  "Dishcare.Dishwasher.Option.IntensivZone": { name: "optIntensivZone", desc: "intensivZoneDesc" },
  "Dishcare.Dishwasher.Option.LearningDishwasher.CleaningLevel": {
    name: "optLearningCleaningLevel",
    desc: "learningDishwasherCleaningLevelDesc",
  },
  "Dishcare.Dishwasher.Option.LearningDishwasher.DryingLevel": {
    name: "optLearningDryingLevel",
    desc: "learningDishwasherDryingLevelDesc",
  },
  "Dishcare.Dishwasher.Option.LearningDishwasher.DurationLevel": {
    name: "optLearningDurationLevel",
    desc: "learningDishwasherDurationLevelDesc",
  },
  "Dishcare.Dishwasher.Option.Pretreatment": { name: "optPretreatment", desc: "pretreatmentDesc" },
  "Dishcare.Dishwasher.Option.SanitationUC": { name: "optSanitationUC", desc: "sanitationUCDesc" },
  "Dishcare.Dishwasher.Option.SilenceOnDemand": { name: "optSilenceOnDemand", desc: "silenceOnDemandDesc" },
  "Dishcare.Dishwasher.Option.StorageFunction": { name: "optStorageFunction", desc: "storageFunctionDesc" },
  "Dishcare.Dishwasher.Option.Turbo": { name: "optTurbo", desc: "turboDesc" },
  "Dishcare.Dishwasher.Option.VarioSpeed": { name: "optVarioSpeed", desc: "varioSpeedDesc" },
  "Dishcare.Dishwasher.Option.VarioSpeedPlus": { name: "optVarioSpeedPlus", desc: "varioSpeedPlusDesc" },
  "Dishcare.Dishwasher.Option.ZeoliteDry": { name: "optZeoliteDry", desc: "zeoliteDryDesc" },
  "LaundryCare.Common.Option.LoadRecommendation": {
    name: "optLoadRecommendation",
    desc: "loadRecommendationDesc",
  },
  "LaundryCare.Common.Option.LowTemperatureHygiene": {
    name: "optLowTemperatureHygiene",
    desc: "lowTemperatureHygieneDesc",
  },
  "LaundryCare.Common.Option.ProcessPhase": { name: "optProcessPhase", desc: "processPhaseDesc" },
  "LaundryCare.Common.Option.ReferToProgram": { name: "optReferToProgram", desc: "referToProgramDesc" },
  "LaundryCare.Common.Option.SilentMode": { name: "optSilentMode", desc: "silentModeDesc" },
  "LaundryCare.Common.Option.SpeedPerfect": { name: "optSpeedPerfect", desc: "speedPerfectDesc" },
  "LaundryCare.Common.Option.VarioPerfect": { name: "optVarioPerfect", desc: "varioPerfectDesc" },
  "LaundryCare.Dryer.Option.ConnectedDry.OriginalProgramTime": {
    name: "optOriginalProgramTime",
    desc: "connectedDryOriginalProgramTimeDesc",
  },
  "LaundryCare.Dryer.Option.DryingTarget": { name: "optDryingTarget", desc: "dryingTargetDesc" },
  "LaundryCare.Dryer.Option.DryingTargetAdjustment": {
    name: "optDryingTargetAdjustment",
    desc: "dryingTargetAdjustmentDesc",
  },
  "LaundryCare.Dryer.Option.Gentle": { name: "optGentle", desc: "gentleDesc" },
  "LaundryCare.Dryer.Option.HalfLoad": { name: "optDryerHalfLoad", desc: "dryerHalfLoadDesc" },
  "LaundryCare.Dryer.Option.ProcessPhase": { name: "optDryerProcessPhase", desc: "processPhaseDesc" },
  "LaundryCare.Dryer.Option.Refresher": { name: "optRefresher", desc: "refresherDesc" },
  "LaundryCare.Dryer.Option.WrinkleGuard": { name: "optWrinkleGuard", desc: "wrinkleGuardDesc" },
  "LaundryCare.Washer.Option.EISA": { name: "optEisa", desc: "eISADesc" },
  "LaundryCare.Washer.Option.IDos1.Active": { name: "optIDos1ActiveDotted", desc: "iDos1ActiveDesc" },
  "LaundryCare.Washer.Option.IDos1Active": { name: "optIDos1Active", desc: "iDos1ActiveDesc" },
  "LaundryCare.Washer.Option.IDos1DosingLevel": { name: "optIDos1DosingLevel", desc: "iDos1DosingLevelDesc" },
  "LaundryCare.Washer.Option.IDos2.Active": { name: "optIDos2ActiveDotted", desc: "iDos2ActiveDesc" },
  "LaundryCare.Washer.Option.IDos2Active": { name: "optIDos2Active", desc: "iDos2ActiveDesc" },
  "LaundryCare.Washer.Option.IDos2DosingLevel": { name: "optIDos2DosingLevel", desc: "iDos2DosingLevelDesc" },
  "LaundryCare.Washer.Option.IntensivePlus": { name: "optIntensivePlus", desc: "intensivePlusDesc" },
  "LaundryCare.Washer.Option.LessIroning": { name: "optLessIroning", desc: "lessIroningDesc" },
  "LaundryCare.Washer.Option.MiniLoad": { name: "optMiniLoad", desc: "miniLoadDesc" },
  "LaundryCare.Washer.Option.MultipleSoak": { name: "optMultipleSoak", desc: "multipleSoakDesc" },
  "LaundryCare.Washer.Option.Prewash": { name: "optPrewash", desc: "prewashDesc" },
  "LaundryCare.Washer.Option.ProcessPhase": { name: "optWasherProcessPhase", desc: "processPhaseDesc" },
  "LaundryCare.Washer.Option.RinseHold": { name: "optRinseHold", desc: "rinseHoldDesc" },
  "LaundryCare.Washer.Option.RinsePlus": { name: "optRinsePlus", desc: "rinsePlusDesc" },
  "LaundryCare.Washer.Option.RinsePlus1": { name: "optRinsePlus1", desc: "rinsePlus1Desc" },
  "LaundryCare.Washer.Option.SilentWash": { name: "optSilentWash", desc: "silentWashDesc" },
  "LaundryCare.Washer.Option.Soak": { name: "optSoak", desc: "soakDesc" },
  "LaundryCare.Washer.Option.SpeedPerfect": { name: "optWasherSpeedPerfect", desc: "speedPerfectDesc" },
  "LaundryCare.Washer.Option.SpinSpeed": { name: "optSpinSpeed", desc: "spinSpeedDesc" },
  "LaundryCare.Washer.Option.Stains": { name: "optStains", desc: "stainsDesc" },
  "LaundryCare.Washer.Option.Temperature": { name: "optWasherTemperature", desc: "washerTemperatureDesc" },
  "LaundryCare.Washer.Option.WaterAndRinsePlus1": {
    name: "optWaterAndRinsePlus1",
    desc: "waterAndRinsePlus1Desc",
  },
  "LaundryCare.Washer.Option.WaterPlus": { name: "optWaterPlus", desc: "waterPlusDesc" },
  "LaundryCare.WasherDryer.Option.DryingTarget": { name: "optWdDryingTarget", desc: "dryingTargetDesc" },
  "LaundryCare.WasherDryer.Option.LowTemperatureHygiene": {
    name: "optWdLowTemperatureHygiene",
    desc: "lowTemperatureHygieneDesc",
  },
  "LaundryCare.WasherDryer.Option.ProgramMode": { name: "optProgramMode", desc: "programModeDesc" },
  "LaundryCare.WasherDryer.Option.WrinkleGuardBoost": {
    name: "optWrinkleGuardBoost",
    desc: "wrinkleGuardBoostDesc",
  },
  "Cooking.Common.Option.Hood.Boost": { name: "optHoodBoost", desc: "hoodBoostDesc" },
  "Cooking.Common.Option.Hood.IntensiveLevel": {
    name: "optHoodIntensiveLevel",
    desc: "hoodIntensiveLevelDesc",
  },
  "Cooking.Common.Option.Hood.VentingLevel": { name: "optHoodVentingLevel", desc: "hoodVentingLevelDesc" },
  "Cooking.Oven.Option.AirExchange": { name: "optAirExchange", desc: "airExchangeDesc" },
  "Cooking.Oven.Option.CavitySelector": { name: "optCavitySelector", desc: "cavitySelectorDesc" },
  "Cooking.Oven.Option.FastPreHeat": { name: "optFastPreHeat", desc: "fastPreHeatDesc" },
  "Cooking.Oven.Option.HeatupProgress": { name: "optHeatupProgress", desc: "heatupProgressDesc" },
  "Cooking.Oven.Option.Level": { name: "optOvenLevel", desc: "levelDesc" },
  "Cooking.Oven.Option.MeatProbeTemperatureV2": {
    name: "optMeatProbeTemperature",
    desc: "meatProbeTemperatureV2Desc",
  },
  "Cooking.Oven.Option.MicrowavePower": { name: "optMicrowavePower", desc: "microwavePowerDesc" },
  "Cooking.Oven.Option.PyrolysisLevel": { name: "optPyrolysisLevel", desc: "pyrolysisLevelDesc" },
  "Cooking.Oven.Option.SetpointTemperature": {
    name: "optOvenSetpointTemperature",
    desc: "setpointTemperatureDesc",
  },
  "Cooking.Oven.Option.SteamAssistLevel": { name: "optSteamAssistLevel", desc: "steamAssistLevelDesc" },
  "Cooking.Oven.Option.SteamBoost": { name: "optSteamBoost", desc: "steamBoostDesc" },
  "Cooking.Oven.Option.WarmingLevel": { name: "optWarmingLevel", desc: "warmingLevelDesc" },
  "ConsumerProducts.CoffeeMaker.Option.AromaSelect": { name: "optAromaSelect", desc: "aromaSelectDesc" },
  "ConsumerProducts.CoffeeMaker.Option.BeanAmount": { name: "optBeanAmount", desc: "beanAmountDesc" },
  "ConsumerProducts.CoffeeMaker.Option.BeanContainerSelection": {
    name: "optBeanContainerSelection",
    desc: "beanContainerSelectionDesc",
  },
  "ConsumerProducts.CoffeeMaker.Option.BeverageSize": { name: "optBeverageSize", desc: "beverageSizeDesc" },
  "ConsumerProducts.CoffeeMaker.Option.BeveragesRemaining": {
    name: "optBeveragesRemaining",
    desc: "beveragesRemainingDesc",
  },
  "ConsumerProducts.CoffeeMaker.Option.Coarsness": { name: "optCoarseness", desc: "coarsnessDesc" },
  "ConsumerProducts.CoffeeMaker.Option.Coarsness.Recommendation": {
    name: "optCoarsenessRecommendation",
    desc: "coarsnessRecommendationDesc",
  },
  "ConsumerProducts.CoffeeMaker.Option.CoffeeMilkRatio": {
    name: "optCoffeeMilkRatio",
    desc: "coffeeMilkRatioDesc",
  },
  "ConsumerProducts.CoffeeMaker.Option.CoffeeStrength": {
    name: "optCoffeeStrength",
    desc: "coffeeStrengthDesc",
  },
  "ConsumerProducts.CoffeeMaker.Option.CoffeeStrength.Recommendation": {
    name: "optCoffeeStrengthRecommendation",
    desc: "coffeeStrengthRecommendationDesc",
  },
  "ConsumerProducts.CoffeeMaker.Option.CoffeeTemperature": {
    name: "optCoffeeTemperature",
    desc: "coffeeTemperatureDesc",
  },
  "ConsumerProducts.CoffeeMaker.Option.CoffeeTemperature.Recommendation": {
    name: "optCoffeeTemperatureRecommendation",
    desc: "coffeeTemperatureRecommendationDesc",
  },
  "ConsumerProducts.CoffeeMaker.Option.FillQuantity": { name: "optFillQuantity", desc: "fillQuantityDesc" },
  "ConsumerProducts.CoffeeMaker.Option.FillQuantity.Recommendation": {
    name: "optFillQuantityRecommendation",
    desc: "fillQuantityRecommendationDesc",
  },
  "ConsumerProducts.CoffeeMaker.Option.FlowRate": { name: "optFlowRate", desc: "flowRateDesc" },
  "ConsumerProducts.CoffeeMaker.Option.FlowRate.Recommendation": {
    name: "optFlowRateRecommendation",
    desc: "flowRateRecommendationDesc",
  },
  "ConsumerProducts.CoffeeMaker.Option.HotWaterTemperature": {
    name: "optHotWaterTemperature",
    desc: "hotWaterTemperatureDesc",
  },
  "ConsumerProducts.CoffeeMaker.Option.MultipleBeverages": {
    name: "optMultipleBeverages",
    desc: "multipleBeveragesDesc",
  },
  "ConsumerProducts.CoffeeMaker.Option.Shot.Count": { name: "optShotCount", desc: "shotCountDesc" },
  "ConsumerProducts.CleaningRobot.Option.CarpetBoostEnabled": {
    name: "optCarpetBoost",
    desc: "carpetBoostEnabledDesc",
  },
  "ConsumerProducts.CleaningRobot.Option.CleaningMode": { name: "optCleaningMode", desc: "cleaningModeDesc" },
  "ConsumerProducts.CleaningRobot.Option.CleaningPasses": {
    name: "optCleaningPasses",
    desc: "cleaningPassesDesc",
  },
  "ConsumerProducts.CleaningRobot.Option.CleaningSpeed": {
    name: "optCleaningSpeed",
    desc: "cleaningSpeedDesc",
  },
  "ConsumerProducts.CleaningRobot.Option.MopExtensionEnabled": {
    name: "optMopExtension",
    desc: "mopExtensionEnabledDesc",
  },
  "ConsumerProducts.CleaningRobot.Option.ProcessPhase": {
    name: "optRobotProcessPhase",
    desc: "processPhaseDesc",
  },
  "ConsumerProducts.CleaningRobot.Option.ReferenceMapId": {
    name: "optReferenceMapId",
    desc: "referenceMapIdDesc",
  },
  "ConsumerProducts.CleaningRobot.Option.SuctionPower": { name: "optSuctionPower", desc: "suctionPowerDesc" },
  "ConsumerProducts.CleaningRobot.Option.WaterFlowRate": {
    name: "optWaterFlowRate",
    desc: "waterFlowRateDesc",
  },
  "HeatingVentilationAirConditioning.AirConditioner.Option.FanSpeedMode": {
    name: "optFanSpeedMode",
    desc: "fanSpeedModeDesc",
  },
  "HeatingVentilationAirConditioning.AirConditioner.Option.FanSpeedPercentage": {
    name: "optFanSpeedPercentage",
    desc: "fanSpeedPercentageDesc",
  },
  "HeatingVentilationAirConditioning.AirConditioner.Option.SetpointTemperature": {
    name: "optAcSetpointTemperature",
    desc: "acSetpointTemperatureDesc",
  },

  // ─── status / settings / commands the cloud never names ───────────────────
  // Home Connect sends a localized `name` with program definitions only, so a
  // status or setting of an appliance that is switched off would end up with the
  // English label humanizeId derives from the key — in every language. These are
  // FALLBACK names: a cloud text still wins whenever the appliance delivers one.
  // Keys taken verbatim from the type source (Ressourcen/homeconnect/upstream-refs).
  "BSH.Common.Command.OpenDoor": { name: "cmdOpenDoor", desc: "cmdOpenDoorDesc" },
  "BSH.Common.Command.PartlyOpenDoor": { name: "cmdPartlyOpenDoor", desc: "cmdPartlyOpenDoorDesc" },
  "BSH.Common.Command.PauseProgram": { name: "cmdPauseProgram", desc: "cmdPauseProgramDesc" },
  "BSH.Common.Command.ResumeProgram": { name: "cmdResumeProgram", desc: "cmdResumeProgramDesc" },
  "BSH.Common.Option.ElapsedProgramTime.AutoCounting": {
    name: "optElapsedAutoCounting",
    desc: "optElapsedAutoCountingDesc",
  },
  "BSH.Common.Option.RemainingProgramTime.AutoCounting": {
    name: "optRemainingAutoCounting",
    desc: "optRemainingAutoCountingDesc",
  },
  "BSH.Common.Setting.AlarmClock": { name: "setAlarmClock", desc: "setAlarmClockDesc" },
  "BSH.Common.Setting.AmbientLightBrightness": {
    name: "setAmbientLightBrightness",
    desc: "ambientLightBrightnessDesc",
  },
  "BSH.Common.Setting.AmbientLightColor": { name: "setAmbientLightColor", desc: "ambientLightColorDesc" },
  "BSH.Common.Setting.AmbientLightCustomColor": {
    name: "setAmbientLightCustomColor",
    desc: "setAmbientLightCustomColorDesc",
  },
  "BSH.Common.Setting.AmbientLightEnabled": { name: "setAmbientLightEnabled", desc: "ambientLightEnabledDesc" },
  "BSH.Common.Setting.LiquidVolumeUnit": { name: "setLiquidVolumeUnit", desc: "setLiquidVolumeUnitDesc" },
  "BSH.Common.Setting.TemperatureUnit": { name: "setTemperatureUnit", desc: "setTemperatureUnitDesc" },
  "BSH.Common.Status.BatteryChargingState": {
    name: "stBatteryChargingState",
    desc: "stBatteryChargingStateDesc",
  },
  "BSH.Common.Status.BatteryLevel": { name: "stBatteryLevel", desc: "batteryLevelDesc" },
  "BSH.Common.Status.ChargingConnection": { name: "stChargingConnection", desc: "stChargingConnectionDesc" },
  "BSH.Common.Status.Video.CameraState": { name: "stCameraState", desc: "videoCameraStateDesc" },
  "ConsumerProducts.CleaningRobot.Setting.CurrentMap": { name: "setCurrentMap", desc: "setCurrentMapDesc" },
  "ConsumerProducts.CleaningRobot.Setting.NameOfMap1": { name: "setNameOfMap1", desc: "setNameOfMap1Desc" },
  "ConsumerProducts.CleaningRobot.Setting.NameOfMap2": { name: "setNameOfMap2", desc: "setNameOfMap2Desc" },
  "ConsumerProducts.CleaningRobot.Setting.NameOfMap3": { name: "setNameOfMap3", desc: "setNameOfMap3Desc" },
  "ConsumerProducts.CleaningRobot.Setting.NameOfMap4": { name: "setNameOfMap4", desc: "setNameOfMap4Desc" },
  "ConsumerProducts.CleaningRobot.Setting.NameOfMap5": { name: "setNameOfMap5", desc: "setNameOfMap5Desc" },
  "ConsumerProducts.CleaningRobot.Status.DustBoxInserted": {
    name: "stDustBoxInserted",
    desc: "dustBoxInsertedDesc",
  },
  "ConsumerProducts.CleaningRobot.Status.LastSelectedMap": {
    name: "stLastSelectedMap",
    desc: "lastSelectedMapDesc",
  },
  "ConsumerProducts.CleaningRobot.Status.Lifted": { name: "stRobotLifted", desc: "liftedDesc" },
  "ConsumerProducts.CleaningRobot.Status.Lost": { name: "stRobotLost", desc: "stRobotLostDesc" },
  "ConsumerProducts.CoffeeMaker.Setting.CupWarmer": { name: "setCupWarmer", desc: "cupWarmerDesc" },
  "ConsumerProducts.CoffeeMaker.Status.BeverageCounterCoffee": {
    name: "stCounterCoffee",
    desc: "stCounterCoffeeDesc",
  },
  "ConsumerProducts.CoffeeMaker.Status.BeverageCounterCoffeeAndMilk": {
    name: "stCounterCoffeeAndMilk",
    desc: "stCounterCoffeeAndMilkDesc",
  },
  "ConsumerProducts.CoffeeMaker.Status.BeverageCounterFrothyMilk": {
    name: "stCounterFrothyMilk",
    desc: "stCounterFrothyMilkDesc",
  },
  "ConsumerProducts.CoffeeMaker.Status.BeverageCounterHotMilk": {
    name: "stCounterHotMilk",
    desc: "stCounterHotMilkDesc",
  },
  "ConsumerProducts.CoffeeMaker.Status.BeverageCounterHotWater": {
    name: "stCounterHotWater",
    desc: "stCounterHotWaterDesc",
  },
  "ConsumerProducts.CoffeeMaker.Status.BeverageCounterHotWaterCups": {
    name: "stCounterHotWaterCups",
    desc: "stCounterHotWaterCupsDesc",
  },
  "ConsumerProducts.CoffeeMaker.Status.BeverageCounterMilk": {
    name: "stCounterMilk",
    desc: "stCounterMilkDesc",
  },
  "ConsumerProducts.CoffeeMaker.Status.BeverageCounterPowderCoffee": {
    name: "stCounterPowderCoffee",
    desc: "stCounterPowderCoffeeDesc",
  },
  "ConsumerProducts.CoffeeMaker.Status.BeverageCounterRistrettoEspresso": {
    name: "stCounterRistrettoEspresso",
    desc: "stCounterRistrettoEspressoDesc",
  },
  "Cooking.Common.Setting.Lighting": { name: "setCookingLighting", desc: "lightingDesc" },
  "Cooking.Common.Setting.LightingBrightness": {
    name: "setCookingLightingBrightness",
    desc: "lightingBrightnessDesc",
  },
  "Cooking.Hob.Setting.Ventilation": { name: "setHobVentilation", desc: "setHobVentilationDesc" },
  "Cooking.Hood.Setting.ColorTemperature": { name: "setHoodColorTemperature", desc: "colorTemperatureDesc" },
  "Cooking.Hood.Setting.ColorTemperaturePercent": {
    name: "setHoodColorTemperaturePercent",
    desc: "setHoodColorTemperaturePercentDesc",
  },
  "Cooking.Oven.Setting.SabbathMode": { name: "setOvenSabbathMode", desc: "setOvenSabbathModeDesc" },
  "Cooking.Oven.Status.CurrentCavityTemperature": {
    name: "stCavityTemperature",
    desc: "currentCavityTemperatureDesc",
  },
  "LaundryCare.Washer.Setting.IDos1BaseLevel": { name: "setIDos1BaseLevel", desc: "setIDos1BaseLevelDesc" },
  "LaundryCare.Washer.Setting.IDos2BaseLevel": { name: "setIDos2BaseLevel", desc: "setIDos2BaseLevelDesc" },
  "Refrigeration.Common.Setting.BottleCooler.SetpointTemperature": {
    name: "setTempBottleCooler",
    desc: "setTempBottleCoolerDesc",
  },
  "Refrigeration.Common.Setting.ChillerCommon.SetpointTemperature": {
    name: "setTempChiller",
    desc: "setTempChillerDesc",
  },
  "Refrigeration.Common.Setting.ChillerLeft.SetpointTemperature": {
    name: "setTempChillerLeft",
    desc: "setTempChillerLeftDesc",
  },
  "Refrigeration.Common.Setting.ChillerRight.SetpointTemperature": {
    name: "setTempChillerRight",
    desc: "setTempChillerRightDesc",
  },
  "Refrigeration.Common.Setting.Dispenser.Enabled": {
    name: "setDispenserEnabled",
    desc: "dispenserEnabledDesc",
  },
  "Refrigeration.Common.Setting.Door.AssistantForceFreezer": {
    name: "setDoorAssistantForceFreezer",
    desc: "setDoorAssistantForceFreezerDesc",
  },
  "Refrigeration.Common.Setting.Door.AssistantForceFridge": {
    name: "setDoorAssistantForceFridge",
    desc: "setDoorAssistantForceFridgeDesc",
  },
  "Refrigeration.Common.Setting.Door.AssistantFreezer": {
    name: "setDoorAssistantFreezer",
    desc: "setDoorAssistantFreezerDesc",
  },
  "Refrigeration.Common.Setting.Door.AssistantFridge": {
    name: "setDoorAssistantFridge",
    desc: "setDoorAssistantFridgeDesc",
  },
  "Refrigeration.Common.Setting.Door.AssistantTimeoutFreezer": {
    name: "setDoorAssistantTimeoutFreezer",
    desc: "setDoorAssistantTimeoutFreezerDesc",
  },
  "Refrigeration.Common.Setting.Door.AssistantTimeoutFridge": {
    name: "setDoorAssistantTimeoutFridge",
    desc: "setDoorAssistantTimeoutFridgeDesc",
  },
  "Refrigeration.Common.Setting.Door.AssistantTriggerFreezer": {
    name: "setDoorAssistantTriggerFreezer",
    desc: "setDoorAssistantTriggerFreezerDesc",
  },
  "Refrigeration.Common.Setting.Door.AssistantTriggerFridge": {
    name: "setDoorAssistantTriggerFridge",
    desc: "setDoorAssistantTriggerFridgeDesc",
  },
  "Refrigeration.Common.Setting.EcoMode": { name: "setEcoMode", desc: "setEcoModeDesc" },
  "Refrigeration.Common.Setting.FreshMode": { name: "setFreshMode", desc: "setFreshModeDesc" },
  "Refrigeration.Common.Setting.Light.External.Brightness": {
    name: "setLightExternalBrightness",
    desc: "lightExternalBrightnessDesc",
  },
  "Refrigeration.Common.Setting.Light.External.Power": {
    name: "setLightExternalPower",
    desc: "lightExternalPowerDesc",
  },
  "Refrigeration.Common.Setting.Light.Internal.Brightness": {
    name: "setLightInternalBrightness",
    desc: "lightInternalBrightnessDesc",
  },
  "Refrigeration.Common.Setting.Light.Internal.Power": {
    name: "setLightInternalPower",
    desc: "lightInternalPowerDesc",
  },
  "Refrigeration.Common.Setting.SabbathMode": {
    name: "setFridgeSabbathMode",
    desc: "setFridgeSabbathModeDesc",
  },
  "Refrigeration.Common.Setting.VacationMode": { name: "setVacationMode", desc: "setVacationModeDesc" },
  "Refrigeration.Common.Setting.WineCompartment.SetpointTemperature": {
    name: "setTempWineCompartment",
    desc: "setTempWineCompartmentDesc",
  },
  "Refrigeration.Common.Setting.WineCompartment2.SetpointTemperature": {
    name: "setTempWineCompartment2",
    desc: "setTempWineCompartment2Desc",
  },
  "Refrigeration.Common.Setting.WineCompartment3.SetpointTemperature": {
    name: "setTempWineCompartment3",
    desc: "setTempWineCompartment3Desc",
  },
  "Refrigeration.FridgeFreezer.Setting.SetpointTemperatureFreezer": {
    name: "setTempFreezer",
    desc: "setTempFreezerDesc",
  },
  "Refrigeration.FridgeFreezer.Setting.SetpointTemperatureRefrigerator": {
    name: "setTempRefrigerator",
    desc: "setTempRefrigeratorDesc",
  },
  "Refrigeration.FridgeFreezer.Setting.SuperModeFreezer": {
    name: "setSuperModeFreezer",
    desc: "setSuperModeFreezerDesc",
  },
  "Refrigeration.FridgeFreezer.Setting.SuperModeRefrigerator": {
    name: "setSuperModeRefrigerator",
    desc: "setSuperModeRefrigeratorDesc",
  },
  // ─── extra data from the Home Connect opt-in ───────────────────────────────
  // These keys reach an account that has switched on the additional appliance
  // data in the developer portal (krobi 2026-09-07). None of them is documented:
  // neither api-docs.home-connect.com nor the 1020-key reference of
  // homebridge-homeconnect lists a single one, so the meaning below comes from
  // the values his three appliances actually deliver.
  "Dishcare.Dishwasher.Status.ProgramPhase": {
    name: "stDishwasherProgramPhase",
    desc: "dishwasherProgramPhaseDesc",
  },
  "Dishcare.Dishwasher.Status.EcoDryActive": { name: "stEcoDryActive", desc: "ecoDryActiveDesc" },
  // Opt-in key of a dishwasher (live 2026-09-27); its values (On/Off) come from the
  // appliance's own description (device-dumps-2026-09-07).
  "Dishcare.Dishwasher.Setting.TimeLight": { name: "setTimeLight", desc: "timeLightDesc" },
  "BSH.Common.Status.Program.All.Energy.Consumed": {
    name: "stProgramAllEnergy",
    desc: "programAllEnergyDesc",
  },
  "BSH.Common.Status.Program.All.Water.Consumed": {
    name: "stProgramAllWater",
    desc: "programAllWaterDesc",
  },
  "LaundryCare.Washer.Status.Detergent.All.Consumed": {
    name: "stDetergentAllConsumed",
    desc: "detergentAllConsumedDesc",
  },
  // Six siblings of the same family, found at krobi's installation on
  // 2026-09-12: they stood there with the English auto-label and NO explanation,
  // because no table entry covered them. The fixtures do not carry these keys
  // either, so no gate could see it.
  "BSH.Common.Status.Program.All.Count.Started": {
    name: "stProgramAllCountStarted",
    desc: "programAllCountStartedDesc",
  },
  "BSH.Common.Status.Program.All.Count.Completed": {
    name: "stProgramAllCountCompleted",
    desc: "programAllCountCompletedDesc",
  },
  "BSH.Common.Status.Program.All.Time.Effective": {
    name: "stProgramAllTimeEffective",
    desc: "programAllTimeEffectiveDesc",
  },
  "BSH.Common.Status.RemoteControlStartAllowedSince": {
    name: "stRemoteStartAllowedSince",
    desc: "remoteStartAllowedSinceDesc",
  },
  "LaundryCare.Washer.Status.Softener.All.Consumed": {
    name: "stSoftenerAllConsumed",
    desc: "softenerAllConsumedDesc",
  },
  "LaundryCare.Washer.Event.IDos.IDosOpenTray": {
    name: "evIDosOpenTray",
    desc: "evIDosOpenTrayDesc",
  },
  // The encoded program records (history, per-program details, the last run's
  // summary, the fault code list) never become datapoints of their own — they are
  // decoded into readable ones (program-records.ts), which carry their own texts.
};

/**
 * The adapter's texts for a BSH key.
 *
 * @param key the fully-qualified BSH key
 * @returns the texts, or undefined when the adapter has nothing to say about it
 */
export function stateText(key: string): StateText | undefined {
  return STATE_TEXTS[key];
}
