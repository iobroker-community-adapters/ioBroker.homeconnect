// Fleet master (.consistency-master/src/lib/data-file.ts) — never edit the copy in an adapter.
//
// The files an adapter keeps in its instance data folder (`utils.getAbsoluteInstanceDataDir`, declared as
// `common.dataFolder`, so a backup carries them): what it creates or learns itself and keeps across restarts and updates
// — a generated secret, a runtime value, a cache — never in `native`, `common` or an object id (CLAUDE_PATTERNS.md
// § „Wohin“). This file is the one form of every access to them (round 173): a write goes to a temporary file renamed
// over the old one, so a crash mid-write never leaves half a file, readable for the owner only; a read says nothing (no
// file yet), the value, or why the file is unusable. What the adapter does with an unusable file — set it aside and
// start, or halt the start — is its own decision.
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { errText } from "./err-text";

/** The result of reading a data file: nothing there, its value, or why it is unusable. */
export interface DataFileRead {
  /** The parsed content, when the file is there and holds JSON. */
  value?: unknown;
  /** Set when the file exists but cannot be used. */
  error?: string;
}

/**
 * Whether a file-system error says the path is not there.
 *
 * @param err what the file system threw
 * @returns true for ENOENT
 */
function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Read a data file.
 *
 * @param dir the folder in the instance data folder
 * @param file the file name in it
 * @returns the value, nothing (no file yet), or the reason the file is unusable
 */
export function readDataFile(dir: string, file: string): DataFileRead {
  let raw: string;
  try {
    raw = readFileSync(join(dir, file), "utf8");
  } catch (err) {
    return isMissing(err) ? {} : { error: errText(err) };
  }
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch (err) {
    return { error: `no JSON: ${errText(err)}` };
  }
}

/**
 * Write a data file — a temporary file renamed over the old one.
 *
 * @param dir the folder in the instance data folder (created when missing)
 * @param file the file name in it
 * @param value what to store, as JSON
 */
export function writeDataFile(dir: string, file: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, file);
  const temp = `${target}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, target);
}

/**
 * Move a data file aside under another name — a file that cannot be read is kept this way instead of being overwritten
 * by the next write. Nothing happens when the file is not there.
 *
 * @param dir the folder in the instance data folder
 * @param file the file name in it
 * @param aside the name it is kept under
 */
export function setAsideDataFile(dir: string, file: string, aside: string): void {
  try {
    renameSync(join(dir, file), join(dir, aside));
  } catch (err) {
    if (!isMissing(err)) {
      throw err;
    }
  }
}

/**
 * Remove a data file. Nothing happens when the file is not there.
 *
 * @param dir the folder in the instance data folder
 * @param file the file name in it
 */
export function removeDataFile(dir: string, file: string): void {
  try {
    unlinkSync(join(dir, file));
  } catch (err) {
    if (!isMissing(err)) {
      throw err;
    }
  }
}

/**
 * The files of a folder in the instance data folder, in order — its sub-folders not. Nothing while the folder is not
 * there.
 *
 * @param dir the folder in the instance data folder
 * @returns the file names, sorted
 */
export function listDataFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort();
  } catch (err) {
    if (isMissing(err)) {
      return [];
    }
    throw err;
  }
}
