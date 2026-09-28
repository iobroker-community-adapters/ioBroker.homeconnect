// Labels for the values a user sees in a selection list — in the system language,
// from the adapter's own table. The cloud's `displayvalues` come in whatever
// language the cloud picks ("1400 rpm", "Running" on a German installation), and
// most values arrive with no label at all; a `common.states` label is a plain
// string (objectsschema), so it is resolved here, once, in the system language.

import { humanizeId } from "./pure-helpers";
import { LABEL_LANGUAGES, VALUE_LABELS } from "./value-label-table";
import { ENUM_TYPE_VALUES, KEY_ENUM_TYPES, KEY_VALUE_NAMES } from "./enum-catalog";

/** The language every label falls back to. */
export const DEFAULT_LABEL_LANGUAGE = "en";

/** The appliance's display language setting — its values are language codes ("De", "EnUs"). */
const LANGUAGE_SETTING_KEY = "BSH.Common.Setting.Language";

/**
 * The adapter's own label of one BSH value in one language — by the value's last
 * segment, which names the same thing in every family that uses it
 * ("…WasherDryer.Program.Wool.Wool.Wool" and "…Washer.Program.Wool" are both wool).
 *
 * @param bshValue the full BSH value (or a bare tail)
 * @param lang the ioBroker system language
 * @returns the label, or undefined when the table has no row for the value
 */
export function ownValueLabel(bshValue: string, lang: string): string | undefined {
  const row = VALUE_LABELS[lastSegment(bshValue).toLowerCase()];
  if (!row) {
    return undefined;
  }
  const col = (LABEL_LANGUAGES as readonly string[]).indexOf(lang);
  return row[col >= 0 ? col : 0] ?? row[0];
}

/** The label of the idle program ("" in a program list), in every language of the table. */
const NO_PROGRAM = [
  "No program",
  "Kein Programm",
  "Нет программы",
  "Nenhum programa",
  "Geen programma",
  "Aucun programme",
  "Nessun programma",
  "Ningún programa",
  "Brak programu",
  "Немає програми",
  "无程序",
] as const;

/**
 * The label of the idle program — the value "" of a program list.
 *
 * @param lang the ioBroker system language
 * @returns the label
 */
export function noProgramLabel(lang: string): string {
  const col = (LABEL_LANGUAGES as readonly string[]).indexOf(lang);
  return NO_PROGRAM[col >= 0 ? col : 0] ?? NO_PROGRAM[0];
}

/** The label of a program the appliance reports only by its number, in every language of the table. */
const UNKNOWN_PROGRAM = [
  "Program %s (not identified yet)",
  "Programm %s (noch nicht zugeordnet)",
  "Программа %s (ещё не определена)",
  "Programa %s (ainda não identificado)",
  "Programma %s (nog niet herkend)",
  "Programme %s (pas encore identifié)",
  "Programma %s (non ancora identificato)",
  "Programa %s (aún sin identificar)",
  "Program %s (jeszcze nierozpoznany)",
  "Програма %s (ще не визначена)",
  "程序 %s（尚未识别）",
] as const;

/**
 * The label of a program the appliance reports only by its number — until the
 * adapter has seen that number next to a program it knows.
 *
 * @param uid the appliance's program number
 * @param lang the ioBroker system language
 * @returns the label
 */
export function unknownProgramLabel(uid: number, lang: string): string {
  const col = (LABEL_LANGUAGES as readonly string[]).indexOf(lang);
  return (UNKNOWN_PROGRAM[col >= 0 ? col : 0] ?? UNKNOWN_PROGRAM[0]).replace("%s", String(uid));
}

/**
 * A program's name in every language of the table — the translation object a
 * datapoint NAME carries (Admin shows the viewer's language), unlike a value
 * label, which is one string in the system language.
 *
 * @param programKey the full program key
 * @returns language → name
 */
export function programLabels(programKey: string): ioBroker.Translated {
  const names = Object.fromEntries(LABEL_LANGUAGES.map(l => [l, valueLabel(programKey, l)]));
  return { ...names, en: valueLabel(programKey, "en") };
}

/**
 * The name of a language code as the appliance's language setting sends it
 * ("De", "EnUs", "ZhTw"), in the system language — from the runtime's own
 * language names instead of a table of 51 × 11 entries.
 *
 * @param code the value tail, e.g. "EnUs"
 * @param lang the ioBroker system language
 * @returns the language name, or undefined when the runtime does not know the code
 */
function languageName(code: string, lang: string): string | undefined {
  const tag = code.replace(/([a-z])([A-Z])/g, "$1-$2");
  try {
    const name = new Intl.DisplayNames([lang === "zh-cn" ? "zh-CN" : lang], { type: "language" }).of(tag);
    return name && name.toLowerCase() !== tag.toLowerCase() ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The label a value shows in a selection list: the adapter's own in the system
 * language, else the cloud's label, else a readable English label from the tail
 * (never the bare short value — `"auto2": "auto2"` says nothing).
 *
 * @param bshValue the full BSH value
 * @param lang the ioBroker system language
 * @param cloudLabel the cloud's `displayvalues` entry for this value, if any
 * @param key the BSH key the value belongs to, when known
 * @returns the label
 */
export function valueLabel(bshValue: string, lang: string, cloudLabel?: string, key?: string): string {
  const own = key === LANGUAGE_SETTING_KEY ? languageName(lastSegment(bshValue), lang) : ownValueLabel(bshValue, lang);
  if (own !== undefined) {
    return own;
  }
  if (typeof cloudLabel === "string" && cloudLabel.trim().length > 0) {
    return cloudLabel.trim();
  }
  return humanizeId(lastSegment(bshValue));
}

/**
 * Every value a BSH key can take, as far as the adapter knows it — the list of a
 * value the cloud sends without constraints (a process phase, a drying target,
 * the program phase of a dishwasher). The type catalogue names full values; for a
 * key only the local appliance descriptions know, the value names are joined to
 * the prefix of the value that arrived, so no namespace is ever guessed.
 *
 * @param key the fully-qualified BSH key
 * @param value the value the cloud sent, if any
 * @returns the full values, or undefined when nothing is known about the key
 */
export function catalogValues(key: string, value?: unknown): readonly string[] | undefined {
  const type = KEY_ENUM_TYPES[key];
  if (type !== undefined) {
    return ENUM_TYPE_VALUES[type];
  }
  const names = KEY_VALUE_NAMES[key];
  if (!names || typeof value !== "string" || !value.includes(".")) {
    return undefined;
  }
  const prefix = value.slice(0, value.lastIndexOf("."));
  return names.map(n => `${prefix}.${n}`);
}

/**
 * The last dot-separated segment of a BSH value.
 *
 * @param bshValue the full BSH value
 * @returns its tail
 */
function lastSegment(bshValue: string): string {
  return bshValue.slice(bshValue.lastIndexOf(".") + 1);
}
