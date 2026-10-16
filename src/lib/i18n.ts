import { I18n } from "@iobroker/adapter-core";
import type translations from "../../admin/i18n/en.json";

/** A key of admin/i18n/en.json — the compiler rejects a typo. */
export type I18nKey = keyof typeof translations;

/**
 * Resolve a key to a translation object for `common.name` / `common.desc` —
 * Admin renders the viewer's language, nothing is resolved adapter-side
 * (core-team line: an object for every object type, no system-language string).
 * `%s` placeholders are filled from `args` in every language.
 *
 * @param key Translation key from admin/i18n/en.json
 * @param args Values for `%s` placeholders
 */
export function tName(key: I18nKey, ...args: (string | number)[]): ioBroker.StringOrTranslated {
  return I18n.getTranslatedObject(key, ...args);
}

/**
 * Resolve a key to a text in the system language — for an answer the user reads at once (the connection test), not
 * for an object name.
 *
 * @param key Translation key from admin/i18n/en.json
 * @param args Values for `%s` placeholders
 */
export function tText(key: I18nKey, ...args: (string | number)[]): string {
  return I18n.translate(key, ...args);
}
