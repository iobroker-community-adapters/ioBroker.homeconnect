"use strict";
// Fleet master test/counterparts.js (round 172, R172-21, homeconnect 2026-11-08 15:29) — never edit the copy in an
// adapter. Which counterpart of src/lib/api-limits.json a call belongs to, in ONE place: test/fleet-suites.js judges
// every limit with it, test/network-hook.js answers an error press with it (`500press`: only the calls of the pressed
// counterparts get the 500 — before, a 500 to every answer stopped a login-first adapter at its login, and its pressed
// error window never filled). Pure functions: the network hook loads it into the adapter process.

/**
 * Round 171: whether a host never leaves the user's network — RFC 1918 (10/8, 172.16/12, 192.168/16), RFC 1122 loopback
 * (127/8, ::1), RFC 3927 link-local (169.254/16, fe80::/10), RFC 4193 unique local (fc00::/7), RFC 2365 and RFC 5771
 * scoped multicast (239/8, 224.0.0.0/24), RFC 919 limited broadcast, RFC 6762 `.local` and RFC 6761 `localhost` names.
 * RFC 1918 §3: such an address is not reachable from the Internet, so a counterpart declared `network: "private"` never
 * takes a cloud's calls.
 *
 * @param {string} host the host a call went to
 */
function privateHost(host) {
  const name = String(host)
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (/\.local\.?$/.test(name)) {
    return true;
  }
  // RFC 6761 §6.3: `localhost` and every name under it is the loopback
  if (/(?:^|\.)localhost\.?$/.test(name)) {
    return true;
  }
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (v4) {
    const [a, b, c] = v4.slice(1, 4).map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 239 ||
      (a === 224 && b === 0 && c === 0) ||
      name.endsWith("255.255.255.255")
    );
  }
  return name === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(name) || /^fe[89ab][0-9a-f]?:/.test(name);
}

/**
 * Round 100: whether a counted call belongs to a declared counterpart — every field of `match` must fit. Round 107:
 * `hostPattern`, an anchored regular expression. Round 171: `network: "private"` (privateHost), `method` and the anchored
 * `pathPattern` of an HTTP call, and `bodyPattern` over the first 1024 characters of its body (network hook, section 10)
 * — an upstream that limits one endpoint (Home Connect: 5 program starts a minute) is declared as its own counterpart.
 *
 * @param {{ host?: string, method?: string, path?: string, body?: string }} call a counted call
 * @param {Record<string, string | number>} match the counterpart's `match`
 */
function fits(call, match) {
  return Object.entries(match).every(([key, value]) => {
    if (key === "hostPattern") {
      return new RegExp(String(value)).test(String(call.host));
    }
    if (key === "pathPattern" || key === "bodyPattern") {
      const text = key === "pathPattern" ? call.path : call.body;
      return typeof text === "string" && new RegExp(String(value)).test(text);
    }
    if (key === "network") {
      return value === "private" && privateHost(String(call.host));
    }
    return call[key] === value;
  });
}

module.exports = { privateHost, fits };
