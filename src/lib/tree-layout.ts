// The layout of an appliance's tree (krobi 2026-10-16 13:26–13:36): a channel of its own only for a group of one kind
// with a meaning of its own — `status` the appliance's state, `run` the program under way, `doors` every door,
// `events` every event, `counters` the running totals; inside each, every value is a plain datapoint. What a key's
// channel kind (`Status`, `Option` run value) does not decide is decided here, by the datapoint id, from the
// inventory of all 17 appliance types; a new id without an entry stays where its kind puts it.

/** The ids of the program under way — remaining/elapsed/total time, progress, phase, forecasts, recommendations. */
const RUN_IDS: ReadonlySet<string> = new Set([
  "remainingProgramTime",
  "remainingProgramTimeAutoCounting",
  "remainingProgramTimeIsEstimated",
  "remainingProgramTimeEstimationState",
  "elapsedProgramTime",
  "elapsedProgramTimeAutoCounting",
  "estimatedTotalProgramTime",
  "currentStepRemainingTime",
  "programProgress",
  "processPhase",
  "programPhase",
  "heatupProgress",
  "energyForecast",
  "waterForecast",
  "loadRecommendation",
  "fillQuantityRecommendation",
  "flowRateRecommendation",
  "coarsnessRecommendation",
  "coffeeStrengthRecommendation",
  "coffeeTemperatureRecommendation",
  "connectedDryOriginalProgramTime",
  "ecoDryActive",
]);

/** The running totals the appliance keeps over all its programs. */
const COUNTER_IDS: ReadonlySet<string> = new Set(["detergentAllConsumed", "softenerAllConsumed"]);

/**
 * The channel a datapoint of the appliance's state belongs to.
 *
 * @param channel the channel its key kind gives (`status` for a status key or a run value)
 * @param id the datapoint id within that channel
 * @returns `run`, `counters` or the channel unchanged
 */
export function layoutChannel(channel: string, id: string): string {
  if (channel !== "status") {
    return channel;
  }
  if (RUN_IDS.has(id)) {
    return "run";
  }
  if (COUNTER_IDS.has(id) || id.startsWith("programAll") || id.startsWith("beverageCounter")) {
    return "counters";
  }
  return channel;
}
