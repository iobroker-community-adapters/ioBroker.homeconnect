"use strict";
// Loaded into the adapter process by test/inventory.js (`adapterEnv()`, first `--require`). It only observes: when the
// process exits, it records every timer, server and socket the adapter or one of its own dependencies left open after
// onUnload. js-controller (with everything it loads) and a test hook are not the adapter's and are left out.
// A start marker is written at load: a process that never reaches its exit (killed, crashed) has no report.
// Round 125 (fleet suites D10, D4 — every start loads this file, an adapter without a counterpart too): it notes every state
// id a write handed to the adapter's stateChange (<pid>.delivered, once per id) and every write of the adapter after it
// called its unload callback (<pid>.unload) — js-controller closes the databases after the callback, such a write is
// lost; js-controller's own last writes go through its internal client and are not counted.
// Fleet master (.consistency-master/test/resource-probe.js) — never edit the copy in an adapter.
const fs = require("node:fs");
const net = require("node:net");
const dgram = require("node:dgram");
const path = require("node:path");
const asyncHooks = require("node:async_hooks");
const { EventEmitter } = require("node:events");

const dir = process.env.RESOURCE_PROBE_DIR;
if (dir) {
  fs.writeFileSync(path.join(dir, `${process.pid}.start`), "");
  const delivered = path.join(dir, `${process.pid}.delivered`);
  const deliveredIds = new Set();
  const unloadLog = path.join(dir, `${process.pid}.unload`);
  const ADAPTER_WRITES = [
    "setState",
    "setStateAsync",
    "setForeignState",
    "setForeignStateAsync",
    "setStateChanged",
    "setStateChangedAsync",
    "setForeignStateChanged",
    "setForeignStateChangedAsync",
    "setObject",
    "setObjectAsync",
    "setObjectNotExists",
    "setObjectNotExistsAsync",
    "setForeignObject",
    "setForeignObjectAsync",
    "extendObject",
    "extendObjectAsync",
    "extendForeignObject",
    "extendForeignObjectAsync",
    "delObject",
    "delObjectAsync",
    "delForeignObject",
    "delForeignObjectAsync",
    "delState",
    "delStateAsync",
  ];
  const watchUnload = (adapter, callback) => {
    let done = 0;
    for (const name of ADAPTER_WRITES) {
      const original = adapter[name];
      if (typeof original !== "function") {
        continue;
      }
      adapter[name] = function afterUnload(...args) {
        if (done) {
          fs.appendFileSync(
            unloadLog,
            `${JSON.stringify({ t: Date.now(), kind: "write", via: name, id: typeof args[0] === "string" ? args[0] : "" })}\n`,
          );
        }
        return original.apply(this, args);
      };
    }
    return function unloadCallback(...rest) {
      if (!done) {
        done = Date.now();
        fs.appendFileSync(unloadLog, `${JSON.stringify({ t: done, kind: "callback" })}\n`);
      }
      return callback.apply(this, rest);
    };
  };
  const probeEmit = EventEmitter.prototype.emit;
  EventEmitter.prototype.emit = function handOverEmit(event, ...args) {
    if (event === "stateChange" && typeof args[0] === "string" && args[1] && args[1].ack === false) {
      if (!deliveredIds.has(args[0])) {
        deliveredIds.add(args[0]);
        fs.appendFileSync(delivered, `${JSON.stringify({ t: Date.now(), id: args[0] })}\n`);
      }
    } else if (event === "unload" && typeof args[0] === "function") {
      args[0] = watchUnload(this, args[0]);
    }
    return probeEmit.call(this, event, ...args);
  };
  const root = process.cwd();
  let own = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    own = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies });
  } catch {
    // no package.json: no dependency is the adapter's
  }
  const packageOf = file => {
    const m = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g);
    return m ? m[m.length - 1].slice("node_modules/".length, -1) : undefined;
  };
  const owner = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 60;
    const stack = new Error().stack || "";
    Error.stackTraceLimit = limit;
    const files = [];
    for (const line of stack.split("\n").slice(2)) {
      const m = line.match(/\(?((?:file:\/\/)?\/[^():]+):\d+/);
      if (m && !line.includes("node:") && !line.includes(__filename)) {
        files.push(m[1].replace("file://", ""));
      }
    }
    // the first frame outside any node_modules is the code that asked for the resource — the managed timers
    // (this.setTimeout) are created inside js-controller, their owner is the adapter line that called them. The
    // adapter itself runs from a node_modules folder of the test installation: its own files are those below `root`.
    const where = f => {
      const rel = path.relative(root, f);
      if (!rel.startsWith("..") && !rel.startsWith("node_modules")) {
        return /(^|\/)test\//.test(rel) ? "test" : `adapter ${rel}`;
      }
      if (!f.includes("/node_modules/")) {
        return /\/test\//.test(f) ? "test" : "foreign";
      }
      return undefined;
    };
    const first = files.map(where).find(Boolean);
    if (first) {
      return first;
    }
    // only library frames: the adapter's when one of them is a package the adapter depends on itself
    const pkg = files.map(packageOf).find(p => p && own.includes(p));
    return pkg ? `library ${pkg}` : "foreign";
  };
  const timers = new Map();
  asyncHooks
    .createHook({
      init(id, type, _trigger, resource) {
        if (type === "Timeout" || type === "Immediate") {
          timers.set(id, { type, owner: owner(), ref: new WeakRef(resource) });
        }
      },
      destroy(id) {
        timers.delete(id);
      },
    })
    .enable();
  // Round 113: where every outgoing TCP connection really goes. The probe loads first, so its connect is the innermost
  // one — it sees the address a fixture hook rerouted to, not the one the adapter asked for. A connection that leaves
  // this machine reached the real world: a forgotten route to a cloud, a device on the LAN (yamaha lab run 2026-10-14:
  // the router at 10.47.4.1 answered a discovery while the fixtures were missing).
  const LOOPBACK = /^(?:127\.|::1$|::ffff:127\.|localhost$)/;
  const leftMachine = args => {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const o =
      first && typeof first === "object"
        ? first
        : { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
    if (typeof o.path === "string" || o.port === undefined || o.port === null) {
      return;
    }
    const host = String(o.host ?? "localhost");
    if (!LOOPBACK.test(host)) {
      land("tcp", host, Number(o.port));
    }
  };
  const land = (kind, host, port) =>
    fs.appendFileSync(
      path.join(dir, `${process.pid}.lands`),
      `${JSON.stringify({ t: Date.now(), kind, host, port })}\n`,
    );
  // a unicast datagram leaves this machine as well (a LAN protocol on UDP alone, govee's); a multicast or broadcast
  // search does on purpose and is not judged
  const broadcasts = new Set(["255.255.255.255"]);
  for (const list of Object.values(require("node:os").networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && a.netmask) {
        const n = s => s.split(".").reduce((v, b) => v * 256 + Number(b), 0);
        const b = (n(a.address) | (~n(a.netmask) >>> 0)) >>> 0;
        broadcasts.add([24, 16, 8, 0].map(s => (b >>> s) & 255).join("."));
      }
    }
  }
  const sendDatagram = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (...args) {
    // send(msg, port, address) or send(msg, offset, length, port, address); an unbound socket binds and sends again
    const portAt = typeof args[1] === "number" && typeof args[2] === "number" ? 3 : 1;
    const host =
      typeof args[portAt] === "number" && typeof args[portAt + 1] === "string" ? args[portAt + 1] : undefined;
    let bound = true;
    try {
      this.address();
    } catch {
      bound = false;
    }
    if (
      bound &&
      host !== undefined &&
      !LOOPBACK.test(host) &&
      !/^(?:22[4-9]|23\d)\.|^ff/i.test(host) &&
      !broadcasts.has(host)
    ) {
      land("udp", host, args[portAt]);
    }
    return sendDatagram.apply(this, args);
  };
  // a server or socket gets its handle in an internal nextTick — its owner is whoever calls listen/connect/bind
  const OWNER = Symbol("resourceProbeOwner");
  for (const [proto, method] of [
    [net.Server.prototype, "listen"],
    [net.Socket.prototype, "connect"],
    [dgram.Socket.prototype, "bind"],
  ]) {
    const original = proto[method];
    proto[method] = function (...args) {
      if (!this[OWNER]) {
        this[OWNER] = owner();
      }
      if (method === "connect") {
        leftMachine(args);
      }
      return original.apply(this, args);
    };
  }
  // every state the adapter reads back from its own namespace, with the time: the test then asks which reads fell into
  // its quiet window (window.json) — one pipelined chunk carries many RESP commands, each one is counted
  const stateKey = `io.${String(process.env.RESOURCE_PROBE_NS || "")}`;
  const reads = new Map();
  const write = net.Socket.prototype.write;
  net.Socket.prototype.write = function (chunk, ...args) {
    if (this.remotePort && stateKey.length > 3) {
      const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("latin1") : "";
      const command = /\*(\d+)\r\n\$\d+\r\n(GET|MGET|get|mget)\r\n/g;
      let m;
      while ((m = command.exec(text))) {
        const keys = /\$\d+\r\n([^\r]*)\r\n/y;
        keys.lastIndex = command.lastIndex;
        for (let i = 1; i < Number(m[1]); i++) {
          const k = keys.exec(text);
          if (!k) {
            break;
          }
          if (k[1].startsWith(stateKey)) {
            const id = k[1].slice(3);
            let times = reads.get(id);
            if (!times) {
              reads.set(id, (times = []));
            }
            times.push(Date.now());
          }
        }
      }
    }
    return write.call(this, chunk, ...args);
  };
  // Round 77: the single reads the ADAPTER asks for — getState/getForeignState, and setStateChanged/
  // setForeignStateChanged, which read the state before they write (js-controller 7.2.2 _setStateChangedHelper), also
  // through their …Async forms (promisify in js-controller-common-db, 7.2.2). A read js-controller makes for itself —
  // extendObject or setObjectNotExists read a state to set its `def` — runs through js-controller-adapter frames and does
  // not count. A bulk read
  // (getStatesAsync) is no single read.
  const singleReads = new Map();
  const Module = require("node:module");
  const load = Module._load;
  const WRAPPED = Symbol("resourceProbeWrapped");
  const askedByAdapter = () => {
    const stack = new Error().stack || "";
    for (const line of stack.split("\n").slice(3)) {
      const m = line.match(/\(?((?:file:\/\/)?\/[^():]+):\d+/);
      if (!m || line.includes("node:") || /\/@iobroker\/js-controller-common(-db)?\//.test(m[1])) {
        continue;
      }
      return !m[1].includes("/@iobroker/js-controller-adapter/");
    }
    return false;
  };
  Module._load = function (...args) {
    const exported = load.apply(this, args);
    const cls = exported && typeof exported === "object" ? exported.AdapterClass : undefined;
    if (typeof cls === "function" && !cls.prototype[WRAPPED]) {
      cls.prototype[WRAPPED] = true;
      for (const [method, foreign] of [
        ["getState", false],
        ["getForeignState", true],
        ["setStateChanged", false],
        ["setForeignStateChanged", true],
      ]) {
        const original = cls.prototype[method];
        if (typeof original !== "function") {
          continue;
        }
        cls.prototype[method] = function (id, ...rest) {
          if (typeof id === "string" && askedByAdapter()) {
            const full = foreign || id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
            singleReads.set(full, (singleReads.get(full) || 0) + 1);
          }
          return original.call(this, id, ...rest);
        };
      }
    }
    return exported;
  };
  const mine = o => o.startsWith("adapter ") || o.startsWith("library ");
  process.on("exit", () => {
    let quiet = {};
    try {
      const w = JSON.parse(fs.readFileSync(path.join(dir, "window.json"), "utf8"));
      for (const [id, times] of reads) {
        const n = times.filter(t => t >= w.start && t <= w.end).length;
        if (n) {
          quiet[id] = n;
        }
      }
    } catch {
      quiet = {};
    }
    const left = [];
    for (const t of timers.values()) {
      const r = t.ref.deref();
      if (r && !r._destroyed && typeof r.hasRef === "function" && r.hasRef() && mine(t.owner)) {
        left.push(`${t.type} from ${t.owner}`);
      }
    }
    for (const h of process._getActiveHandles()) {
      if (h && h[OWNER] && !h.destroyed && mine(h[OWNER])) {
        left.push(`${h.constructor.name} from ${h[OWNER]}`);
      }
    }
    fs.writeFileSync(
      path.join(dir, `${process.pid}.json`),
      JSON.stringify({ left, quiet, single: Object.fromEntries(singleReads) }),
    );
  });
}
