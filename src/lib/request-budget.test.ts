import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSentTimes, writeSentTimes } from "./request-budget";

describe("the request budget across a restart", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const file = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "hc-budget-"));
    dirs.push(dir);
    return join(dir, "homeconnect.0", "request-times.json");
  };

  it("hands the next process the send times of the last minute, the folder created on the way", () => {
    const f = file();
    writeSentTimes(f, [1_000, 50_000, 70_000, 100_000], 100_500);
    // Only the last minute is kept.
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ sentAt: [50_000, 70_000, 100_000] });
    // 1_000 left the window before the stop; the rest still counts at the next start.
    expect(readSentTimes(f, 101_000)).toEqual([50_000, 70_000, 100_000]);
    // A minute after a send it no longer counts.
    expect(readSentTimes(f, 130_000)).toEqual([100_000]);
  });

  it("starts with a full budget when there is no file or one it cannot read", () => {
    const f = file();
    expect(readSentTimes(f, 1_000)).toEqual([]);
    writeSentTimes(f, [], 0);
    writeFileSync(f, "{not json");
    expect(readSentTimes(f, 1_000)).toEqual([]);
    writeFileSync(f, JSON.stringify({ sentAt: 5 }));
    expect(readSentTimes(f, 1_000)).toEqual([]);
    writeFileSync(f, JSON.stringify({ sentAt: ["5", null, 900, 2_000] }));
    // Only numbers, never one from the future (a clock set back would block the whole minute).
    expect(readSentTimes(f, 1_000)).toEqual([900]);
  });
});
