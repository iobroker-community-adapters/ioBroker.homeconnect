import { describe, expect, it } from "vitest";
import { counterparts, fits, limitFor, limitKey, type Counterpart, type LimitedCall } from "./api-limits";

const HOST = "api.home-connect.com";
const read: LimitedCall = { host: HOST, method: "GET", path: "/api/homeappliances" };
const refresh: LimitedCall = {
  host: HOST,
  method: "POST",
  path: "/security/oauth/token",
  body: "grant_type=refresh_token&refresh_token=R",
};
const poll: LimitedCall = {
  host: HOST,
  method: "POST",
  path: "/security/oauth/token",
  body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=D&client_id=C",
};
const start: LimitedCall = { host: HOST, method: "PUT", path: "/api/homeappliances/ha1/programs/active", body: "{}" };
const stop: LimitedCall = { host: HOST, method: "DELETE", path: "/api/homeappliances/ha1/programs/active" };

describe("the declared Home Connect limits (api-docs → Rate Limiting, read 2026-11-08)", () => {
  it("declares every documented limit as its own counterpart, each with its source", () => {
    expect(counterparts().map(c => c.name)).toEqual([
      "Home Connect API",
      "Home Connect REST API",
      "Home Connect token refresh",
      "Home Connect program starts",
      "Home Connect program stops",
      "Home Connect event monitoring channels",
    ]);
    for (const limit of counterparts().flatMap(c => c.limits)) {
      expect(limit.source).toMatch(/^https:\/\/api-docs\.home-connect\.com\/general\/#rate-limiting \(.+\)$/);
      expect(limit.per).toBe("account");
    }
  });

  it("takes the strictest entry of a window over every counterpart a call fits", () => {
    // the average of 10 per second, not the burst of 20 declared first
    expect(limitFor(read, 1)).toBe(10);
    expect(limitFor(read, 60)).toBe(50);
    expect(limitFor(read, 86400)).toBe(1000);
    // a token refresh counts in the whole host's minute and in the token endpoint's own
    expect(limitFor(refresh, 60)).toBe(10);
    expect(limitFor(refresh, 86400)).toBe(100);
    expect(limitFor(start, 60)).toBe(5);
    expect(limitFor(stop, 60)).toBe(5);
  });

  it("counts the day of the REST API alone — a poll of the sign-in link's code is no REST request and no refresh", () => {
    expect(limitFor(poll, 60)).toBe(50);
    expect(() => limitFor(poll, 86400)).toThrow(
      "src/lib/api-limits.json declares no limit for POST /security/oauth/token in 86400 s",
    );
  });

  it("names a window the declaration does not carry instead of inventing a number", () => {
    expect(() => limitFor(read, 3600)).toThrow("declares no limit for GET /api/homeappliances in 3600 s");
  });

  it("names a window as the fleet suites do: its seconds, its errors, or the calls open at once", () => {
    expect(limitKey({ max: 50, seconds: 60, per: "account", source: "s" })).toBe("60");
    expect(limitKey({ max: 10, seconds: 600, errors: true, per: "account", source: "s" })).toBe("600 errors");
    expect(limitKey({ max: 10, concurrent: true, per: "account", source: "s" })).toBe("concurrent");
  });
});

describe("which calls a counterpart counts (as test/fleet-suites.js `fits` judges what test/network-hook.js notes)", () => {
  const named = (name: string): Counterpart["match"] => counterparts().find(c => c.name === name)!.match;

  it("judges the path without its query — the network hook notes it so", () => {
    expect(fits({ ...read, path: "/api/homeappliances?lang=de" }, named("Home Connect REST API"))).toBe(true);
    expect(fits({ ...read, path: "/security/oauth/token?x=/api/" }, named("Home Connect REST API"))).toBe(false);
  });

  it("counts a token refresh by its grant type wherever it stands in the form, and nothing else of the endpoint", () => {
    const match = named("Home Connect token refresh");
    expect(fits(refresh, match)).toBe(true);
    expect(fits({ ...refresh, body: "client_id=C&grant_type=refresh_token" }, match)).toBe(true);
    expect(fits({ ...refresh, body: "grant_type=refresh_token_x" }, match)).toBe(false);
    expect(fits(poll, match)).toBe(false);
    expect(fits({ ...refresh, body: undefined }, match)).toBe(false);
    expect(fits({ ...refresh, method: "GET" }, match)).toBe(false);
  });

  it("reads only the first 1024 characters of a body — the network hook notes no more", () => {
    const match = named("Home Connect token refresh");
    // 1000 characters before the grant type: it ends at character 1024 and counts; four more and it is cut off
    expect(fits({ ...refresh, body: `${"a=b&".repeat(250)}grant_type=refresh_token` }, match)).toBe(true);
    expect(fits({ ...refresh, body: `${"a=b&".repeat(251)}grant_type=refresh_token` }, match)).toBe(false);
  });

  it("tells a program start from a stop by the method, and an option of the active program from both", () => {
    expect(fits(start, named("Home Connect program starts"))).toBe(true);
    expect(fits(start, named("Home Connect program stops"))).toBe(false);
    expect(fits(stop, named("Home Connect program stops"))).toBe(true);
    const option = { ...start, path: "/api/homeappliances/ha1/programs/active/options/X" };
    expect(fits(option, named("Home Connect program starts"))).toBe(false);
  });

  it("counts the stream of all appliances and of one appliance as event monitoring channels", () => {
    const match = named("Home Connect event monitoring channels");
    expect(fits({ ...read, path: "/api/homeappliances/events" }, match)).toBe(true);
    expect(fits({ ...read, path: "/api/homeappliances/ha1/events" }, match)).toBe(true);
    expect(fits({ ...read, path: "/api/homeappliances/ha1/events/x" }, match)).toBe(false);
    expect(fits(read, match)).toBe(false);
  });

  it("matches a host pattern as a regular expression and every other field for equality", () => {
    expect(fits(read, { hostPattern: "^api\\.home-connect\\.com$" })).toBe(true);
    expect(fits({ ...read, host: "simulator.home-connect.com" }, { hostPattern: "^api\\." })).toBe(false);
    expect(fits(read, { host: "api.home-connect.com", method: "GET" })).toBe(true);
    expect(fits(read, { host: "api.home-connect.com", method: "PUT" })).toBe(false);
    // a field the declaration leaves undefined asks nothing
    expect(fits(read, { host: HOST, method: undefined })).toBe(true);
  });
});
