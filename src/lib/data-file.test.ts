// Fleet master (.consistency-master/src/lib/data-file.test.ts) — never edit the copy in an adapter.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDataFiles, readDataFile, removeDataFile, setAsideDataFile, writeDataFile } from "./data-file";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "data-file-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readDataFile", () => {
  it("reads nothing while there is no file yet", () => {
    expect(readDataFile(dir, "state.json")).toEqual({});
  });

  it("reads the value a write stored", () => {
    writeDataFile(dir, "state.json", { highest: 7, names: ["a"] });
    expect(readDataFile(dir, "state.json")).toEqual({ value: { highest: 7, names: ["a"] } });
  });

  it("says why a file without JSON is unusable", () => {
    writeFileSync(join(dir, "state.json"), "{ half", "utf8");
    const read = readDataFile(dir, "state.json");
    expect(read.value).toBeUndefined();
    expect(read.error).toMatch(/^no JSON: /);
  });

  it("says why a file that cannot be read is unusable", () => {
    mkdirSync(join(dir, "state.json"));
    const read = readDataFile(dir, "state.json");
    expect(read.value).toBeUndefined();
    expect(read.error).toMatch(/EISDIR/);
  });
});

describe("writeDataFile", () => {
  it("creates the folder, writes JSON and leaves no temporary file", () => {
    const sub = join(dir, "cache");
    writeDataFile(sub, "a.json", { on: true });
    expect(readFileSync(join(sub, "a.json"), "utf8")).toBe('{\n  "on": true\n}\n');
    expect(listDataFiles(sub)).toEqual(["a.json"]);
  });

  it("is readable for the owner only", () => {
    writeDataFile(dir, "secret.json", "token");
    // Windows knows a file only as read-only (0o444) or writable (0o666) — Node.js docs fs, "File modes"
    expect(statSync(join(dir, "secret.json")).mode & 0o777).toBe(process.platform === "win32" ? 0o666 : 0o600);
  });

  it("replaces the old content as a whole", () => {
    writeDataFile(dir, "state.json", { a: 1, b: 2 });
    writeDataFile(dir, "state.json", { a: 3 });
    expect(readDataFile(dir, "state.json")).toEqual({ value: { a: 3 } });
  });
});

describe("setAsideDataFile", () => {
  it("keeps an unreadable file under another name instead of losing it to the next write", () => {
    writeFileSync(join(dir, "clients.json"), "{ half", "utf8");
    setAsideDataFile(dir, "clients.json", "clients.json.unreadable");
    expect(readDataFile(dir, "clients.json")).toEqual({});
    expect(readFileSync(join(dir, "clients.json.unreadable"), "utf8")).toBe("{ half");
  });

  it("does nothing when the file is not there", () => {
    expect(() => setAsideDataFile(dir, "clients.json", "clients.json.unreadable")).not.toThrow();
    expect(listDataFiles(dir)).toEqual([]);
  });

  it("throws every other error", () => {
    writeFileSync(join(dir, "clients.json"), "{}", "utf8");
    mkdirSync(join(dir, "aside"));
    writeFileSync(join(dir, "aside", "keep"), "x", "utf8");
    expect(() => setAsideDataFile(dir, "clients.json", "aside")).toThrow();
  });
});

describe("removeDataFile", () => {
  it("removes a file", () => {
    writeDataFile(dir, "login.json", "token");
    removeDataFile(dir, "login.json");
    expect(readDataFile(dir, "login.json")).toEqual({});
  });

  it("does nothing when the file is not there", () => {
    expect(() => removeDataFile(dir, "login.json")).not.toThrow();
  });

  it("throws every other error", () => {
    mkdirSync(join(dir, "login.json"));
    expect(() => removeDataFile(dir, "login.json")).toThrow();
  });
});

describe("listDataFiles", () => {
  it("lists the files of a folder in order, without its folders", () => {
    writeDataFile(dir, "b.json", 2);
    writeDataFile(dir, "a.json", 1);
    mkdirSync(join(dir, "sub"));
    expect(listDataFiles(dir)).toEqual(["a.json", "b.json"]);
  });

  it("lists nothing while the folder is not there", () => {
    expect(listDataFiles(join(dir, "missing"))).toEqual([]);
  });

  it("throws every other error", () => {
    writeFileSync(join(dir, "plain"), "x", "utf8");
    expect(() => listDataFiles(join(dir, "plain"))).toThrow();
  });
});
