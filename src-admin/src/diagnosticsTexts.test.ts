import { describe, expect, it, vi } from "vitest";
import { DIAGNOSTICS_TEXTS, registerDiagnosticsTexts } from "./diagnosticsTexts";

const LANGUAGES = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];

describe("DIAGNOSTICS_TEXTS", () => {
  it("carries every admin language with the same keys and no empty word", () => {
    expect(Object.keys(DIAGNOSTICS_TEXTS).sort()).toEqual([...LANGUAGES].sort());
    const keys = Object.keys(DIAGNOSTICS_TEXTS.en).sort();
    for (const lang of LANGUAGES) {
      expect(Object.keys(DIAGNOSTICS_TEXTS[lang]).sort(), lang).toEqual(keys);
      for (const [key, word] of Object.entries(DIAGNOSTICS_TEXTS[lang])) {
        expect(word.trim(), `${lang}.${key}`).not.toBe("");
        expect(word.includes("%s"), `${lang}.${key}`).toBe(DIAGNOSTICS_TEXTS.en[key].includes("%s"));
      }
    }
  });
});

describe("registerDiagnosticsTexts", () => {
  it("hands every language over once per page", () => {
    const extend = vi.fn();
    registerDiagnosticsTexts(extend);
    registerDiagnosticsTexts(extend);
    expect(extend).toHaveBeenCalledTimes(LANGUAGES.length);
    expect(extend).toHaveBeenCalledWith(DIAGNOSTICS_TEXTS.de, "de");
  });
});
