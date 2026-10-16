"use strict";
// Loaded into the adapter process by test/inventory.js as the LAST hook of `adapterEnv()` — in the suites "counterpart
// gone and back", "one counterpart hangs", "chosen network address" and "missing network address" — so its patches sit
// outside every fixture hook.
// 1. It records where the process listens, binds, joins multicast groups, sends and connects: one JSON line per call in
//    RESOURCE_PROBE_DIR/<pid>.net (krobi 2026-10-03 00:27: the chosen address is the only one the adapter uses).
// 2. It plays a power cut of every counterpart: while the file `outage` exists in RESOURCE_PROBE_DIR, every network path
//    of the process fails like an unplugged device — new TCP/TLS connections and `fetch` are refused, open connections
//    drop, incoming connections are dropped, UDP datagrams neither leave nor arrive. Removing the file brings everything
//    back. Each time it goes on it writes `<pid>.outage`, naming any of its patches a later hook replaced.
// 7. It plays a counterpart that answers wrong — section 7 below (`fault`, round 124).
// 8. It notes every address of this machine the adapter names to others — in a datagram, or in what a server of the
//    adapter writes to a connection (SSDP location, an mDNS record, a description) — as an `advertise` line in <pid>.net
//    (round 124, D17, krobi 2026-10-03 00:27: the advertised address is the chosen one).
// The ioBroker databases (ports from the controller's own iobroker.json) are never cut nor recorded: they are the
// platform, not the counterpart.
// Fleet master (.consistency-master/test/network-hook.js) — never edit the copy in an adapter.
const fs = require("node:fs");
const net = require("node:net");
const tls = require("node:tls");
const dgram = require("node:dgram");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { EventEmitter } = require("node:events");

const dir = process.env.RESOURCE_PROBE_DIR;
if (!dir) {
  throw new Error("network hook: RESOURCE_PROBE_DIR is not set — load it through adapterEnv()");
}
const flag = path.join(dir, "outage");
// js-controller reads <root>/iobroker-data/iobroker.json; the harness starts the adapter in <root>/node_modules/<adapter>.
const config = process.env.IOBROKER_DATA_DIR
  ? path.join(process.env.IOBROKER_DATA_DIR, "iobroker.json")
  : path.join(process.cwd(), "..", "..", "iobroker-data", "iobroker.json");
let keep;
try {
  const { objects, states } = JSON.parse(fs.readFileSync(config, "utf8"));
  keep = new Set([Number(objects.port), Number(states.port)]);
} catch (err) {
  throw new Error(`network hook: cannot read the database ports from ${config} (${err.message})`);
}
if (![...keep].every(p => Number.isInteger(p) && p > 0)) {
  throw new Error(`network hook: ${config} names no database ports`);
}

const log = path.join(dir, `${process.pid}.net`);
// A test hook's own server or socket (a fixture served inside the adapter process) is not the adapter's: it is marked
// `hook` when a frame of a test folder is on the stack and no frame of the adapter's own code is — the adapter runs from
// the test installation below the working directory. A request a hook only reroutes keeps the adapter's frame.
const root = process.cwd();
const byHook = () => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 80;
  const stack = new Error().stack || "";
  Error.stackTraceLimit = limit;
  let hook = false;
  for (const line of stack.split("\n").slice(2)) {
    const m = line.match(/\(?((?:file:\/\/)?\/[^():]+):\d+/);
    if (!m || line.includes("node:") || line.includes(__filename)) {
      continue;
    }
    const file = m[1].replace("file://", "");
    const rel = path.relative(root, file);
    if (!rel.startsWith("..") && !rel.startsWith("node_modules") && !/(^|\/)test\//.test(rel)) {
      return false;
    }
    if (/\/test\//.test(file) && !file.includes("/node_modules/")) {
      hook = true;
    }
  }
  return hook;
};
const record = (entry, hook = byHook()) =>
  fs.appendFileSync(log, `${JSON.stringify(hook ? { ...entry, hook } : entry)}\n`);
// 3. It counts every call to a counterpart with its time — each HTTP request, each fetch, each UDP datagram, each raw TCP
//    connection — one JSON line per call in RESOURCE_PROBE_DIR/<pid>.calls, against the limits the adapter declares in
//    src/lib/api-limits.json (round 100, krobi 2026-10-07 10:14: API limits are defined in the adapter and checked).
const calls = path.join(dir, `${process.pid}.calls`);
// The process's pulse (round 124, red-proof run 2026-10-16): a process blocked on a call that never ends writes no
// record after it, so whether it outlived a deadline is read from RESOURCE_PROBE_DIR/<pid>.alive, rewritten every 2 s.
const alive = path.join(dir, `${process.pid}.alive`);
const rawWrite = fs.writeFileSync;
const pulse = () => {
  try {
    rawWrite(alive, String(Date.now()));
  } catch {
    // the probe folder is gone once the run ends
  }
};
pulse();
setInterval(pulse, 2000).unref();
// 5. It names the command behind a call (round 101, krobi 2026-10-07 15:54, GV-13 as the fleet rule: never `ack: true`
//    unless the device confirmed): a state change the adapter gets with `ack: false` runs its listeners inside an async
//    context that carries the state's id, and every call made from there — awaited or not, through promises, timers and
//    sockets created on the way — is counted with `cause`. A call from a loop that started before the command (a queue
//    worker created at the start) carries no cause.
const command = new AsyncLocalStorage();
const emitEvent = EventEmitter.prototype.emit;
function causeEmit(event, ...args) {
  if (event === "stateChange" && typeof args[0] === "string" && args[1] && args[1].ack === false) {
    return command.run(args[0], () => emitEvent.call(this, event, ...args));
  }
  return emitEvent.call(this, event, ...args);
}
EventEmitter.prototype.emit = causeEmit;
let nested = 0;
const count = (kind, host, port, hook = byHook()) => {
  if (nested > 0 || keep.has(Number(port)) || hook) {
    return;
  }
  const cause = command.getStore();
  fs.appendFileSync(
    calls,
    `${JSON.stringify(cause === undefined ? { t: Date.now(), kind, host, port } : { t: Date.now(), kind, host, port, cause })}\n`,
  );
};
// 6. It notes every answer a counterpart sends — data on a connection, a datagram, a fetch response — at most one line
//    per counterpart and second in RESOURCE_PROBE_DIR/<pid>.answers (round 104, krobi 2026-10-03 12:01 for every
//    listener: if the adapter cannot communicate, that is a fatal error — whether the adapter still
//    talks to anything is whether an answer still arrives, not whether it still sends).
const answers = path.join(dir, `${process.pid}.answers`);
const lastAnswer = new Map();
// `local` is the adapter's own port the answer came in on (0 when unknown) — an answer on a port another program took
// is no path of its own (round 104, suite "a taken port")
const answer = (kind, host, port, local = 0) => {
  if (keep.has(Number(port))) {
    return;
  }
  const key = `${kind} ${host} ${port} ${local}`;
  const now = Date.now();
  if (now - (lastAnswer.get(key) ?? 0) < 1000) {
    return;
  }
  lastAnswer.set(key, now);
  fs.appendFileSync(
    answers,
    `${JSON.stringify({ t: now, kind, host, port: Number(port), local: Number(local) || 0 })}\n`,
  );
};
const ids = new WeakMap();
let nextId = 0;
const idOf = socket => {
  if (!ids.has(socket)) {
    ids.set(socket, ++nextId);
  }
  return ids.get(socket);
};
const down = () => fs.existsSync(flag);
// 4. It lets ONE counterpart hang (round 100, krobi 2026-10-07 10:12: one device never blocks another): while the file
//    `hang` in RESOURCE_PROBE_DIR names a host, a connection to it never completes, a fetch to it never settles, a
//    datagram to it is dropped — a device that is there and does not answer, which a refusal would not show. When the
//    adapter gives such an attempt up (closes the socket, aborts the fetch) a `hang-end` line goes into the call log.
//    Round 101: `*` in the file lets EVERY counterpart hang and keeps every answer away — nothing arrives on an open
//    connection either, and no datagram — a command then reaches no device that could confirm it.
const hangFlag = path.join(dir, "hang");
const hangWord = () => (fs.existsSync(hangFlag) ? fs.readFileSync(hangFlag, "utf8").trim() : "");
// Round 104: `<host> <port>` hangs one channel — where every counterpart shares one host (fixtures on 127.0.0.1)
const hung = (host, port) => {
  const word = hangWord();
  if (word === "" || word === "*") {
    return word === "*";
  }
  const [wordHost, wordPort] = word.split(" ");
  return String(host) === wordHost && (wordPort === undefined || Number(port) === Number(wordPort));
};
const silent = () => hangWord() === "*";
let hangNext = false;
// A device that hangs takes the connection and never answers: the hung connection goes to this black hole, opened before
// the listen record below is patched (no record), so the adapter's own timeouts — connect, TLS, request — run as with a
// real device.
let blackHole = 0;
const hole = net.createServer(socket => socket.on("error", () => {}));
hole.listen(0, "127.0.0.1", () => {
  blackHole = hole.address().port;
});
hole.unref();
// Each hung attempt that ends writes `hang-end`; when the last open one of a host has ended, `hang-idle` follows — the
// moment the adapter has given that counterpart up for now (one channel with a short deadline is not giving it up).
const hangOpen = new Map();
// Round 104: the records carry the port too — a hang of one channel (`<host> <port>`) is judged per channel
const hangStart = (host, port) => {
  const key = `${host} ${port}`;
  hangOpen.set(key, (hangOpen.get(key) ?? 0) + 1);
  fs.appendFileSync(calls, `${JSON.stringify({ t: Date.now(), kind: "hang-start", host, port })}\n`);
};
const hangEnd = (host, port) => {
  fs.appendFileSync(calls, `${JSON.stringify({ t: Date.now(), kind: "hang-end", host, port })}\n`);
  const key = `${host} ${port}`;
  const left = (hangOpen.get(key) ?? 1) - 1;
  hangOpen.set(key, left);
  if ([...hangOpen].every(([k, n]) => !k.startsWith(`${host} `) || n === 0)) {
    fs.appendFileSync(calls, `${JSON.stringify({ t: Date.now(), kind: "hang-idle", host })}\n`);
  }
  if (left === 0) {
    fs.appendFileSync(calls, `${JSON.stringify({ t: Date.now(), kind: "hang-idle", host, port })}\n`);
  }
};
// Round 107 (W100-5): the hang can begin while the adapter already talks to the counterpart — an open connection to it
// then goes silent from that moment (`hang-start`) until the adapter closes it (`hang-end`), like a device that answered
// and then stopped. A connection sent to the black hole is silent from its start and has its own records.
const silenced = new WeakSet();
const silenceIfHung = socket => {
  const target = targets.get(socket);
  if (target === undefined || silenced.has(socket) || !open.has(socket) || !hung(target.host, target.port)) {
    return;
  }
  silenced.add(socket);
  hangStart(target.host, target.port);
  socket.once("close", () => hangEnd(target.host, target.port));
};
// 7. It plays a counterpart that answers wrong (round 124, plan P5 — D6: a 500 and an empty 200 delete nothing; D21: a
//    series of 429 makes the adapter back off; C26b: drifted fields crash nothing): while the file `fault` in
//    RESOURCE_PROBE_DIR holds `500`, `429`, `empty` or `drift`, HTTP answers the adapter gets (fetch and http/https) are
//    replaced — that status with an empty body (429 with `retry-after: 60`), an empty 200, or the real answer with its
//    JSON drifted: of every object's keys the first of each three is gone, the second null, the third of another type.
//    A 429 and `500all` (round 125, D21: a series of errors) replace every answer. A 500, an empty 200 and drift replace the first answer to each request (method,
//    host, port, path) of a process under that fault and let the repeat through: a wrong answer to every call stops a login-first adapter
//    at its login, and it never asks for data (homeconnect retried its token for a minute, red-proof run 2026-10-16).
//    Every request of the adapter is noted in RESOURCE_PROBE_DIR/<pid>.requests with the fault it met; the call itself
//    is still counted (`<pid>.calls`); the databases are never touched.
const faultFlag = path.join(dir, "fault");
const faultWord = () => {
  try {
    return fs.readFileSync(faultFlag, "utf8").trim();
  } catch {
    return "";
  }
};
const FAULTS = new Set(["500", "429", "empty", "drift", "500all"]);
const requests = path.join(dir, `${process.pid}.requests`);
const answeredWrong = new Set();
// a long number in a path is a time or a counter, not another request
const requestKey = (method, host, port, pathname) =>
  `${String(method || "GET").toUpperCase()} ${host}:${port}${String(pathname || "/").split("?")[0]}`.replace(
    /\d{6,}/g,
    "#",
  );
// the fault this request meets ("" for none), noted with the request
const faultFor = key => {
  const mode = faultWord();
  let met = "";
  if (mode === "429" || mode === "500all") {
    met = mode;
  } else if (FAULTS.has(mode) && !answeredWrong.has(`${mode} ${key}`)) {
    answeredWrong.add(`${mode} ${key}`);
    met = mode;
  }
  fs.appendFileSync(requests, `${JSON.stringify({ t: Date.now(), key, fault: met })}\n`);
  return met;
};
const drift = value => {
  if (Array.isArray(value)) {
    return value.map(drift);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const out = {};
  Object.keys(value).forEach((key, i) => {
    const v = value[key];
    if (i % 3 === 1) {
      out[key] = null;
    } else if (i % 3 === 2) {
      out[key] =
        typeof v === "number"
          ? String(v)
          : typeof v === "string"
            ? 0
            : typeof v === "boolean"
              ? String(v)
              : v === null
                ? 0
                : drift(v);
    }
  });
  return out;
};
const driftText = text => {
  try {
    return JSON.stringify(drift(JSON.parse(text)));
  } catch {
    return text; // not JSON — it goes on as it came
  }
};
const faultStatus = mode => (mode === "500" || mode === "500all" ? 500 : mode === "429" ? 429 : 200);
const faultHeaders = mode => (mode === "429" ? { "retry-after": "60" } : {});
const refused = () => Object.assign(new Error("connect ECONNREFUSED (outage switch)"), { code: "ECONNREFUSED" });
const reset = () => Object.assign(new Error("read ECONNRESET (outage switch)"), { code: "ECONNRESET" });
const optionsOf = args => {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  return first && typeof first === "object"
    ? first
    : { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
};

// Outgoing TCP and TLS (TLS opens its socket through net): http, MQTT clients, and undici behind fetch.
const open = new Set();
// Round 101: where each connection goes, as connect named it — a command written on it later is counted for that target
const targets = new WeakMap();
const track = (socket, opts) => {
  open.add(socket);
  targets.set(socket, { host: opts.host ?? "localhost", port: Number(opts.port) });
  socket.once("close", () => open.delete(socket));
};
const connect = net.Socket.prototype.connect;
// Round 104: an outgoing raw connection — not one an http client or fetch (undici) opened, whose requests are counted
// where they begin, and not one a server of the adapter accepted (its writes are answers, not calls)
const rawOut = new WeakSet();
const byClient = () => /node:_http_(client|agent)|node:https|node:internal\/deps\/undici/.test(new Error().stack || "");
function cutConnect(...args) {
  // Round 107: the host and port a TLS connection was asked for, before a fixture hook below rerouted it (tls.connect)
  const asked = tlsAsked;
  tlsAsked = null;
  const opts = asked === null ? optionsOf(args) : { ...optionsOf(args), host: asked.host, port: asked.port };
  if (!keep.has(Number(opts.port)) && typeof opts.path !== "string" && !byClient()) {
    rawOut.add(this);
  }
  // an http agent hands its request options on, with `path: null` — only a string path is a local socket
  if (
    !keep.has(Number(opts.port)) &&
    typeof opts.path !== "string" &&
    (hangNext || hung(opts.host ?? "localhost", opts.port))
  ) {
    const host = hangNext || opts.host;
    hangNext = false;
    // an HTTP request to a hung host was counted where it began; a raw connection is counted here
    if (!/node:_http_(client|agent)|node:https/.test(new Error().stack || "")) {
      count("tcp", opts.host ?? "localhost", Number(opts.port));
    }
    const name = typeof host === "string" ? host : opts.host;
    hangStart(name, Number(opts.port));
    this.once("close", () => hangEnd(name, Number(opts.port)));
    track(this, opts);
    silenced.add(this);
    return connect.call(this, { port: blackHole, host: "127.0.0.1" });
  }
  const result = connect.apply(this, args);
  if (keep.has(Number(opts.port))) {
    return result;
  }
  // Round 100: an http agent hands `path: null` on — the record missed every HTTP and TLS connection until then, so
  // "chosen network address" never saw one (krobi 2026-10-03 11:38: the chosen address holds for the cloud too)
  if (typeof opts.path !== "string") {
    if (!/node:_http_(client|agent)|node:https/.test(new Error().stack || "")) {
      count("tcp", opts.host ?? "localhost", Number(opts.port));
    }
    record({
      kind: "connect",
      host: opts.host ?? "localhost",
      port: Number(opts.port),
      localAddress: opts.localAddress,
    });
  }
  track(this, opts);
  if (down()) {
    process.nextTick(() => this.destroy(refused()));
  }
  return result;
}
net.Socket.prototype.connect = cutConnect;
// Round 101: while everything hangs, nothing the counterparts send reaches the adapter on a connection opened before.
const socketEmit = net.Socket.prototype.emit;
function cutSocketEmit(event, ...args) {
  if (event === "data" && open.has(this)) {
    silenceIfHung(this);
  }
  if (event === "data" && open.has(this) && (silent() || (silenced.has(this) && hangWord() !== ""))) {
    return false;
  }
  if (event === "data" && open.has(this)) {
    const target = targets.get(this);
    if (target !== undefined) {
      answer("tcp", target.host, target.port, this.localPort);
    }
  }
  return socketEmit.call(this, event, ...args);
}
net.Socket.prototype.emit = cutSocketEmit;
const socketWrite = net.Socket.prototype.write;
// Round 104 (krobi 2026-10-07 10:14: API limits are defined in the adapter and checked): every
// write on such a connection is a call of kind `tcp-write` — a device protocol on one socket (YNCA, NUT, MQTT) sends its
// commands there, and until now only the connections were counted, so no command limit was ever judged.
function causeWrite(...args) {
  silenceIfHung(this);
  const target = targets.get(this);
  if (target !== undefined && open.has(this) && rawOut.has(this)) {
    count("tcp-write", target.host, target.port);
  }
  return socketWrite.apply(this, args);
}
net.Socket.prototype.write = causeWrite;
// Round 107: TLS started on a connection that is already open (STARTTLS, `tls.connect({ socket })`) — the TLS socket
// writes and reads through the native handle of the one below, so it takes over that one's record: its writes are
// calls, its data is an answer, and it is cut, silenced and hung like it.
// Round 107 (K18): a TLS connection TLS opens itself is recorded with the host the adapter asked for — a fixture hook
// below that reroutes `tls.connect` to a local server would otherwise leave only its own address in the record, and a
// declared counterpart (a broker whose host differs per account) could never be told from any other.
const tlsConnect = tls.connect;
let tlsAsked = null;
let tlsDepth = 0;
function trackTls(...args) {
  const opts = args.find(a => a !== null && typeof a === "object" && !(a instanceof net.Socket)) ?? {};
  if (tlsDepth === 0 && !(opts.socket instanceof net.Socket)) {
    const port = Number(
      opts.port ?? (typeof args[0] === "number" || typeof args[0] === "string" ? args[0] : undefined),
    );
    const host = opts.host ?? (typeof args[1] === "string" ? args[1] : undefined) ?? "localhost";
    tlsAsked = { host, port };
  }
  tlsDepth++;
  let socket;
  try {
    socket = tlsConnect.apply(this, args);
  } finally {
    tlsDepth--;
    if (tlsDepth === 0) {
      tlsAsked = null;
    }
  }
  const inner = args.find(a => a !== null && typeof a === "object" && a.socket instanceof net.Socket)?.socket;
  const target = inner === undefined ? undefined : targets.get(inner);
  if (target !== undefined && socket !== inner) {
    track(socket, target);
    if (rawOut.has(inner)) {
      rawOut.add(socket);
    }
    if (silenced.has(inner)) {
      silenced.add(socket);
    }
  }
  return socket;
}
tls.connect = trackTls;

// HTTP requests: the real host before any fixture hook reroutes it (this hook loads last, the adapter captures these).
for (const mod of [require("node:http"), require("node:https")]) {
  const secure = mod === require("node:https");
  for (const name of ["request", "get"]) {
    const original = mod[name];
    mod[name] = function countRequest(...args) {
      const first = args[0];
      let host;
      let port;
      let method;
      let pathname;
      if (typeof first === "string" || first instanceof URL) {
        const url = new URL(String(first));
        host = url.hostname;
        port = Number(url.port) || (secure ? 443 : 80);
        pathname = url.pathname;
        method = args[1] !== null && typeof args[1] === "object" ? args[1].method : undefined;
      } else if (first && typeof first === "object") {
        host = first.hostname ?? first.host ?? "localhost";
        port = Number(first.port) || (secure ? 443 : 80);
        pathname = first.path ?? first.pathname;
        method = first.method;
      }
      if (host !== undefined) {
        count("http", String(host).replace(/:\d+$/, ""), port);
      }
      // a fixture hook below that calls http.request again is the same call, not a second one
      const outermost = nested === 0;
      nested++;
      if (host !== undefined && hung(String(host).replace(/:\d+$/, ""), port)) {
        hangNext = String(host).replace(/:\d+$/, "");
        // a pooled keep-alive connection would answer it: the hung request opens its own
        const at = typeof args[1] === "object" && args[1] !== null && typeof args[1] !== "function" ? 1 : 0;
        if (at === 0 && (typeof args[0] === "string" || args[0] instanceof URL)) {
          args.splice(1, 0, { agent: false });
        } else {
          args[at] = { ...args[at], agent: false };
        }
      }
      try {
        const req = original.apply(this, args);
        const mode =
          outermost && host !== undefined && !keep.has(Number(port)) && !byHook()
            ? faultFor(requestKey(method, String(host).replace(/:\d+$/, ""), port, pathname))
            : "";
        if (mode) {
          const emit = req.emit;
          req.emit = function faultEmit(event, ...rest) {
            return event === "response"
              ? emit.call(this, event, faultResponse(mode, rest[0]))
              : emit.call(this, event, ...rest);
          };
        }
        return req;
      } finally {
        nested--;
        hangNext = false;
      }
    };
  }
}

// Section 7 for http/https: the response the request emits, replaced — status and headers as the fault says, the body
// empty or the real one drifted (a compressed body goes on as it came: the adapter decodes it itself).
function faultResponse(mode, real) {
  const { PassThrough } = require("node:stream");
  const fake = new PassThrough();
  const headers = { ...real.headers, ...faultHeaders(mode) };
  delete headers["content-length"];
  Object.assign(fake, {
    statusCode: mode === "drift" ? real.statusCode : faultStatus(mode),
    statusMessage: mode === "drift" ? real.statusMessage : "",
    headers,
    rawHeaders: Object.entries(headers).flat().map(String),
    httpVersion: real.httpVersion,
    socket: real.socket,
    req: real.req,
  });
  if (mode !== "drift" || real.headers["content-encoding"]) {
    if (mode !== "drift") {
      real.resume();
      fake.end("");
    } else {
      real.pipe(fake);
    }
    return fake;
  }
  const chunks = [];
  real.on("data", chunk => chunks.push(Buffer.from(chunk)));
  real.on("end", () => fake.end(driftText(Buffer.concat(chunks).toString("utf8"))));
  real.on("error", err => fake.destroy(err));
  return fake;
}

// Listening TCP servers (http, fastify): the address the server really holds, once it listens.
const listen = net.Server.prototype.listen;
// Round 104: the port the adapter ASKED for (0 or none: the system picks one) — a fixed port is a declared one
const askedPort = args => {
  const first = args[0];
  const port = first && typeof first === "object" ? first.port : first;
  return Number(port) || 0;
};
function recordListen(...args) {
  const hook = byHook();
  const asked = askedPort(args);
  this.once("listening", () => {
    const at = this.address();
    if (at && typeof at === "object") {
      record({ kind: "listen", host: at.address, port: at.port, asked }, hook);
    }
  });
  return listen.apply(this, args);
}
net.Server.prototype.listen = recordListen;

// Incoming TCP: a counterpart that connects to a server of the adapter.
const serverEmit = net.Server.prototype.emit;
function cutServerEmit(event, ...args) {
  if (event === "connection" && args[0] instanceof net.Socket) {
    if (down()) {
      args[0].destroy();
      return false;
    }
    track(args[0], { host: args[0].remoteAddress, port: args[0].remotePort });
    // section 8: what a server of the adapter writes to this connection
    const served = args[0];
    const write = served.write;
    served.write = function advertWrite(chunk, ...rest) {
      noteAdvert("tcp", chunk);
      return write.call(this, chunk, ...rest);
    };
  }
  return serverEmit.call(this, event, ...args);
}
net.Server.prototype.emit = cutServerEmit;

// fetch: wrapped at the call, so a fixture hook that assigns globalThis.fetch is cut as well.
let current = globalThis.fetch;
const cutFetch = (...args) => {
  try {
    const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]));
    count("http", url.hostname, Number(url.port) || (url.protocol === "https:" ? 443 : 80));
  } catch {
    // not a URL fetch would accept either — it rejects on its own
  }
  let target;
  let targetPort;
  let targetPath;
  try {
    const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]));
    target = url.hostname;
    targetPort = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    targetPath = url.pathname;
  } catch {
    target = undefined;
  }
  // Round 104 (krobi 2026-10-03 11:38 "everything, cloud too"): a fetch a fixture hook answers opens no socket, so its
  // address is never seen — the record says whether the call could be bound at all: a `dispatcher` of its own (a global
  // one cannot be told from node's default Agent, measured round 104).
  if (target !== undefined && !keep.has(targetPort)) {
    record({ kind: "fetch", host: target, port: targetPort, bound: args[1]?.dispatcher !== undefined });
  }
  if (target !== undefined && hung(target, targetPort)) {
    const signal = args[1]?.signal ?? (args[0] instanceof Request ? args[0].signal : undefined);
    hangStart(target, targetPort);
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        hangEnd(target, targetPort);
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      });
    });
  }
  if (down()) {
    return Promise.reject(new TypeError("fetch failed", { cause: refused() }));
  }
  const mode =
    target !== undefined && !keep.has(targetPort) && !byHook()
      ? faultFor(
          requestKey(
            args[1]?.method ?? (args[0] instanceof Request ? args[0].method : "GET"),
            target,
            targetPort,
            targetPath,
          ),
        )
      : "";
  if (mode) {
    if (mode !== "drift") {
      return Promise.resolve(
        new Response(mode === "empty" ? "" : null, { status: faultStatus(mode), headers: faultHeaders(mode) }),
      );
    }
    return current(...args).then(async response => {
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(driftText(await response.text()), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  }
  return current(...args).then(response => {
    if (target !== undefined) {
      answer("http", target, targetPort);
    }
    return response;
  });
};
function getFetch() {
  return current && cutFetch;
}
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  enumerable: true,
  get: getFetch,
  set(fn) {
    current = fn;
  },
});

// UDP: where each socket binds, which groups it joins on which interface, where its multicast leaves, where it sends.
const bind = dgram.Socket.prototype.bind;
function recordBind(...args) {
  const hook = byHook();
  const asked = askedPort(args);
  this.once("listening", () => {
    const at = this.address();
    record({ kind: "bind", id: idOf(this), address: at.address, port: at.port, asked }, hook);
  });
  return bind.apply(this, args);
}
dgram.Socket.prototype.bind = recordBind;
const addMembership = dgram.Socket.prototype.addMembership;
function recordJoin(group, iface) {
  record({ kind: "join", id: idOf(this), group, iface });
  return addMembership.call(this, group, iface);
}
dgram.Socket.prototype.addMembership = recordJoin;
const setMulticastInterface = dgram.Socket.prototype.setMulticastInterface;
function recordEgress(iface) {
  record({ kind: "egress", id: idOf(this), iface });
  return setMulticastInterface.call(this, iface);
}
dgram.Socket.prototype.setMulticastInterface = recordEgress;
// Section 8: the IPv4 literals of a payload that are an address of this machine, each recorded once per way.
const ownAddresses = new Set(
  Object.values(require("node:os").networkInterfaces())
    .flat()
    .filter(i => i && (i.family === "IPv4" || i.family === 4))
    .map(i => i.address),
);
const advertised = new Set();
const noteAdvert = (via, chunk) => {
  let text;
  if (typeof chunk === "string") {
    text = chunk;
  } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
    text = Buffer.from(chunk).subarray(0, 65536).toString("latin1");
  } else if (Array.isArray(chunk)) {
    text = chunk.map(c => (typeof c === "string" ? c : Buffer.from(c).toString("latin1"))).join("");
  } else {
    return;
  }
  for (const m of text.matchAll(/(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)) {
    const key = `${via} ${m[1]}`;
    if (ownAddresses.has(m[1]) && !advertised.has(key)) {
      advertised.add(key);
      record({ kind: "advertise", via, address: m[1] });
    }
  }
};
const sentTo = new Set();
const hookSockets = new WeakMap();
const send = dgram.Socket.prototype.send;
function cutSend(...args) {
  // send(msg, port, address) or send(msg, offset, length, port, address), as node:dgram reads it — round 101: the first
  // number was taken for the port, so the offset form (govee's LAN client) counted `localhost:0` and never hung
  const portAt = typeof args[1] === "number" && typeof args[2] === "number" ? 3 : 1;
  const at = typeof args[portAt] === "number" ? portAt : -1;
  const target = { port: args[at], host: typeof args[at + 1] === "string" ? args[at + 1] : "localhost" };
  const key = `${idOf(this)} ${target.host}:${target.port}`;
  // an unbound socket binds first and calls send again itself — that second call is the datagram
  let bound = true;
  try {
    this.address();
  } catch {
    bound = false;
  }
  if (at !== -1 && bound) {
    if (!hookSockets.has(this)) {
      hookSockets.set(this, byHook());
    }
    count("udp", target.host, target.port, hookSockets.get(this));
  }
  noteAdvert("udp", args[0]);
  if (at !== -1 && !sentTo.has(key)) {
    sentTo.add(key);
    record({ kind: "send", id: idOf(this), host: target.host, port: target.port });
  }
  if (!down() && !(at !== -1 && hung(target.host, target.port))) {
    return send.apply(this, args);
  }
  const cb = args.find(a => typeof a === "function");
  if (cb) {
    process.nextTick(cb, null, 0);
  }
}
dgram.Socket.prototype.send = cutSend;
const emit = dgram.Socket.prototype.emit;
function cutEmit(event, ...args) {
  if (event === "message" && (down() || silent())) {
    return false;
  }
  // Round 107: a counterpart that hangs sends nothing either — also one that began to hang while the adapter ran
  if (event === "message" && args[1] && typeof args[1].address === "string" && hung(args[1].address, args[1].port)) {
    return false;
  }
  if (event === "message" && args[1] && typeof args[1].address === "string") {
    let local = 0;
    try {
      local = this.address().port;
    } catch {
      // not bound any more
    }
    answer("udp", args[1].address, args[1].port, local);
  }
  return emit.call(this, event, ...args);
}
dgram.Socket.prototype.emit = cutEmit;

// 7. It notes every file the adapter process writes, with its time, in RESOURCE_PROBE_DIR/<pid>.files (round 104, DB-01,
//    krobi 2026-09-14 23:12: a diagnostics export is never stored by the adapter): a report is made
//    and downloaded, never stored — the suite judges every write while the reports are made, wherever it goes.
const filesLog = path.join(dir, `${process.pid}.files`);
const rawAppend = fs.appendFileSync;
const noteFile = target => {
  const file =
    typeof target === "string"
      ? target
      : target instanceof URL
        ? target.pathname
        : Buffer.isBuffer(target)
          ? target.toString()
          : undefined;
  if (file === undefined) {
    return; // a file descriptor: its file was named where it was opened
  }
  const abs = path.resolve(file);
  if (abs === dir || abs.startsWith(dir + path.sep)) {
    return;
  }
  rawAppend(filesLog, `${JSON.stringify({ t: Date.now(), path: abs })}\n`);
};
const targetOf = (name, args) => (/^(rename|copyFile)/.test(name) ? args[1] : args[0]);
for (const name of [
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "createWriteStream",
  "copyFile",
  "copyFileSync",
  "rename",
  "renameSync",
]) {
  const original = fs[name];
  fs[name] = function noteWrite(...args) {
    noteFile(targetOf(name, args));
    return original.apply(this, args);
  };
}
for (const name of ["writeFile", "appendFile", "copyFile", "rename"]) {
  const original = fs.promises[name];
  fs.promises[name] = function noteWrite(...args) {
    noteFile(targetOf(name, args));
    return original.apply(this, args);
  };
}

/** The patches a later hook replaced — each would let a path past the cut or the record. */
function replaced() {
  const out = [];
  if (net.Socket.prototype.connect !== cutConnect) out.push("net.Socket.prototype.connect");
  if (net.Socket.prototype.emit !== cutSocketEmit) out.push("net.Socket.prototype.emit");
  if (net.Socket.prototype.write !== causeWrite) out.push("net.Socket.prototype.write");
  if (tls.connect !== trackTls) out.push("tls.connect");
  if (EventEmitter.prototype.emit !== causeEmit) out.push("EventEmitter.prototype.emit");
  if (net.Server.prototype.listen !== recordListen) out.push("net.Server.prototype.listen");
  if (net.Server.prototype.emit !== cutServerEmit) out.push("net.Server.prototype.emit");
  if (Object.getOwnPropertyDescriptor(globalThis, "fetch")?.get !== getFetch) out.push("globalThis.fetch");
  if (dgram.Socket.prototype.bind !== recordBind) out.push("dgram.Socket.prototype.bind");
  if (dgram.Socket.prototype.addMembership !== recordJoin) out.push("dgram.Socket.prototype.addMembership");
  if (dgram.Socket.prototype.setMulticastInterface !== recordEgress)
    out.push("dgram.Socket.prototype.setMulticastInterface");
  if (dgram.Socket.prototype.send !== cutSend) out.push("dgram.Socket.prototype.send");
  if (dgram.Socket.prototype.emit !== cutEmit) out.push("dgram.Socket.prototype.emit");
  return out;
}

// The moment the switch goes on, open connections drop and the marker is written.
let was = down();
setInterval(() => {
  if (hangWord() !== "") {
    for (const socket of open) {
      silenceIfHung(socket);
    }
  }
  const now = down();
  if (now && !was) {
    for (const socket of open) {
      socket.destroy(reset());
    }
    fs.writeFileSync(path.join(dir, `${process.pid}.outage`), JSON.stringify({ replaced: replaced() }));
  }
  was = now;
}, 100).unref();
