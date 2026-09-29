// How a number from Home Connect is shown: in the unit a user reads (krobi 2026-09-29, one row per datapoint,
// decision 47). Pure — the transformer, the option definitions, the decoded run summary, the priming and the
// write path all go through this one table, so a value never flips its unit between sync and stream.

/** A number shown in another unit than the one the appliance sends. */
export interface Presentation {
  /** The unit the datapoint shows. */
  unit: string;
  /** The appliance's value divided by this is the shown value; the shown value times this goes back. */
  factor: number;
  /** Decimals the shown value keeps. */
  decimals: number;
  /** The units the appliance sends this value in — only these are converted, anything else stays as it comes. */
  from: readonly string[];
}

const MINUTES: Presentation = { unit: "min", factor: 60, decimals: 0, from: ["seconds", "s"] };
const LITRES_FROM_ML: Presentation = { unit: "l", factor: 1000, decimals: 1, from: ["ml"] };

/**
 * Datapoint by datapoint, as krobi chose them on 2026-09-29 (the table with the live values: "ja deine
 * vorschläge sind doch absolut super, passt genau"). A key not listed shows what the appliance sends.
 */
const PRESENTATIONS: Record<string, Presentation> = {
  // Lifetime totals of a laundry appliance: 2,011,440 s read as 558.7 h, 139,858 Wh as 139.86 kWh.
  "BSH.Common.Status.Program.All.Time.Effective": { unit: "h", factor: 3600, decimals: 1, from: ["seconds", "s"] },
  "BSH.Common.Status.Program.All.Energy.Consumed": { unit: "kWh", factor: 1000, decimals: 2, from: ["Wh"] },
  // The cloud sends the water counter as millilitres, measured with the unit "ml" and — decision 45 — with "l"
  // on a value that is millilitres all the same (12,171,000 "l" after 339 runs).
  "BSH.Common.Status.Program.All.Water.Consumed": { unit: "l", factor: 1000, decimals: 1, from: ["ml", "l"] },
  "LaundryCare.Washer.Status.Detergent.All.Consumed": LITRES_FROM_ML,
  "LaundryCare.Washer.Status.Softener.All.Consumed": LITRES_FROM_ML,
  "LaundryCare.Common.Option.LoadRecommendation": { unit: "kg", factor: 1000, decimals: 1, from: ["gram", "g"] },
  // Durations: whole minutes — 9,060 s of remaining time read as 151 min.
  "BSH.Common.Status.RemoteControlStartAllowedSince": MINUTES,
  "BSH.Common.Option.RemainingProgramTime": MINUTES,
  "BSH.Common.Option.EstimatedTotalProgramTime": MINUTES,
  "BSH.Common.Option.FinishInRelative": MINUTES,
  "BSH.Common.Option.StartInRelative": MINUTES,
  "BSH.Common.Option.Duration": MINUTES,
  "BSH.Common.Option.ElapsedProgramTime": MINUTES,
  "BSH.Common.Option.CurrentStepRemainingTime": MINUTES,
  "BSH.Common.Setting.AlarmClock": MINUTES,
};

/** The energy of one run from the run summary (Wh on the wire): kWh, like the lifetime total. */
export const RUN_ENERGY: Presentation = { unit: "kWh", factor: 1000, decimals: 2, from: ["Wh"] };

/** The unit words the cloud writes out, as ioBroker writes them (measured live 2026-09-29: "seconds", "gram"). */
const UNIT_WORDS: Record<string, string> = { seconds: "s", gram: "g" };

/**
 * The presentation of a key's value, when the appliance sends it in a unit the table converts.
 *
 * @param key the fully-qualified BSH key
 * @param unit the unit the appliance sent
 * @returns the presentation, or undefined when the value shows as it comes
 */
export function presentationFor(key: string | undefined, unit: string | undefined): Presentation | undefined {
  const p = key === undefined ? undefined : PRESENTATIONS[key];
  return p && unit !== undefined && p.from.includes(unit) ? p : undefined;
}

/**
 * The presentation a key's datapoint shows in, whatever unit the appliance sends — for the write path, which knows
 * the key and the shown value but not the unit of the last answer.
 *
 * @param key the fully-qualified BSH key
 * @returns the presentation, or undefined
 */
export function shownPresentation(key: string | undefined): Presentation | undefined {
  return key === undefined ? undefined : PRESENTATIONS[key];
}

/**
 * The shown value of a number.
 *
 * @param value the appliance's value
 * @param p the presentation
 * @returns the value in the shown unit, rounded to its decimals
 */
export function toShown(value: number, p: Presentation): number {
  const scale = 10 ** p.decimals;
  return Math.round((value / p.factor) * scale) / scale;
}

/**
 * The appliance's value of a shown number — for a write.
 *
 * @param value the shown value
 * @param p the presentation
 * @returns the value in the appliance's unit, a whole number
 */
export function fromShown(value: number, p: Presentation): number {
  return Math.round(value * p.factor);
}

/**
 * The unit to show: the table's, else the cloud's word in ioBroker's spelling, else the unit as sent.
 *
 * @param key the fully-qualified BSH key
 * @param unit the unit the appliance sent
 * @returns the unit for `common.unit`, or undefined
 */
export function shownUnit(key: string | undefined, unit: string | undefined): string | undefined {
  const p = presentationFor(key, unit);
  if (p) {
    return p.unit;
  }
  return unit === undefined ? undefined : (UNIT_WORDS[unit] ?? unit);
}

/**
 * A bound or step in the shown unit. A bound stays inside the appliance's range — the minimum rounds up, the
 * maximum down (1 s is 1 min, not 0 min the appliance would refuse); a step is never below one shown unit.
 *
 * @param value the bound or step in the appliance's unit
 * @param p the presentation
 * @param kind which of the three it is
 * @returns the shown bound or step
 */
export function boundShown(value: number, p: Presentation, kind: "min" | "max" | "step"): number {
  const scale = 10 ** p.decimals;
  const exact = (value / p.factor) * scale;
  if (kind === "step") {
    return Math.max(Math.round(exact), 1) / scale;
  }
  const bound = (kind === "min" ? Math.ceil(exact - 1e-9) : Math.floor(exact + 1e-9)) / scale;
  return bound + 0; // never -0
}
