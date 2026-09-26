import { describe, it, expect } from "vitest";
import { slugOf, errMessage, cleanLabel, humanizeId, coerceForType } from "./pure-helpers";

describe("slugOf", () => {
  it("transliterates umlauts and lower-cases", () => {
    expect(slugOf("Geschirrspüler")).toBe("geschirrspueler");
    expect(slugOf("Kühl-Gefrier-Kombination")).toBe("kuehl-gefrier-kombination");
    expect(slugOf("Waschtrockner")).toBe("waschtrockner");
    expect(slugOf("Straße")).toBe("strasse");
  });

  it("strips diacritics from non-German accented letters instead of dropping them", () => {
    expect(slugOf("Réfrigérateur")).toBe("refrigerateur");
    expect(slugOf("Cafetera automática")).toBe("cafetera-automatica");
    expect(slugOf("Piekarnik Świętokrzyski")).toBe("piekarnik-swietokrzyski");
  });

  it("collapses other characters to single hyphens and trims them", () => {
    expect(slugOf("Bosch  Serie 6 / 2024")).toBe("bosch-serie-6-2024");
    expect(slugOf("SX87TX02CE/60")).toBe("sx87tx02ce-60");
    expect(slugOf("--edge--")).toBe("edge");
  });

  it("is empty when nothing usable remains", () => {
    expect(slugOf("")).toBe("");
    expect(slugOf("///")).toBe("");
  });
});

describe("errMessage", () => {
  it("returns the message for an Error", () => {
    expect(errMessage(new Error("boom"))).toBe("boom");
  });
  it("stringifies non-Error values", () => {
    expect(errMessage("nope")).toBe("nope");
    expect(errMessage(42)).toBe("42");
    expect(errMessage(null)).toBe("null");
    expect(errMessage(undefined)).toBe("undefined");
    expect(errMessage(Symbol("late"))).toBe("Symbol(late)");
  });
  it("renders a thrown plain object instead of [object Object]", () => {
    // A rejected fetch and an HTTP client's error object are plain objects; the
    // old helper logged "[object Object]" for them — no cause, no place.
    expect(errMessage({ code: "ECONNRESET", syscall: "read" })).toBe('{"code":"ECONNRESET","syscall":"read"}');
    expect(errMessage([1, 2])).toBe("[1,2]");
  });
  it("falls back to the type tag where JSON.stringify cannot answer", () => {
    // A circular structure makes JSON.stringify THROW and a BigInt field too —
    // a logger that throws inside a catch block turns a handled error into a
    // crash. (A function is not an object to the master form: it renders itself.)
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(errMessage(circular)).toBe("[object Object]");
    expect(errMessage({ big: 1n })).toBe("[object Object]");
  });
});

describe("cleanLabel", () => {
  it("strips control characters and collapses whitespace", () => {
    // A line break inside an appliance name splits a log line and puts a
    // two-line label into the object tree.
    expect(cleanLabel("Geschirr\nspüler\t  oben ")).toBe("Geschirr spüler oben");
    expect(cleanLabel("\u0007Backofen\u009f")).toBe("Backofen");
  });

  it("returns the fallback for non-strings and empty results", () => {
    expect(cleanLabel(undefined, "x")).toBe("x");
    expect(cleanLabel(42, "x")).toBe("x");
    expect(cleanLabel("   \n", "x")).toBe("x");
    expect(cleanLabel("")).toBe("");
  });

  it("caps an overlong label", () => {
    const out = cleanLabel("a".repeat(500));
    expect(out).toHaveLength(200);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("humanizeId", () => {
  it("turns a camelCase id into a sentence-case label", () => {
    expect(humanizeId("operationState")).toBe("Operation state");
    expect(humanizeId("doorFreezerOpen")).toBe("Door freezer open");
    expect(humanizeId("favorite001ExternalTrigger")).toBe("Favorite 001 external trigger");
  });

  it("keeps a brand spelling like iDos in one piece", () => {
    // "I dos 1 fill level poor" is what a naive split produces — it reads broken.
    expect(humanizeId("iDos1FillLevelPoor")).toBe("iDos 1 fill level poor");
    expect(humanizeId("iDos2Active")).toBe("iDos 2 active");
    // A normal id is untouched: the rule needs a single letter before a capital.
    expect(humanizeId("doorOpen")).toBe("Door open");
    expect(humanizeId("interiorIlluminationActive")).toBe("Interior illumination active");
    expect(humanizeId("saltNearlyEmpty")).toBe("Salt nearly empty");
    expect(humanizeId("x")).toBe("X");
  });
});

describe("coerceForType", () => {
  it("brings script-written text into a boolean switch", () => {
    expect(coerceForType("true", "boolean")).toBe(true);
    expect(coerceForType("0", "boolean")).toBe(false);
    expect(coerceForType(1, "boolean")).toBe(true);
    expect(coerceForType("on", "boolean")).toBe(true);
    expect(coerceForType("maybe", "boolean")).toBeUndefined();
  });

  it("brings text into a number and refuses what is not one", () => {
    expect(coerceForType("40", "number")).toBe(40);
    expect(coerceForType(" 2.5 ", "number")).toBe(2.5);
    expect(coerceForType(true, "number")).toBe(1);
    expect(coerceForType("forty", "number")).toBeUndefined();
    expect(coerceForType("", "number")).toBeUndefined();
    expect(coerceForType(Number.NaN, "number")).toBeUndefined();
  });

  it("stringifies for a string state and passes through when the type is unknown", () => {
    expect(coerceForType(7, "string")).toBe("7");
    expect(coerceForType("run", undefined)).toBe("run");
    expect(coerceForType(null, "boolean")).toBeUndefined();
  });
});
