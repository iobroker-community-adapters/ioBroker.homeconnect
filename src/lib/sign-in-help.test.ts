import { describe, it, expect } from "vitest";
import { looksLikeClientId, parseRefusal, refusalText, signInHint, signInProblem } from "./sign-in-help";

describe("signInProblem", () => {
  it("tells the three unauthorized_client cases apart by Home Connect's own words", () => {
    expect(signInProblem("unauthorized_client", "Invalid client id")).toBe("clientId");
    expect(
      signInProblem("unauthorized_client", "request rejected by client authorization authority (developer portal)"),
    ).toBe("notActive");
    expect(signInProblem("unauthorized_client", "client not authorized for this oauth flow (grant_type)")).toBe(
      "wrongFlow",
    );
    // Without words the likeliest cause after a new registration: not active yet.
    expect(signInProblem("unauthorized_client", undefined)).toBe("notActive");
  });

  it("sorts the other codes", () => {
    expect(signInProblem("invalid_client", "client secret validation failed")).toBe("clientSecret");
    expect(signInProblem("access_denied", undefined)).toBe("account");
    expect(signInProblem("expired_token", undefined)).toBe("codeExpired");
    expect(signInProblem("invalid_grant", "invalid refresh_token")).toBe("loginRevoked");
    expect(signInProblem("invalid_scope", undefined)).toBe("scope");
    expect(signInProblem(undefined, undefined)).toBe("other");
    expect(signInProblem("server_error", "boom")).toBe("other");
  });
});

describe("signInHint", () => {
  it("names the step that fixes it", () => {
    expect(signInHint("unauthorized_client", "client not authorized for this oauth flow (grant_type)")).toContain(
      "'Device Flow'",
    );
    expect(signInHint("unauthorized_client", "request rejected by client authorization authority")).toContain(
      "15 to 60 minutes",
    );
  });
});

describe("refusalText / parseRefusal", () => {
  it("writes code and words, and reads them back", () => {
    const text = refusalText("unauthorized_client", "Invalid client id");
    expect(text).toBe("unauthorized_client: Invalid client id");
    expect(parseRefusal(text!)).toEqual({ code: "unauthorized_client", description: "Invalid client id" });
  });

  it("works with either half alone", () => {
    expect(refusalText("invalid_client", undefined)).toBe("invalid_client");
    expect(parseRefusal("invalid_client")).toEqual({ code: "invalid_client", description: undefined });
    expect(refusalText(undefined, "Something odd")).toBe("Something odd");
    expect(parseRefusal("Something odd")).toEqual({ description: "Something odd" });
    expect(refusalText(undefined, undefined)).toBeUndefined();
    expect(parseRefusal("")).toEqual({ description: undefined });
  });
});

describe("looksLikeClientId", () => {
  it("is 64 hexadecimal characters, either case", () => {
    expect(looksLikeClientId("A".repeat(64))).toBe(true);
    expect(looksLikeClientId("0123456789abcdef".repeat(4))).toBe(true);
    expect(looksLikeClientId("A".repeat(63))).toBe(false);
    expect(looksLikeClientId("G".repeat(64))).toBe(false);
    expect(looksLikeClientId("")).toBe(false);
  });
});
