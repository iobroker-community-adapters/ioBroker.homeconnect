"use strict";
// Loaded into the adapter process by test/inventory.js (`adapterEnv()`, first `--require`). It only observes: when the
// process exits, it records every timer, server and socket the adapter or one of its own dependencies left open after
// onUnload. js-controller (with everything it loads) and a test hook are not the adapter's and are left out.
// A start marker is written at load: a process that never reaches its exit (killed, crashed) has no report.
// Fleet master (.consistency-master/test/resource-probe.js) — never edit the copy in an adapter.
const fs = require("node:fs");
const net = require("node:net");
const dgram = require("node:dgram");
const path = require("node:path");
const asyncHooks = require("node:async_hooks");

const dir = process.env.RESOURCE_PROBE_DIR;
if (dir) {
  fs.writeFileSync(path.join(dir, `${process.pid}.start`), "");
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
    fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ left, quiet }));
  });
}
