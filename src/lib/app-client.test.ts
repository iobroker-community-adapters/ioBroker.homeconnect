import { describe, expect, it } from "vitest";

import {
  APP_CLIENT_ID,
  APP_REDIRECT_URI,
  APP_SCOPES,
  AUTHORIZE_PATH,
  appAuthorizeUrl,
  challengeOf,
  codeFrom,
  makeVerifier,
} from "./app-client";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const urlSafe = (base64: string): string => base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("PKCE", () => {
  it("publishes the verifier as its SHA-256 in base64url (RFC 7636, appendix B)", () => {
    expect(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("makes a fresh verifier of 64 random bytes each time", () => {
    const first = makeVerifier();
    expect(first).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(makeVerifier()).not.toBe(first);
  });
});

describe("appAuthorizeUrl", () => {
  it("asks for the app's sign-in with PKCE and the login prompt", () => {
    const url = new URL(appAuthorizeUrl("https://api.home-connect.com", "v".repeat(43), "st", "no"));
    expect(`${url.origin}${url.pathname}`).toBe(`https://api.home-connect.com${AUTHORIZE_PATH}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP_CLIENT_ID,
      response_type: "code",
      redirect_uri: "https://qr.home-connect.com/authorize/prod/",
      scope:
        "Control DeleteAppliance IdentifyAppliance Images Monitor ReadAccount ReadOrigApi Settings WriteAppliance WriteOrigApi",
      prompt: "login",
      state: "st",
      nonce: "no",
      code_challenge: challengeOf("v".repeat(43)),
      code_challenge_method: "S256",
    });
    expect(APP_REDIRECT_URI).toBe("https://qr.home-connect.com/authorize/prod/");
    expect(APP_SCOPES).toHaveLength(10);
  });
});

describe("codeFrom — what the user pastes back", () => {
  it("takes the code of the address as a plain parameter", () => {
    expect(codeFrom("https://qr.home-connect.com/authorize/prod/?code=abc&state=x")).toEqual({
      code: "abc",
      form: "parameter",
    });
  });

  it("takes the code handed over in one base64 argument, in either alphabet", () => {
    // base64 of the hand-over carries a "/" here …
    const slash = b64("homeconnect://auth/prod?code=abc123");
    expect(slash).toContain("/");
    expect(codeFrom(`https://qr.home-connect.com/authorize/prod/?${slash}`)).toEqual({
      code: "abc123",
      form: "handedOver",
    });
    expect(codeFrom(`https://qr.home-connect.com/authorize/prod/?${urlSafe(slash)}`)).toEqual({
      code: "abc123",
      form: "handedOver",
    });
    // … and a "+" here, which a parsed query would have turned into a space.
    const plus = b64("homeconnect://auth?code=ab~c");
    expect(plus).toContain("+");
    expect(codeFrom(`https://qr.home-connect.com/authorize/prod/?x=1&${plus}`)).toEqual({
      code: "ab~c",
      form: "handedOver",
    });
    expect(codeFrom(`https://qr.home-connect.com/authorize/prod/?${urlSafe(plus)}`)).toEqual({
      code: "ab~c",
      form: "handedOver",
    });
  });

  it("takes a bare code the user picked out", () => {
    expect(codeFrom("  abcDEF123  ")).toEqual({ code: "abcDEF123", form: "bare" });
  });

  it("refuses what carries no code, saying why", () => {
    expect(codeFrom("")).toEqual({ refused: expect.stringContaining("nothing") });
    expect(codeFrom("   ")).toEqual({ refused: expect.stringContaining("nothing") });
    expect(codeFrom(42)).toEqual({ refused: expect.stringContaining("nothing") });
    expect(codeFrom("https://x/?error=access_denied")).toEqual({ refused: expect.stringContaining("access_denied") });
    expect(codeFrom("https://singlekey-id.com/login?foo=1")).toEqual({
      refused: expect.stringContaining("carries no code"),
    });
  });
});
