// Fleet master (.consistency-master/src/lib/diagnostics/placeholders.ts) — never edit the copy in an adapter.
//
// Diagnostics report standard (krobi 2026-10-06, page "Diagnosebericht — Flottenstandard"): what the report promises about
// privacy it keeps (DB-04, krobi 2026-09-22: the promise is kept, not only made), and names the user gave stand in it
// only as placeholders (DB-05). The core every adapter shares: stable
// placeholders per report, addresses, hardware ids and mail addresses found by their form, names found as whole words in
// values and in object keys alike.
// A name matches in exactly two spellings (round 98, measured on yamaha 2026-10-07): as the user wrote it, and all in lower
// case with a space, `_` or `-` between its words — the form an object id takes (`demo.0.living_room`). `_` and `-` belong
// to the word, so a name never matches inside a longer token, and other casings never match: a name the user took from a
// protocol word ("Radio") must leave the protocol's own tokens (`net_radio`, `NET RADIO`) readable. A device that reports a
// name in yet another spelling registers that spelling with `name()` itself. Every other kind (a serial number, a network
// or host name, an id) is no word of any protocol and is replaced wherever it stands, in any case, with nothing or up to
// six characters between its words that are no letter or digit (`Home.WiFi`, `Home%20WiFi`, `FRITZ7590`; round 99, measured with
// an independent reading), also inside a longer token (`rx-v6a-ABC123`, `WLAN-ABC123_5G`) — the old adapter cores
// replaced known values that way. A short value therefore also takes the head of a longer word (`Home Net` in
// `homenetwork`): the report stays private, the word loses its readable head.
// A value registered twice keeps its first placeholder and the broader kind (round 99, yamaha 2026-10-07: a network name
// registered again as a name stood in the report as `Fritz-7590`).
// The canary check `leaked` reads on its own, never with a pattern of the replacement (round 99): a spelling `text()`
// leaves standing turns the adapter's report test red, and the adapter registers that spelling. Text and values are
// compared in their composed Unicode form (`Ku\u0308che` is `Küche`, macOS writes file names that way).
// Order for every text: the adapter blanks secrets first, then this replaces, then the report is cut to size.
// What else is personal (serial numbers, network names, an adapter's own fields) the adapter registers with `name()`.

import { isIPv6 } from "node:net";

/** One IPv4 number, 0–255. */
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
/** IPv4, four numbers 0–255, not part of a longer dotted number — a full stop after it ends a sentence. */
const IPV4 = new RegExp(`(?<!\\d|\\d\\.)${OCTET}(?:\\.${OCTET}){3}(?!\\d|\\.\\d)`, "g");
/**
 * What may be an IPv6 address, written out or shortened with `::`, also right after a `:` (`host:fe80::1`); `isIPv6`
 * decides. One bounded run (an address has at most 45 characters), so a long text is read in linear time.
 */
const IPV6_CANDIDATE = /(?<![\w.])[0-9A-Fa-f:.]{2,45}(?![\w:])/g;
/** A hardware id: six (MAC) or eight (EUI-64) bytes with `:` or `-` between them. */
const HARDWARE =
  /(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}(?:(?:[:-][0-9A-Fa-f]{2}){2})?(?![0-9A-Fa-f:-])/g;
/** A MAC address without separators: twelve hex digits with at least one letter and one digit. */
const BARE_MAC = /(?<![0-9A-Za-z])(?=[0-9A-Fa-f]*[A-Fa-f])(?=[0-9A-Fa-f]*\d)[0-9A-Fa-f]{12}(?![0-9A-Za-z])/g;
/**
 * A text as a literal part of a pattern.
 *
 * @param s the text
 * @returns the text with every pattern character escaped
 */
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * What may stand between two words of a value: up to six characters that are no letter or digit, also percent-encoded.
 * The bound keeps a long text linear — `%aa` is a gap and holds letters, so an unbounded gap read on from every letter.
 * Quotes, brackets and the backslash are no gap: a raw capture (`{"home":{"wifi":1}}`) keeps its structure.
 */
const GAP = "(?:%[0-9A-Fa-f]{2}|[^\\p{L}\\p{N}\"'`{}\\[\\]<>\\\\])";
/**
 * A value as a loose pattern: its words in order, a gap or none between them — at least one character between two
 * numbers, so `10.0.0.1` is not `10001`. A word ends only where a gap character stands, so a quote or bracket inside the
 * value stays part of it (`John's iPhone`, `Box [5G]`). A value without a word (`🏠`) stands as written.
 *
 * @param value the value, trimmed
 * @returns the pattern text
 */
function loose(value: string): string {
  const words = value.split(/[^\p{L}\p{N}"'`{}[\]<>\\]+/u).filter(word => word.length > 0);
  if (words.length === 0) {
    return escape(value);
  }
  return words
    .map((word, i) =>
      i === 0 ? escape(word) : `${GAP}{${/\d$/.test(words[i - 1]) && /^\d/.test(word) ? 1 : 0},6}${escape(word)}`,
    )
    .join("");
}
/**
 * Where a registered value matches. A `name`: as written or all in lower case with a space, `_` or `-` between its words,
 * never inside a longer token (`_` and `-` count as part of a word). Any other kind: in any case, with nothing or a
 * short gap between its words (`loose`), anywhere.
 *
 * @param value the registered value
 * @param kind its placeholder kind, `name` when not given
 * @returns the pattern
 */
export function valuePattern(value: string, kind = "name"): RegExp {
  value = value.normalize("NFC");
  if (kind !== "name") {
    return new RegExp(loose(value.trim()), "giu");
  }
  const words = value
    .toLowerCase()
    .split(/[\s_-]+/)
    .map(escape);
  const forms = `(?:${escape(value)}|${words.join("[ _-]")})`;
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${forms}(?![\\p{L}\\p{N}_-])`, "gu");
}

/** A mail address — it starts only where a word starts, so a long text without `@` is read in linear time. */
const MAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * The placeholders of one report: the same real value always gets the same placeholder inside it (`address-1`,
 * `name-2` …), so two lines about the same thing stay recognisable. A new report starts counting anew.
 */
export class Placeholders {
  private readonly known = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  private readonly names = new Map<string, { placeholder: string; kind: string }>();

  /**
   * The placeholder for one value.
   *
   * @param kind what it is, the placeholder's word (`address`, `mac`, `name`, `serial` …)
   * @param value the real value
   * @returns the placeholder
   */
  public mark(kind: string, value: string): string {
    const key = `${kind}\u0000${value.toLowerCase()}`;
    const known = this.known.get(key);
    if (known) {
      return known;
    }
    const n = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, n);
    const placeholder = `${kind}-${n}`;
    this.known.set(key, placeholder);
    return placeholder;
  }

  /**
   * Register a name the user gave (a device, room or network name) or any other personal value: from now on it is
   * replaced wherever it stands as a whole word, as written or in the lower-case id form (`valuePattern`). Registered
   * again, a value keeps its first placeholder, and any other kind replaces the narrower `name`, never the reverse.
   *
   * @param value the real value (blank ones are ignored)
   * @param kind the placeholder's word, `name` when not given
   * @returns the placeholder, or the value itself when it is blank
   */
  public name(value: string, kind = "name"): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return value;
    }
    const known = this.names.get(trimmed);
    if (known) {
      if (kind !== "name") {
        known.kind = kind;
      }
      return known.placeholder;
    }
    const placeholder = this.mark(kind, trimmed);
    this.names.set(trimmed, { placeholder, kind });
    return placeholder;
  }

  /**
   * Replace everything personal in a text: the registered names (longest first, as whole words), then mail, hardware
   * ids and IP addresses by their form.
   *
   * @param text the text
   * @returns the text with placeholders
   */
  public text(text: string): string {
    let out = text.normalize("NFC");
    // two spellings of one length (`Fritz-7590` as a network, `fritz-7590` as a name): the broader kind goes first
    const names = [...this.names.entries()].sort(
      ([a, x], [b, y]) => b.length - a.length || Number(x.kind === "name") - Number(y.kind === "name"),
    );
    for (const [name, { placeholder, kind }] of names) {
      out = out.replace(valuePattern(name, kind), placeholder);
    }
    out = out.replace(MAIL, match => this.mark("mail", match));
    out = out.replace(HARDWARE, match => this.mark("mac", match.replace(/-/g, ":")));
    out = out.replace(BARE_MAC, match => this.mark("mac", match.replace(/(..)(?!$)/g, "$1:")));
    out = out.replace(IPV6_CANDIDATE, match => {
      const address = match.replace(/\.+$/, "");
      return isIPv6(address) && /[0-9A-Fa-f]/.test(address)
        ? this.mark("address", address) + match.slice(address.length)
        : match;
    });
    return out.replace(IPV4, match => this.mark("address", match));
  }

  /**
   * Replace in every string of a value and in every object key — a device keyed by its address or name is as
   * personal as the value.
   *
   * @param value any JSON-like value
   * @returns a copy with placeholders
   */
  public deep(value: unknown): unknown {
    if (typeof value === "string") {
      return this.text(value);
    }
    if (Array.isArray(value)) {
      return value.map(item => this.deep(item));
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      const counts = new Map<string, number>();
      for (const [key, item] of Object.entries(value)) {
        // two keys that become the same placeholder (`Kitchen` and `kitchen`) both stay in the report; one counter per
        // placeholder keeps many such keys linear
        const base = this.text(key);
        let name = base;
        let n = counts.get(base) ?? 1;
        while (Object.hasOwn(out, name)) {
          n++;
          name = `${base}#${n}`;
        }
        counts.set(base, n);
        out[name] = this.deep(item);
      }
      return out;
    }
    return value;
  }
}

/**
 * A text the way the canary reads it: compatibility forms folded (full width `Ｈｏｍｅ` is `Home`), every
 * percent-encoded character a gap, `ß` as `ss`.
 *
 * @param text the text
 * @returns the text to search
 */
const plain = (text: string): string =>
  text
    .normalize("NFKC")
    .replace(/%[0-9A-Fa-f]{2}/g, " ")
    .replace(/[ßẞ]/g, "ss");

/**
 * The canary check every adapter's report test runs: which of the real values still stand in the finished report. It
 * reads on its own, never with a pattern of the replacement: in any case and compatibility form, with nothing or any run
 * of characters that are no letter, digit, quote, bracket or backslash between the words of a value, also inside a
 * longer token (two keys of a raw capture, `{"home":{"wifi":1}}`, are no value `Home WiFi`); at least one
 * character between two numbers, and a value that begins or ends with a digit only where no further digit continues it
 * (`10.0.0.1` is neither `10001` nor in `10.0.0.10`). A spelling `text()` leaves standing is red here, and the adapter
 * registers it with `name()`. Canary values are the fixture's distinct personal values — a value that is also a
 * protocol word (an input named "Radio" next to `net_radio`) cannot be one. Measured and not read: one word spelled out
 * letter by letter (`A B C 1 2 3`), HTML entities (`&#49;`) and a value written without its own quote or bracket
 * (`Johns iPhone` for `John's iPhone`) — a report that carries those decodes them first.
 *
 * @param report the report text
 * @param secrets the real values that must not appear
 * @returns the ones that leaked
 */
export function leaked(report: string, secrets: readonly string[]): string[] {
  const text = plain(report);
  return secrets.filter(secret => {
    const value = plain(secret).trim();
    if (!value) {
      return false;
    }
    // quotes, brackets and the backslash belong to a word and never join two — two keys of a capture stay two keys
    const words = value.split(/[^\p{L}\p{N}"'`{}[\]<>\\]+/u).filter(word => word.length > 0);
    const gap = "[^\\p{L}\\p{N}\"'`{}\\[\\]<>\\\\]";
    const body =
      words.length === 0
        ? escape(value)
        : words
            .map((word, i) =>
              i === 0
                ? escape(word)
                : `${gap}${/\d$/.test(words[i - 1]) && /^\d/.test(word) ? "+" : "*"}${escape(word)}`,
            )
            .join("");
    const before = /^\d/.test(value) ? "(?<!\\d)" : "";
    const after = /\d$/.test(value) ? "(?!\\d)" : "";
    return new RegExp(`${before}${body}${after}`, "iu").test(text);
  });
}
