import { describe, it, expect, vi, afterEach } from "vitest";
import { postForm, getJson, putJson, deleteJson, retryAfterMs } from "./http";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("retryAfterMs", () => {
  it("parses a whole-second Retry-After into ms", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs(" 60 ")).toBe(60_000);
  });
  it("returns undefined for missing or non-numeric values", () => {
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("")).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
    expect(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
  });
});

describe("getJson 429", () => {
  it("surfaces the Retry-After window in ms on a 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { key: "429.Rate.Limit" } }), {
          status: 429,
          headers: { "retry-after": "42" },
        }),
      ),
    );
    const res = await getJson("https://api.home-connect.com", "/x", "T");
    expect(res).toMatchObject({ status: 429, ok: false, retryAfterMs: 42_000 });
  });

  it("carries Home Connect's description — on a 429 the only place that names the limit", async () => {
    // The body of a real 429 (ioBroker.homeconnect #327, 2025-10-23).
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            '{"error":{"description":"The rate limit \\"50 calls in 1 minute\\" was reached. Requests are blocked during the remaining period of 54 seconds.","key":"429"}}',
            { status: 429, headers: { "retry-after": "54" } },
          ),
        ),
    );
    const res = await getJson("https://api.home-connect.com", "/x", "T");
    expect(res).toMatchObject({
      status: 429,
      error: "429",
      description:
        'The rate limit "50 calls in 1 minute" was reached. Requests are blocked during the remaining period of 54 seconds.',
    });
  });

  it("leaves retryAfterMs undefined on a non-429 failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { key: "x" } }), { status: 409 })),
    );
    const res = await getJson("https://api.home-connect.com", "/x", "T");
    expect(res.retryAfterMs).toBeUndefined();
  });
});

describe("postForm", () => {
  it("sends a url-encoded body to the resolved URL and parses the JSON response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ access_token: "x" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await postForm("https://api.home-connect.com", "/security/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: "RT",
    });

    expect(res).toEqual({ status: 200, ok: true, body: { access_token: "x" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.home-connect.com/security/oauth/token");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("grant_type=refresh_token&refresh_token=RT");
    expect(init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("maps a network error / timeout to a non-ok result with status 0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const res = await postForm("https://api.home-connect.com", "/x", {});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.body).toMatchObject({ error_description: "boom" });
  });

  it("names the cause when fetch rejects with a plain object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue({ code: "ECONNRESET" }));
    const res = await postForm("https://api.home-connect.com", "/x", {});
    // undici rejects with an Error carrying a `cause` object, and a proxy layer
    // with a bare object — "[object Object]" in the sign-in log names neither
    // the cause nor the place.
    expect(res.body).toMatchObject({ error_description: '{"code":"ECONNRESET"}' });
  });

  it("returns a non-ok result carrying the HTTP status for a 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );
    const res = await postForm("https://api.home-connect.com", "/x", {});
    expect(res).toEqual({ status: 400, ok: false, body: { error: "invalid_grant" } });
  });

  it("returns a null body for an empty or non-JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    expect((await postForm("https://api.home-connect.com", "/x", {})).body).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>nope</html>", { status: 200 })));
    expect((await postForm("https://api.home-connect.com", "/x", {})).body).toBeNull();
  });
});

describe("getJson", () => {
  it("unwraps the data envelope and sends the bearer + accept headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: { homeappliances: [{ haId: "X" }] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await getJson("https://api.home-connect.com", "/api/homeappliances", "TOKEN", "de-DE");

    expect(res).toEqual({ status: 200, ok: true, data: { homeappliances: [{ haId: "X" }] }, error: undefined });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.home-connect.com/api/homeappliances");
    expect(init.headers.authorization).toBe("Bearer TOKEN");
    expect(init.headers.accept).toBe("application/vnd.bsh.sdk.v1+json");
    expect(init.headers["accept-language"]).toBe("de-DE");
  });

  it("surfaces the BSH error key on a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { key: "SDK.Error.UnsupportedProgram" } }), { status: 409 }),
        ),
    );
    const res = await getJson("https://api.home-connect.com", "/x", "T");
    expect(res).toMatchObject({ status: 409, ok: false, data: undefined, error: "SDK.Error.UnsupportedProgram" });
  });

  it("maps a network error to status 0, naming the cause", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const res = await getJson("https://api.home-connect.com", "/x", "T");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toBe("network_error: down");
  });

  it("names the cause when fetch rejects with a plain object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue({ code: "ECONNRESET" }));
    // The REST log line carries this text verbatim; "[object Object]" there
    // leaves the user with a failure and no reason.
    expect((await getJson("https://api.home-connect.com", "/x", "T")).error).toBe(
      'network_error: {"code":"ECONNRESET"}',
    );
  });

  it("names the reason Node's fetch hides in the cause", async () => {
    // The shape Node's fetch rejects every connection failure with (a timeout excepted) — the plain-object
    // test above never reached it: the log said "fetch failed" and nothing else.
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.home-connect.com"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed", { cause })));
    expect((await getJson("https://api.home-connect.com", "/x", "T")).error).toBe(
      "network_error: fetch failed (getaddrinfo ENOTFOUND api.home-connect.com)",
    );
  });
});

describe("putJson", () => {
  it("wraps the value in a data envelope with the bsh content-type + bearer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await putJson(
      "https://api.home-connect.com",
      "/api/homeappliances/X/settings/BSH.Common.Setting.PowerState",
      "T",
      {
        key: "BSH.Common.Setting.PowerState",
        value: "BSH.Common.EnumType.PowerState.On",
      },
    );

    expect(res).toMatchObject({ status: 204, ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.home-connect.com/api/homeappliances/X/settings/BSH.Common.Setting.PowerState",
    );
    expect(init.method).toBe("PUT");
    expect(init.headers.authorization).toBe("Bearer T");
    expect(init.headers["content-type"]).toBe("application/vnd.bsh.sdk.v1+json");
    expect(JSON.parse(init.body)).toEqual({
      data: { key: "BSH.Common.Setting.PowerState", value: "BSH.Common.EnumType.PowerState.On" },
    });
  });

  it("surfaces the BSH error key on a 409 conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { key: "BSH.Common.Error.WrongOperationState" } }), { status: 409 }),
        ),
    );
    const res = await putJson("https://api.home-connect.com", "/x", "T", { key: "k", value: 1 });
    expect(res).toMatchObject({ status: 409, ok: false, error: "BSH.Common.Error.WrongOperationState" });
  });

  it("maps a network error to status 0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const res = await putJson("https://api.home-connect.com", "/x", "T", { key: "k" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
  });
});

describe("deleteJson", () => {
  it("sends a DELETE with the bearer and treats 204 as ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await deleteJson("https://api.home-connect.com", "/api/homeappliances/X/programs/active", "T");

    expect(res).toMatchObject({ status: 204, ok: true });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(init.headers.authorization).toBe("Bearer T");
  });

  it("surfaces the BSH error key when there is no active program", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { key: "BSH.Common.Error.NoProgramActive" } }), { status: 404 }),
        ),
    );
    const res = await deleteJson("https://api.home-connect.com", "/x", "T");
    expect(res).toMatchObject({ status: 404, ok: false, error: "BSH.Common.Error.NoProgramActive" });
  });
});

describe("retryAfterMs", () => {
  it("reads the header Home Connect sends (whole seconds)", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs(" 30 ")).toBe(30_000);
  });

  it("returns nothing for a missing or non-numeric header", () => {
    // The 10/s burst limit answers WITHOUT the header, and the HTTP date form is
    // legal too — both must fall through to the caller's own floor rather than
    // producing NaN, which would compare false and disable the pause entirely.
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("")).toBeUndefined();
    expect(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined();
    expect(retryAfterMs("1.5")).toBeUndefined();
    expect(retryAfterMs("-5")).toBeUndefined();
  });
});

describe("requestJson envelope handling", () => {
  it("prefers the BSH error key over the bare status", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { key: "BSH.Common.Error.WrongOperationState" } }), { status: 409 }),
        ),
    );
    const r = await getJson("https://api", "/x", "T");
    // "status 409" tells the user nothing; the BSH key names the actual reason.
    expect(r.error).toBe("BSH.Common.Error.WrongOperationState");
    expect(r.data).toBeUndefined();
  });

  it("falls back to the status when the error body has no usable key", async () => {
    const bodies = ["{}", JSON.stringify({ error: null }), JSON.stringify({ error: { key: 7 } }), "not json"];
    for (const text of bodies) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(text, { status: 500 })));
      expect((await getJson("https://api", "/x", "T")).error).toBe("status 500");
    }
  });

  it("reads Retry-After only on a 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 503, headers: { "retry-after": "30" } })),
    );
    // The rate-limit pause belongs to 429 alone — arming it on a 503 would stop
    // all traffic for a minute over a single hiccup.
    expect((await getJson("https://api", "/x", "T")).retryAfterMs).toBeUndefined();
  });
});

describe("response body cap", () => {
  const big = (bytes: number): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(1024 * 1024).fill(120); // 1 MiB of "x"
        for (let sent = 0; sent < bytes; sent += chunk.byteLength) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

  it("refuses a streamed body beyond the cap instead of buffering it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(big(6 * 1024 * 1024), { status: 200 })));
    const res = await getJson("https://api.home-connect.com", "/x", "T");
    // A compromised endpoint or a broken proxy streaming megabytes must end in a
    // failed call, not in the adapter process growing until the host kills it.
    expect(res).toMatchObject({ ok: false, error: "response too large", data: undefined });
  });

  it("refuses a body whose declared length is already beyond the cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("{}", { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } }),
        ),
    );
    const res = await getJson("https://api.home-connect.com", "/x", "T");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("response too large");
  });

  it("reads a normal streamed body in full", async () => {
    const text = JSON.stringify({ data: { list: "y".repeat(100_000) } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(text, { status: 200 })));
    const res = await getJson("https://api.home-connect.com", "/x", "T");
    expect(res.ok).toBe(true);
    expect((res.data as { list: string }).list).toHaveLength(100_000);
  });

  it("applies the cap to the OAuth transport as well", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(big(6 * 1024 * 1024), { status: 200 })));
    const res = await postForm("https://api.home-connect.com", "/security/oauth/token", {});
    expect(res).toEqual({ status: 0, ok: false, body: { error: "response_too_large" } });
  });
});

describe("a body that breaks off after the headers", () => {
  // fetch resolves as soon as the headers arrive; a socket reset or the request
  // timeout while the body streams in rejects the READ, not the fetch. That must
  // end as a transport failure (status 0) like any other — a rejection travelled
  // up through the appliance sync and ended the whole start-up chain.
  const broken = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        controller.error(new TypeError("terminated"));
      },
    });

  it("maps a broken GET body to status 0 instead of rejecting", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(broken(), { status: 200 })));
    const res = await getJson("https://api.home-connect.com", "/x", "T");
    expect(res).toMatchObject({ status: 0, ok: false, data: undefined });
    expect(res.error).toContain("terminated");
  });

  it("maps a broken PUT body to status 0 instead of rejecting", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(broken(), { status: 409 })));
    const res = await putJson("https://api.home-connect.com", "/x", "T", { key: "k", value: 1 });
    expect(res).toMatchObject({ status: 0, ok: false });
  });

  it("maps a broken OAuth body to status 0 instead of rejecting", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(broken(), { status: 200 })));
    const res = await postForm("https://api.home-connect.com", "/security/oauth/token", {});
    expect(res.status).toBe(0);
    expect(res.ok).toBe(false);
    expect((res.body as { error?: string }).error).toBe("network_error");
  });
});
