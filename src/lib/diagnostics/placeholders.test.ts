import { describe, expect, it } from "vitest";
import { Placeholders, leaked } from "./placeholders";

describe("Placeholders", () => {
  it("gives the same value the same placeholder, in any case, and counts per kind", () => {
    const p = new Placeholders();
    expect(p.mark("address", "10.0.0.5")).toBe("address-1");
    expect(p.mark("address", "10.0.0.6")).toBe("address-2");
    expect(p.mark("address", "10.0.0.5")).toBe("address-1");
    expect(p.mark("serial", "10.0.0.5")).toBe("serial-1");
    expect(p.mark("mac", "AA:BB:CC:00:11:22")).toBe(p.mark("mac", "aa:bb:cc:00:11:22"));
  });

  it("finds addresses, hardware ids and mail addresses by their form", () => {
    const p = new Placeholders();
    expect(p.text("from 192.168.1.20 to 192.168.1.20 and fe80:0:0:0:1:2:3:4")).toBe(
      "from address-2 to address-2 and address-1",
    );
    expect(p.text("mac 00:1A:2b:3C:4d:5E or 00-1A-2B-3C-4D-5F, same as 00:1a:2b:3c:4d:5f")).toBe(
      "mac mac-1 or mac-2, same as mac-2",
    );
    expect(p.text("mail jane.doe+x@example.co.uk")).toBe("mail mail-1");
  });

  it("finds a shortened IPv6 address, an address at the end of a sentence and an eight-byte id", () => {
    const p = new Placeholders();
    expect(p.text("link fe80::1a2b:3c4d, mapped ::ffff:192.168.1.7 and 2001:db8::1.")).toBe(
      "link address-1, mapped address-2 and address-3.",
    );
    expect(p.text("It answered from 192.168.1.20.")).toBe("It answered from address-4.");
    expect(p.text("host:fe80::9 and [2001:db8::2]:8080")).toBe("host:address-5 and [address-6]:8080");
    expect(p.text("device 12:34:56:78:9A:BC:DE:F0 and 12-34-56-78-9a-bc-de-f0")).toBe("device mac-1 and mac-1");
    expect(p.text("mac AC44F2A1B2C3 and ac44f2a1b2c3")).toBe("mac mac-2 and mac-2");
  });

  it("leaves numbers, times and code alone that only look like an address", () => {
    const p = new Placeholders();
    const same = [
      "version 3.3.0.1.2 and 256.1.1.1 and 1.2.3",
      "at 2026-10-06T15:33:41.123Z, 15:33:41 and 12:30",
      "Class::method, Foo::Bar and ::",
      "hash deadbeefcafe0123456789, number 123456789012 and word facadefacade",
    ];
    for (const text of same) {
      expect(p.text(text)).toBe(text);
    }
  });

  it("reads a long text in linear time", () => {
    const p = new Placeholders();
    p.name("Home WiFi 5", "network");
    p.name("a b c d e f", "serial");
    const text = `${"a".repeat(200_000)} ${":".repeat(200_000)}a ${"1.".repeat(100_000)}x ${"1:".repeat(100_000)}x`;
    // a percent-encoded gap holds letters (`%aa`): unbounded, it read on from every letter (round 99 security review)
    const gaps = `home${"%20.".repeat(100_000)}x home wifi${" ".repeat(200_000)}x a${"%aa".repeat(70_000)}`;
    const started = Date.now();
    p.text(text);
    p.text(gaps);
    leaked(gaps, ["Home WiFi 5", "10.0.0.1", "a b c d e f"]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("replaces a registered name as written or in its lower-case id form, longest first", () => {
    const p = new Placeholders();
    expect(p.name("Living Room")).toBe("name-1");
    expect(p.name("Living")).toBe("name-2");
    expect(p.name("Home WiFi", "network")).toBe("network-1");
    expect(p.text("Living Room lamp, Living area, LivingRoom, Home WiFi")).toBe(
      "name-1 lamp, name-2 area, LivingRoom, network-1",
    );
    expect(p.text("demo.0.living_room.power, living-room, living room, LIVING ROOM, home_wifi_5g")).toBe(
      "demo.0.name-1.power, name-1, name-1, LIVING ROOM, network-1_5g",
    );
  });

  it("leaves a protocol token alone that only contains a name the user took from a protocol word", () => {
    // yamaha 2026-10-07: an input named "Radio" turned `net_radio` and `NET RADIO` into `net_name-1` / `NET name-1`
    const p = new Placeholders();
    p.name("Radio");
    expect(p.deep({ net_radio: { input: "net_radio" }, "MAIN:INP": "NET RADIO" })).toEqual({
      net_radio: { input: "net_radio" },
      "MAIN:INP": "NET RADIO",
    });
    expect(p.text("input Radio, net-radio, radio_station, radio-tuner, RADIO, demo.0.radio.power")).toBe(
      "input name-1, net-radio, radio_station, radio-tuner, RADIO, demo.0.name-1.power",
    );
  });

  it("replaces a value of any other kind wherever it stands, in any case", () => {
    // yamaha 2026-10-07 (security review of 27b0ac6): a serial or a network name inside a longer token stayed readable
    const p = new Placeholders();
    expect(p.name("ABC123", "serial")).toBe("serial-1");
    expect(p.name("Home WiFi", "network")).toBe("network-1");
    expect(p.text("host rx-v6a-ABC123, id rx-v6a-abc123x, WLAN home_wifi_5G, HOME WIFI")).toBe(
      "host rx-v6a-serial-1, id rx-v6a-serial-1x, WLAN network-1_5G, network-1",
    );
  });

  it("keeps the first placeholder and the broader kind for a value registered twice (yamaha 2026-10-07)", () => {
    const text = "ssid FRITZ-7590_5G / Fritz-7590 / fritz-7590";
    const first = new Placeholders();
    expect(first.name("FRITZ-7590", "network")).toBe("network-1");
    expect(first.name("FRITZ-7590")).toBe("network-1");
    expect(first.text(text)).toBe("ssid network-1_5G / network-1 / network-1");
    expect(first.name("Other")).toBe("name-1");
    const reverse = new Placeholders();
    expect(reverse.name("FRITZ-7590")).toBe("name-1");
    expect(reverse.name("FRITZ-7590", "network")).toBe("name-1");
    expect(reverse.text(text)).toBe("ssid name-1_5G / name-1 / name-1");
    expect(reverse.name("Other", "network")).toBe("network-1");
  });

  it("lets the broader kind go first between two spellings of one length", () => {
    const p = new Placeholders();
    expect(p.name("fritz-7590")).toBe("name-1");
    expect(p.name("Fritz-7590", "network")).toBe("network-1");
    expect(p.text("fritz-7590 / Fritz-7590 / FRITZ-7590_5G")).toBe("network-1 / network-1 / network-1_5G");
  });

  it("keeps the structure of a raw capture", () => {
    // round 99 advisor: a gap of any non-alphanumeric character ate the quotes and brackets between two keys
    const p = new Placeholders();
    p.name("Home WiFi", "network");
    for (const capture of ['{"home":{"wifi":1}}', "<home><wifi/>", "home['wifi']", 'home\\"wifi', "home`wifi"]) {
      expect(p.text(capture)).toBe(capture);
    }
    expect(p.text("Home: WiFi, home%22wifi")).toBe("network-1, network-1");
  });

  it("keeps a quote or bracket inside a value as part of it", () => {
    // round 99 review session: with structure characters out of the gap, `John's iPhone` no longer matched itself
    const p = new Placeholders();
    p.name("John's iPhone", "network");
    p.name("Box [5G]", "network");
    p.name('Guest "Net"', "network");
    p.name("AB<12>", "serial");
    p.name("a\\b", "host");
    expect(p.text(`John's iPhone, JOHN'S-IPHONE, Box [5G], box_[5g], Guest "Net", ab<12>x, A\\B`)).toBe(
      "network-1, network-1, network-2, network-2, network-3, serial-1x, host-1",
    );
  });

  it("keeps two numbers of a value apart", () => {
    const p = new Placeholders();
    p.name("Box 7590 12", "device");
    expect(p.text("Box 7590-12, box7590 12, BOX 759012")).toBe("device-1, device-1, BOX 759012");
  });

  it("lets a short value of another kind take the head of a longer word — private, if less readable", () => {
    const p = new Placeholders();
    p.name("Home Net", "network");
    expect(p.text("homenetwork, Home%20Net, HOME.NET")).toBe("network-1work, network-1, network-1");
  });

  it("ignores a blank name and replaces one without a letter or digit as written", () => {
    // round 99 security review: `🏠` and `★★★` were ignored for a moment, never replaced, and the canary stayed silent
    const p = new Placeholders();
    expect(p.name("  ")).toBe("  ");
    expect(p.text("  ")).toBe("  ");
    expect(p.name("🏠")).toBe("name-1");
    expect(p.name("★★★", "network")).toBe("network-1");
    expect(p.text("room 🏠, wlan ★★★_5G")).toBe("room name-1, wlan network-1_5G");
    expect(leaked("room 🏠", ["🏠", "★★★"])).toEqual(["🏠"]);
  });

  it("joins two words only across a short gap, and the canary sees a longer one", () => {
    const p = new Placeholders();
    p.name("Home WiFi", "network");
    expect(p.text("Home - - WiFi, Home        WiFi")).toBe("network-1, Home        WiFi");
    expect(leaked("Home        WiFi", ["Home WiFi"])).toEqual(["Home WiFi"]);
  });

  it("compares in the composed form", () => {
    // round 99 security review: a decomposed umlaut (macOS file names) passed the replacement and the canary
    const p = new Placeholders();
    p.name("Küche");
    p.name("Garten Süd", "network");
    expect(p.text("Ku\u0308che, GARTEN SU\u0308D")).toBe("name-1, network-1");
    const registered = new Placeholders();
    registered.name("Su\u0308d", "network");
    expect(registered.text("Süd, SÜD")).toBe("network-1, network-1");
    const decomposed = "Ku\u0308che";
    expect(p.deep({ [decomposed]: 1 })).toEqual({ "name-1": 1 });
  });

  it("replaces in every string of a value and in every key", () => {
    const p = new Placeholders();
    p.name("Kitchen");
    expect(p.deep({ "10.0.0.1": ["Kitchen", 3, null, { ip: "10.0.0.1" }], kitchen: true, on: true })).toEqual({
      "address-1": ["name-1", 3, null, { ip: "address-1" }],
      "name-1": true,
      on: true,
    });
  });
});

describe("Placeholders.deep with keys that meet", () => {
  it("counts many keys that meet in linear time", () => {
    const p = new Placeholders();
    p.name("Home WiFi", "network");
    const keys: Record<string, number> = {};
    const gap = "!#$&*+,./:;=?@_~ -";
    for (let i = 0; i < 20_000; i++) {
      const between = [i % 18, Math.floor(i / 18) % 18, Math.floor(i / 324) % 18, Math.floor(i / 5832)].map(
        d => gap[d],
      );
      keys[`Home${between.join("")}WiFi`] = i;
    }
    const started = Date.now();
    const out = p.deep(keys) as Record<string, number>;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(Object.keys(out)).toHaveLength(20_000);
    expect(out["network-1#20000"]).toBe(19_999);
  });

  it("keeps both values when two keys become the same placeholder", () => {
    const p = new Placeholders();
    p.name("Living Room");
    expect(p.deep({ "Living Room": 1, living_room: 2, "living-room": 3, LIVINGROOM: 4 })).toEqual({
      "name-1": 1,
      "name-1#2": 2,
      "name-1#3": 3,
      LIVINGROOM: 4,
    });
  });
});

describe("Placeholders against an independent reading", () => {
  // the value still readable once case, percent-encoding and everything but letters and digits are ignored
  const squeeze = (s: string): string =>
    s
      .replace(/%[0-9a-f]{2}/gi, " ")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
  const spellings = (value: string): string[] => {
    const words = value.split(/[\s_-]+/);
    const cases = [
      (w: string): string => w,
      (w: string): string => w.toUpperCase(),
      (w: string): string => w.toLowerCase(),
      (w: string): string => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    ];
    return [" ", "_", "-", "", ".", "/", "+", ":", "%20", " \t "].flatMap(sep =>
      cases.flatMap(c =>
        ["%", "x%x", "pre_%_post", "demo.0.%.power"].map(at => at.replace("%", words.map(c).join(sep))),
      ),
    );
  };
  const values: [string, string][] = [
    ["Living Room", "name"],
    ["Radio", "name"],
    ["Home WiFi", "network"],
    ["FRITZ-7590", "network"],
    ["ABC123", "serial"],
  ];

  it("leaves no spelling of another kind readable, and the canary is red for every spelling a name leaves", () => {
    const missed: string[] = [];
    for (const [value, kind] of values) {
      for (const spelling of spellings(value)) {
        const p = new Placeholders();
        p.name(value, kind);
        const out = p.text(spelling);
        const readable = squeeze(out).includes(squeeze(value));
        if (readable && (kind !== "name" || leaked(out, [value]).length === 0)) {
          missed.push(`${kind} ${spelling} -> ${out}`);
        }
      }
    }
    expect(missed).toEqual([]);
  });

  it("keeps the broader kind in either order of registration", () => {
    const missed: string[] = [];
    for (const [value] of values) {
      for (const order of [
        ["name", "network"],
        ["network", "name"],
      ]) {
        const p = new Placeholders();
        order.forEach(kind => p.name(value, kind));
        missed.push(...spellings(value).filter(s => squeeze(p.text(s)).includes(squeeze(value))));
      }
    }
    expect(missed).toEqual([]);
  });
});

describe("leaked", () => {
  it("reads every spelling a reader still recognises", () => {
    expect(leaked("ssid Ｈｏｍｅ ＷｉＦｉ", ["Home WiFi"])).toEqual(["Home WiFi"]);
    expect(leaked("ssid Home%20WiFi, STRASSE 1", ["Home WiFi", "STRAẞE 1", "Weg 7"])).toEqual([
      "Home WiFi",
      "STRAẞE 1",
    ]);
    expect(leaked("room Ku\u0308che", ["Küche"])).toEqual(["Küche"]);
    expect(leaked("only 🏠 here", ["🏠", "★"])).toEqual(["🏠"]);
    // two keys of a raw capture are no value — the replacement leaves them, so the canary must too (no adapter could fix it)
    expect(leaked('{"home":{"wifi":1}} <home><wifi/> home[\'wifi\']', ["Home WiFi"])).toEqual([]);
    expect(leaked("JOHN'S IPHONE, Box [5g]", ["John's iPhone", "Box [5G]", "Johns iPhone"])).toEqual([
      "John's iPhone",
      "Box [5G]",
    ]);
  });

  it("reads a long report in linear time", () => {
    const report = `a${"%aa".repeat(70_000)} ${"a ".repeat(100_000)}${" ".repeat(200_000)}x 10${".".repeat(200_000)}x`;
    const started = Date.now();
    leaked(report, ["a b c d e f", "10.0.0.1", "Home WiFi 5"]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("names every real value that still stands in the report, judged on its own", () => {
    expect(leaked('{"ip":"address-1","name":"demo.0.kitchen"}', ["10.0.0.1", "Kitchen", " ", "_"])).toEqual([
      "Kitchen",
    ]);
    expect(leaked('{"ip":"10.0.0.10","gw":"110.0.0.1","n":10001}', ["10.0.0.1"])).toEqual([]);
    expect(leaked("ip 10 0 0 1", ["10.0.0.1"])).toEqual(["10.0.0.1"]);
    expect(leaked('{"host":"rx-v6a-abc123","ssid":"WLANABC123"}', ["ABC123"])).toEqual(["ABC123"]);
    expect(leaked("ssid WLANABC123", ["ABC123"])).toEqual(["ABC123"]);
    // a protocol word cannot be a canary value: the replacement leaves `net_radio` standing on purpose
    expect(leaked('{"id":"net_radio"}', ["Radio"])).toEqual(["Radio"]);
  });

  it("is red for every spelling the replacement leaves standing (yamaha 2026-10-07)", () => {
    const p = new Placeholders();
    p.name("Wohnzimmer");
    p.name("Living Room");
    const report = p.text("Wohnzimmer / living-room");
    expect(leaked(report, ["Wohnzimmer", "Living Room"])).toEqual([]);
    for (const spelling of ["WOHNZIMMER", "Living_Room", "LIVING ROOM", "LivingRoom", "living  room", "Living.Room"]) {
      const value = spelling.toLowerCase().startsWith("w") ? "Wohnzimmer" : "Living Room";
      expect(leaked(p.text(spelling), [value])).toEqual([value]);
    }
  });
});
