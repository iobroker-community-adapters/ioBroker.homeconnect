// Fleet master — the release run requires this file byte for byte in every adapter; change it in
// Entwicklung/.consistency-master, never in an adapter.
import http from "node:http";
import net from "node:net";
import { errText } from "./err-text";

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const s = net.createServer().listen(0);
  await new Promise(r => s.once("listening", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise(r => s.close(r));
  return port;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("did not reject");
}

describe("errText — measured Node errors", () => {
  it("fetch, unknown host: the DNS reason", async () => {
    // `.invalid` never resolves (RFC 6761); a runner without DNS says EAI_AGAIN instead of ENOTFOUND.
    expect(errText(await rejection(fetch("http://nonexistent.invalid/")))).toMatch(
      /^fetch failed \(getaddrinfo E[A-Z_]+ nonexistent\.invalid\)$/,
    );
  });
  it("fetch, refused on an address: the socket reason", async () => {
    const port = await closedPort();
    expect(errText(await rejection(fetch(`http://127.0.0.1:${port}/`)))).toBe(
      `fetch failed (connect ECONNREFUSED 127.0.0.1:${port})`,
    );
  });
  it("fetch, peer drops the socket: undici's words", async () => {
    const srv = http.createServer(q => q.socket.destroy()).listen(0);
    await new Promise(r => srv.once("listening", r));
    const port = (srv.address() as net.AddressInfo).port;
    const text = errText(await rejection(fetch(`http://127.0.0.1:${port}/`)));
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
    expect(errText(e)).toBe("The operation was aborted due to timeout");
  });
  it("http.get/net.connect to localhost, refused: an empty message says its code", () => {
    // The shape Node 22 rejects with when both ::1 and 127.0.0.1 refuse (built here: whether
    // `localhost` has two addresses depends on the runner's hosts file).
    const e = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
    });
    expect(errText(e)).toBe("ECONNREFUSED");
    expect(errText(new TypeError("fetch failed", { cause: e }))).toBe("fetch failed (ECONNREFUSED)");
  });
});

describe("errText — shapes of a cause", () => {
  it("a string, a plain object, a number", () => {
    expect(errText(new Error("x", { cause: "busy" }))).toBe("x (busy)");
    expect(errText(new Error("x", { cause: { code: "ECONNRESET" } }))).toBe('x ({"code":"ECONNRESET"})');
    expect(errText(new Error("x", { cause: 42 }))).toBe("x (42)");
  });
  it("undefined and null add nothing", () => {
    expect(errText(new Error("x", { cause: undefined }))).toBe("x");
    expect(errText(new Error("x", { cause: null }))).toBe("x");
  });
  it("one level only: a cause's own cause is not followed, a self-cause does not loop", () => {
    const inner = new Error("inner", { cause: new Error("deepest") });
    expect(errText(new Error("outer", { cause: inner }))).toBe("outer (inner)");
    const self = new Error("self");
    self.cause = self;
    expect(errText(self)).toBe("self");
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(errText(a)).toBe("a (b)");
  });
  it("a wrapper that copies its cause's message says it once", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.x"), {
      code: "ENOTFOUND",
    });
    expect(
      errText(
        Object.assign(new Error("getaddrinfo ENOTFOUND api.x", { cause }), {
          code: "ENOTFOUND",
        }),
      ),
    ).toBe("getaddrinfo ENOTFOUND api.x");
  });
  it("an empty cause message without a code adds nothing; an empty message without a code says the name", () => {
    expect(errText(new Error("x", { cause: new Error("") }))).toBe("x");
    expect(errText(new TypeError(""))).toBe("TypeError");
  });
  it("a cause with an empty message says its code only when the code is text", () => {
    expect(errText(new Error("x", { cause: Object.assign(new Error(""), { code: "ENOTFOUND" }) }))).toBe(
      "x (ENOTFOUND)",
    );
    expect(errText(new Error("x", { cause: Object.assign(new Error(""), { code: 42 }) }))).toBe("x");
  });
  it("a cause whose message is not text falls back to its code, else adds nothing", () => {
    const coded = Object.assign(new Error("y"), { code: "ECONNRESET" });
    Object.defineProperty(coded, "message", { value: 42 });
    expect(errText(new Error("x", { cause: coded }))).toBe("x (ECONNRESET)");
    const bare = new Error("y");
    Object.defineProperty(bare, "message", { value: 42 });
    expect(errText(new Error("x", { cause: bare }))).toBe("x");
  });
  it("a cause that is an empty-message AggregateError says its code", () => {
    const agg = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
    });
    expect(errText(new TypeError("fetch failed", { cause: agg }))).toBe("fetch failed (ECONNREFUSED)");
  });
});

describe("errText — the non-Error branches stay", () => {
  it("renders every thrown value", () => {
    expect(errText("s")).toBe("s");
    expect(errText(undefined)).toBe("undefined");
    expect(errText(null)).toBe("null");
    expect(errText(1n)).toBe("1");
    expect(errText(Symbol("q"))).toBe("Symbol(q)");
    expect(errText({ code: "ECONNRESET" })).toBe('{"code":"ECONNRESET"}');
    expect(errText({ toJSON: () => undefined })).toBe("[object Object]");
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(errText(cyc)).toBe("[object Object]");
  });
});
describe("errText — it never throws and never prints source text", () => {
  it("a thrown function or class renders as its type tag", () => {
    expect(
      errText(function secretFn(a: number): number {
        return a + 1;
      }),
    ).toBe("[object Function]");
    expect(errText(class Secret {})).toBe("[object Function]");
    expect(errText(async () => Promise.resolve())).toBe("[object AsyncFunction]");
  });
  it("a `code` or `cause` getter that throws gives the type tag instead of a second throw", () => {
    const code = new Error("m");
    Object.defineProperty(code, "code", {
      get(): never {
        throw new Error("getter");
      },
    });
    expect(errText(code)).toBe("[object Error]");
    const cause = new Error("m");
    Object.defineProperty(cause, "cause", {
      get(): never {
        throw new Error("getter");
      },
    });
    expect(errText(cause)).toBe("[object Error]");
  });
  it("a message that is not a string is still text, with and without a cause", () => {
    const withCause = new Error("x", { cause: "busy" });
    Object.defineProperty(withCause, "message", { value: 42 });
    expect(errText(withCause)).toBe("42 (busy)");
    const plain = new Error("x");
    Object.defineProperty(plain, "message", { value: 42 });
    expect(errText(plain)).toBe("42");
  });
});
