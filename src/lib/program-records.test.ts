import { describe, expect, it } from "vitest";
import {
  decodeErrorCodes,
  decodeFavoriteProgram,
  decodeHistoryMinutes,
  decodeHistoryUids,
  decodeProgramDetails,
  decodeSessionSummary,
} from "./program-records";

// Real values of a washer-dryer and a dishwasher (2026-09-27), checked against
// their run history: the last run was the spin program (31670), 12 minutes,
// 14:35:55 → 14:47:59 UTC — the summary says the same.
const WD_SUMMARY =
  '{"counter":359,"end":"2026-09-27T14:47:59.859Z","sequence":[{"configuration":{"options":[{"uid":24585,"value":false}],"program":31670},"details":[{"uid":616,"value":339},{"uid":623,"value":0},{"uid":626,"value":0},{"uid":628,"value":40},{"uid":8198,"value":0},{"uid":4356,"value":true}]}],"start":"2026-09-27T14:35:55.271Z"}';
const DW_SUMMARY =
  '{"counter":517,"end":"2026-09-27T21:28:11+00:00","sequence":[{"configuration":{"options":[],"program":8195},"details":[]}],"start":"2026-09-27T19:31:03+00:00"}';

describe("program records", () => {
  it("reads the program history newest first", () => {
    expect(decodeHistoryUids("ewN7B3u2e7Y")).toEqual([31670, 31670, 31495, 31491]);
    expect(decodeHistoryMinutes("AL0A-QAMAAw")).toEqual([12, 12, 249, 189]);
  });

  it("reads a program's lifetime counters", () => {
    expect(decodeProgramDetails("D3sHAF0AXwANqOA")).toEqual({
      uid: 31495,
      completed: 93,
      started: 95,
      seconds: 895200,
    });
    expect(decodeProgramDetails("D3u5AAEAAQAAFGQ")).toEqual({ uid: 31673, completed: 1, started: 1, seconds: 5220 });
  });

  it("reads the summary of the last run", () => {
    expect(decodeSessionSummary(WD_SUMMARY)).toEqual({
      counter: 359,
      start: Date.parse("2026-09-27T14:35:55.271Z"),
      end: Date.parse("2026-09-27T14:47:59.859Z"),
      programUid: 31670,
      // Numbers only — a flag (4356) is no figure of the run.
      details: { 616: 339, 623: 0, 626: 0, 628: 40, 8198: 0 },
    });
    expect(decodeSessionSummary(DW_SUMMARY)?.programUid).toBe(8195);
  });

  it("reads the fault codes as one text, empty when there is none", () => {
    expect(decodeErrorCodes("[]")).toBe("");
    expect(decodeErrorCodes('["E15", "E24"]')).toBe("E15, E24");
    expect(decodeErrorCodes("[4711]")).toBe("4711");
    // The appliances' local form of the same list.
    expect(decodeErrorCodes('{"length":0,"list":[]}')).toBe("");
    expect(decodeErrorCodes('{"length":1,"list":["E15"]}')).toBe("E15");
  });

  it("reads the program a favourite slot holds", () => {
    // Local form (hcpy2-0/hcpy#116, zibous allMandatoryValues.json:117).
    expect(decodeFavoriteProgram('{"length":1,"list":[{"program":8200,"options":[{"uid":5136,"value":false}]}]}')).toBe(
      8200,
    );
    expect(decodeFavoriteProgram("null")).toBeUndefined();
    expect(decodeFavoriteProgram('{"list":[{"program":"x"}]}')).toBeUndefined();
  });

  it("decodes a value of another shape to nothing — never to a guess, never raw", () => {
    // Wrong marker, wrong length, not base64, odd byte count.
    expect(decodeProgramDetails("AEQAGABFAAA")).toBeUndefined();
    // Right length, wrong first byte.
    expect(decodeProgramDetails("DnsHAF0AXwANqOA")).toBeUndefined();
    expect(decodeProgramDetails("D3sHAF0AXwANqO")).toBeUndefined();
    expect(decodeProgramDetails("not base64!")).toBeUndefined();
    expect(decodeHistoryUids("AAAA")).toBeUndefined();
    expect(decodeHistoryUids("")).toBeUndefined();
    expect(decodeHistoryUids(42)).toBeUndefined();
    // The summary: not JSON, no counter, no program number, unreadable times.
    expect(decodeSessionSummary("ewN7e3sDewc")).toBeUndefined();
    expect(decodeSessionSummary('{"start":"2026-09-27T14:35:55Z"}')).toBeUndefined();
    expect(decodeSessionSummary(WD_SUMMARY.replace('"program":31670', '"program":"x"'))).toBeUndefined();
    expect(decodeSessionSummary(WD_SUMMARY.replace("2026-09-27T14:47:59.859Z", "later"))).toBeUndefined();
    // Fault codes: not a list, or a list of records.
    expect(decodeErrorCodes('{"code":1}')).toBeUndefined();
    expect(decodeErrorCodes('[{"code":1}]')).toBeUndefined();
    expect(decodeErrorCodes("E15")).toBeUndefined();
  });
});
