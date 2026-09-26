// Master test of the error-text helper — taken unchanged from the fleet master
// (Entwicklung/CLAUDE_CODING.md, section on the error-text helper, workshop b911f1c);
// only the function name and the import path are this adapter's.
import http from "node:http";
import net from "node:net";
import { describe, it, expect } from "vitest";
import { errMessage } from "./pure-helpers";

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = net.createServer().listen(0);
  await new Promise(r => s.once("listening", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise(r => s.close(r));
  return port;
}

/**
 * What a promise rejects with.
 *
 * @param p the promise that must reject
 * @returns the rejection value
 */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("did not reject");
}

describe("errMessage — measured Node errors", () => {
  it("fetch, unknown host: the DNS reason", async () => {
    // `.invalid` never resolves (RFC 6761); a runner without DNS says EAI_AGAIN instead of ENOTFOUND.
    expect(errMessage(await rejection(fetch("http://nonexistent.invalid/")))).toMatch(
      /^fetch failed \(getaddrinfo E[A-Z_]+ nonexistent\.invalid\)$/,
    );
  });
  it("fetch, refused on an address: the socket reason", async () => {
    const port = await closedPort();
    expect(errMessage(await rejection(fetch(`http://127.0.0.1:${port}/`)))).toBe(
      `fetch failed (connect ECONNREFUSED 127.0.0.1:${port})`,
    );
  });
  it("fetch, peer drops the socket: undici's words", async () => {
    const srv = http.createServer(q => q.socket.destroy()).listen(0);
    await new Promise(r => srv.once("listening", r));
    const port = (srv.address() as net.AddressInfo).port;
    const text = errMessage(await rejection(fetch(`http://127.0.0.1:${port}/`)));
    await new Promise(r => srv.close(r));
    expect(text).toBe("fetch failed (other side closed)");
  });
  it("fetch, timeout: the DOMException's own words, no cause", async () => {
    const srv = http.createServer(() => undefined).listen(0);
    await new Promise(r => srv.once("listening", r));
    const port = (srv.address() as net.AddressInfo).port;
    const e = await rejection(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(100) }));
    srv.closeAllConnections();
    await new Promise(r => srv.close(r));
    expect(errMessage(e)).toBe("The operation was aborted due to timeout");
  });
  it("http.get/net.connect to localhost, refused: an empty message says its code", () => {
    // The shape Node 22 rejects with when both ::1 and 127.0.0.1 refuse (built here: whether
    // `localhost` has two addresses depends on the runner's hosts file).
    const e = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
    });
    expect(errMessage(e)).toBe("ECONNREFUSED");
    expect(errMessage(new TypeError("fetch failed", { cause: e }))).toBe("fetch failed (ECONNREFUSED)");
  });
});

describe("errMessage — shapes of a cause", () => {
  it("a string, a plain object, a number", () => {
    expect(errMessage(new Error("x", { cause: "busy" }))).toBe("x (busy)");
    expect(errMessage(new Error("x", { cause: { code: "ECONNRESET" } }))).toBe('x ({"code":"ECONNRESET"})');
    expect(errMessage(new Error("x", { cause: 42 }))).toBe("x (42)");
  });
  it("undefined and null add nothing", () => {
    expect(errMessage(new Error("x", { cause: undefined }))).toBe("x");
    expect(errMessage(new Error("x", { cause: null }))).toBe("x");
  });
  it("one level only: a cause's own cause is not followed, a self-cause does not loop", () => {
    const inner = new Error("inner", { cause: new Error("deepest") });
    expect(errMessage(new Error("outer", { cause: inner }))).toBe("outer (inner)");
    const self = new Error("self");
    self.cause = self;
    expect(errMessage(self)).toBe("self");
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(errMessage(a)).toBe("a (b)");
  });
  it("a wrapper that copies its cause's message says it once", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.x"), {
      code: "ENOTFOUND",
    });
    expect(
      errMessage(
        Object.assign(new Error("getaddrinfo ENOTFOUND api.x", { cause }), {
          code: "ENOTFOUND",
        }),
      ),
    ).toBe("getaddrinfo ENOTFOUND api.x");
  });
  it("an empty cause message without a code adds nothing; an empty message without a code says the name", () => {
    expect(errMessage(new Error("x", { cause: new Error("") }))).toBe("x");
    expect(errMessage(new TypeError(""))).toBe("TypeError");
  });
  it("a cause that is an empty-message AggregateError says its code", () => {
    const agg = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
    });
    expect(errMessage(new TypeError("fetch failed", { cause: agg }))).toBe("fetch failed (ECONNREFUSED)");
  });
});

describe("errMessage — the non-Error branches stay", () => {
  it("renders every thrown value", () => {
    expect(errMessage("s")).toBe("s");
    expect(errMessage(undefined)).toBe("undefined");
    expect(errMessage(null)).toBe("null");
    expect(errMessage(1n)).toBe("1");
    expect(errMessage(Symbol("q"))).toBe("Symbol(q)");
    expect(errMessage({ code: "ECONNRESET" })).toBe('{"code":"ECONNRESET"}');
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(errMessage(cyc)).toBe("[object Object]");
  });
});
describe("errMessage — it never throws and never prints source text", () => {
  it("a thrown function or class renders as its type tag", () => {
    expect(
      errMessage(function secretFn(a: number): number {
        return a + 1;
      }),
    ).toBe("[object Function]");
    expect(errMessage(class Secret {})).toBe("[object Function]");
    expect(errMessage(async () => Promise.resolve())).toBe("[object AsyncFunction]");
  });
  it("a `code` or `cause` getter that throws gives the type tag instead of a second throw", () => {
    const code = new Error("m");
    Object.defineProperty(code, "code", {
      get(): never {
        throw new Error("getter");
      },
    });
    expect(errMessage(code)).toBe("[object Error]");
    const cause = new Error("m");
    Object.defineProperty(cause, "cause", {
      get(): never {
        throw new Error("getter");
      },
    });
    expect(errMessage(cause)).toBe("[object Error]");
  });
  it("a message that is not a string is still text, with and without a cause", () => {
    const withCause = new Error("x", { cause: "busy" });
    Object.defineProperty(withCause, "message", { value: 42 });
    expect(errMessage(withCause)).toBe("42 (busy)");
    const plain = new Error("x");
    Object.defineProperty(plain, "message", { value: 42 });
    expect(errMessage(plain)).toBe("42");
  });
});
