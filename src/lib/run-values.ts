// Run values that Home Connect delivers under an `.Option.` key (decision 49). They are not program
// options — nobody chooses them before a start, the appliance reports them while a program is under way — so
// they live under `status` (or, for the two that describe the program itself, under `programs`), always
// read-only, never in the write gate or the start payload.
//
// Why a list and not "whatever no program definition names": a program definition
// (`GET /programs/available/{key}`) lists exactly the settable options, but an appliance answers it only for
// the programs the API offers — a washer-dryer measured 2026-09-30 gave 3 definitions for ~15 programs it
// runs, so Prewash or SpeedPerfect, settable options, stand in none of them.
//
// Sources, key by key: `Ressourcen/homeconnect/schluessel-recherche-2026-09-30/runtime-options.md` —
// official "Program Progress Changes", refusals of the real API (Home Assistant core #167619, #168733),
// real appliance data; the keys without evidence of behaviour were decided by krobi on 2026-09-30.

/** Option keys that are run values, shown under `status`. */
const STATUS_RUN_VALUES: ReadonlySet<string> = new Set([
  "BSH.Common.Option.CurrentStepRemainingTime",
  "BSH.Common.Option.ElapsedProgramTime",
  "BSH.Common.Option.ElapsedProgramTime.AutoCounting",
  "BSH.Common.Option.EnergyForecast",
  "BSH.Common.Option.EstimatedTotalProgramTime",
  "BSH.Common.Option.ProgramProgress",
  "BSH.Common.Option.RemainingProgramTime",
  "BSH.Common.Option.RemainingProgramTime.AutoCounting",
  "BSH.Common.Option.RemainingProgramTimeEstimationState",
  "BSH.Common.Option.RemainingProgramTimeIsEstimated",
  "BSH.Common.Option.SmartEnergyService.SmartStartEnabled",
  "BSH.Common.Option.WaterForecast",
  "ConsumerProducts.CleaningRobot.Option.ProcessPhase",
  "ConsumerProducts.CoffeeMaker.Option.BeveragesRemaining",
  "ConsumerProducts.CoffeeMaker.Option.Coarsness.Recommendation",
  "ConsumerProducts.CoffeeMaker.Option.CoffeeStrength.Recommendation",
  "ConsumerProducts.CoffeeMaker.Option.CoffeeTemperature.Recommendation",
  "ConsumerProducts.CoffeeMaker.Option.FillQuantity.Recommendation",
  "ConsumerProducts.CoffeeMaker.Option.FlowRate.Recommendation",
  "Cooking.Oven.Option.HeatupProgress",
  "LaundryCare.Common.Option.LoadRecommendation",
  "LaundryCare.Common.Option.ProcessPhase",
  "LaundryCare.Dryer.Option.ConnectedDry.OriginalProgramTime",
  "LaundryCare.Dryer.Option.ProcessPhase",
  "LaundryCare.Washer.Option.ProcessPhase",
]);

/** Option keys that describe the running program itself (a coffee favourite's base program and name). */
const PROGRAM_RUN_VALUES: ReadonlySet<string> = new Set([
  "BSH.Common.Option.BaseProgram",
  "BSH.Common.Option.ProgramName",
]);

/**
 * The channel a run value delivered under an `.Option.` key belongs to.
 *
 * @param key the fully-qualified BSH key
 * @returns `status` or `programs` for a run value, undefined for everything else
 */
export function runValueChannel(key: string): "status" | "programs" | undefined {
  if (STATUS_RUN_VALUES.has(key)) {
    return "status";
  }
  return PROGRAM_RUN_VALUES.has(key) ? "programs" : undefined;
}

/**
 * Whether a key is a run value delivered under an `.Option.` key.
 *
 * @param key the fully-qualified BSH key
 * @returns whether the key is a run value
 */
export function isRunValueKey(key: string): boolean {
  return runValueChannel(key) !== undefined;
}
