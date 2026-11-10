// Core decision H-11 (accepted 2026-10-15, changed 2026-11-10): in the developer access every user creates his own Client
// ID in the Home Connect developer portal. The app access (beta) uses the public client of the Home Connect app. There is
// no shared Client ID of the adapter, that is no developer account of its own at BSH.
// krobi 2026-09-26 22:19 on asking BSH for a shared one (the contract needs a business): "I have no business and will not
// register one for this, so strike it". 2026-11-10 10:48: "the shared client id would be a developer account for an app at
// BSH, and has nothing to do with the users' individual accounts". 2026-11-10 10:50: "Yes, change H-11 like this".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_CLIENT_ID } from "../lib/app-client";

/** The public client of the Home Connect app — the one Client ID the code may carry. */
const APP_CLIENT = "9B75AC9EC512F36C84256AC47D813E2C1DD0D6520DF774B020E1E6E2EB29B1F3";

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

describe("H-11 own Client ID in the developer access, the app's public client in the app access, none of the adapter", () => {
  it("developer access: ships no Client ID and asks for one in the settings", () => {
    const io = JSON.parse(readFileSync(join(process.cwd(), "io-package.json"), "utf8")) as {
      native: { clientID?: unknown };
    };
    expect(io.native.clientID).toBe("");
    const config = readFileSync(join(process.cwd(), "admin", "jsonConfig.json"), "utf8");
    expect(config).toContain('"clientID"');
  });

  it("app access: uses the public client of the Home Connect app", () => {
    expect(APP_CLIENT_ID).toBe(APP_CLIENT);
  });

  it("no shared Client ID of the adapter: no other 64-hex literal in the code", () => {
    const root = join(process.cwd(), "src");
    const hits = sources(root)
      .filter(f => !/\.test\.tsx?$/.test(f))
      .flatMap(f =>
        [...readFileSync(f, "utf8").matchAll(/["'`]([0-9A-Fa-f]{64})["'`]/g)].map(
          m => `${relative(root, f).replace(/\\/g, "/")}: ${m[1]}`,
        ),
      );
    expect(hits).toEqual([`lib/app-client.ts: ${APP_CLIENT}`]);
  });
});
