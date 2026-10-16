// Core decision H-11 (accepted 2026-10-15): there is no shared Client ID — every user creates his own in the Home Connect
// developer portal. krobi 2026-09-26 22:19 on asking BSH for a shared one (the contract needs a business): "I have no
// business and will not register one for this, so strike it".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every source file below a folder.
 *
 * @param dir the folder
 * @returns the file paths
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("H-11 every user brings his own Client ID", () => {
  it("ships no Client ID and asks for one in the settings", () => {
    const io = JSON.parse(readFileSync(join(process.cwd(), "io-package.json"), "utf8")) as {
      native: { clientID?: unknown };
    };
    expect(io.native.clientID).toBe("");
    const config = readFileSync(join(process.cwd(), "admin", "jsonConfig.json"), "utf8");
    expect(config).toContain('"clientID"');
  });

  it("carries no Client ID in its code (64 hexadecimal characters)", () => {
    const hits = sources(join(process.cwd(), "src"))
      .filter(f => !/\.test\.tsx?$/.test(f))
      .filter(f => /["'`][0-9A-Fa-f]{64}["'`]/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
