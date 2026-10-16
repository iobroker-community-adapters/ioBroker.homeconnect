// Core decision H-12 (accepted 2026-10-15): the sign-in part of the settings stays a React panel — it switches live with
// the sign-in state and answers at the button; the other settings are jsonConfig. krobi 2026-09-27 19:47: "in short,
// the sign-in part is React because it is better for feedback, and this part is dynamic depending on the sign-in state".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("H-12 the sign-in panel is a React component inside the jsonConfig settings", () => {
  it("embeds the custom sign-in component in the jsonConfig page", () => {
    const io = JSON.parse(readFileSync(join(process.cwd(), "io-package.json"), "utf8")) as {
      common: { adminUI?: { config?: string } };
    };
    expect(io.common.adminUI?.config).toBe("json");
    const config = readFileSync(join(process.cwd(), "admin", "jsonConfig.json"), "utf8");
    expect(config).toMatch(/"type":\s*"custom"/);
    expect(config).toMatch(/"url":\s*"custom\/customComponents\.js"/);
  });

  it("keeps the panel's source as React", () => {
    const panel = readFileSync(join(process.cwd(), "src-admin", "src", "SignIn.tsx"), "utf8");
    expect(panel).toMatch(/^import .* from ["']react["'];$/m);
  });
});
