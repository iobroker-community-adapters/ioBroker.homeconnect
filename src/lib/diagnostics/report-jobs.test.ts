import { describe, expect, it, vi } from "vitest";
import { isReport, makeDiagnosticsApi } from "../../../src-admin/src/diagnosticsApi";
import {
  REPORT_COOLDOWN_MS,
  REPORT_KEEP_MS,
  ReportJobs,
  onceEach,
  type ReportBody,
  type ReportSource,
  type ReportSourceDevice,
} from "./report-jobs";

function source(devices: ReportSourceDevice[], overrides: Partial<ReportSource<string>> = {}): ReportSource<string> {
  return {
    adapter: "demo",
    version: "1.0.0",
    devices: () => devices,
    readLive: vi.fn(() => Promise.resolve("live answer")),
    build: vi.fn((id: string, live: string | undefined, liveError: string | undefined) =>
      Promise.resolve({
        fileId: id,
        content: {
          environment: { jsController: "7.2.2" },
          objectTree: [{ id: `demo.0.${id}.power` }],
          logs: [],
          device: id,
          ...(live ? { live } : {}),
          ...(liveError ? { liveError } : {}),
        },
      }),
    ),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe("ReportJobs", () => {
  it("lists every device, connected or not, by label", async () => {
    const jobs = new ReportJobs(
      source([
        { id: "b", connected: false },
        { id: "a", label: "Kitchen", connected: true },
        { id: "c", label: "c", connected: true },
      ]),
    );
    expect(await jobs.handle({ action: "list" })).toEqual({
      devices: [
        { value: "b", label: "b", connected: false },
        { value: "c", label: "c", connected: true },
        { value: "a", label: "Kitchen (a)", connected: true },
      ],
    });
  });

  it("answers start at once and hands the finished report over exactly once", async () => {
    const src = source([{ id: "lamp", connected: true }]);
    const jobs = new ReportJobs(src, () => Date.parse("2026-10-06T15:33:41Z"));
    const { job } = (await jobs.handle({ action: "start", device: "lamp" })) as { job: string };
    expect(await jobs.handle({ action: "start", device: "lamp" })).toEqual({ job });
    expect(jobs.result(job)).toEqual({ pending: true });
    await settle();
    const report = (await jobs.handle({ action: "result", job })) as { fileName: string; content: string };
    expect(report.fileName).toBe("demo_lamp_v1.0.0_2026-10-06_153341.json");
    expect(JSON.parse(report.content)).toMatchObject({
      adapter: "iobroker.demo",
      connected: true,
      device: "lamp",
      live: "live answer",
    });
    expect(await jobs.handle({ action: "result", job })).toEqual({ gone: true });
    expect(src.log.info).toHaveBeenCalledOnce();
  });

  it("never reads an unconnected device live and says it was not connected", async () => {
    const src = source([{ id: "lamp", connected: false }]);
    const jobs = new ReportJobs(src);
    const { job } = jobs.start("lamp") as { job: string };
    await settle();
    const report = jobs.result(job) as { content: string };
    expect(src.readLive).not.toHaveBeenCalled();
    expect(JSON.parse(report.content)).toMatchObject({ connected: false });
    expect(JSON.parse(report.content).live).toBeUndefined();
  });

  it("carries a failed live read into the report", async () => {
    const jobs = new ReportJobs(
      source([{ id: "lamp", connected: true }], { readLive: () => Promise.reject(new Error("timed out")) }),
    );
    const { job } = jobs.start("lamp") as { job: string };
    await settle();
    expect(JSON.parse((jobs.result(job) as { content: string }).content).liveError).toBe("timed out");
  });

  it("names a failed report and logs it once", async () => {
    const src = source([{ id: "lamp", connected: true }], { build: () => Promise.reject(new Error("broken")) });
    const jobs = new ReportJobs(src);
    const { job } = jobs.start("lamp") as { job: string };
    await settle();
    expect(jobs.result(job)).toEqual({ error: "report failed: broken" });
    expect(src.log.warn).toHaveBeenCalledOnce();
  });

  it("refuses an unknown device, an unknown action and a report right after the last one", async () => {
    let t = 0;
    let devices: ReportSourceDevice[] = [{ id: "lamp", connected: true }];
    const jobs = new ReportJobs(source([], { devices: () => devices }), () => t);
    expect(jobs.start("ghost")).toEqual({ error: "unknown device 'ghost'" });
    expect(await jobs.handle({ action: "start" })).toEqual({ error: "unknown device ''" });
    expect(await jobs.handle({ action: "result" })).toEqual({ gone: true });
    expect(await jobs.handle({ action: "dance" })).toEqual({ error: "unknown diagnostics action 'dance'" });
    expect(await jobs.handle(null)).toEqual({ error: "unknown diagnostics action 'undefined'" });
    const first = jobs.start("lamp") as { job: string };
    await settle();
    jobs.result(first.job);
    t = REPORT_COOLDOWN_MS - 1;
    const second = jobs.start("lamp") as { job: string };
    await settle();
    expect(jobs.result(second.job)).toEqual({
      error: "a report for this device is being made right now — try again in a moment",
    });
    t = 10 * REPORT_COOLDOWN_MS;
    devices = [];
    // round 157 (master audit M8): a device gone is refused at the start — make never looked it up again
    expect(jobs.start("lamp")).toEqual({ error: "unknown device 'lamp'" });
  });

  it("starts a new job once the last one is finished, also for another device next to it", async () => {
    let t = 0;
    const jobs = new ReportJobs(
      source([
        { id: "lamp", connected: true },
        { id: "plug", connected: true },
      ]),
      () => t,
    );
    const first = jobs.start("lamp") as { job: string };
    const plug = jobs.start("plug") as { job: string };
    await settle();
    // round 157 (master audit M9): two ids were always two (the id carries the device) — both reports must come
    expect(jobs.result(first.job)).toHaveProperty("fileName");
    expect(jobs.result(plug.job)).toHaveProperty("fileName");
    t = 10 * REPORT_COOLDOWN_MS;
    const again = jobs.start("lamp") as { job: string };
    expect(again.job).not.toBe(first.job);
    await settle();
    expect(jobs.result(again.job)).toHaveProperty("fileName");
  });

  it("keeps every frame field when the body names the same key (DB-06)", async () => {
    const jobs = new ReportJobs(
      source([{ id: "lamp", connected: false }], {
        build: () =>
          Promise.resolve({
            fileId: "lamp",
            content: {
              environment: {},
              objectTree: [],
              logs: [],
              readMe: "mine",
              adapter: "other",
              connected: true,
              liveRead: "read",
              extra: 1,
            },
          }),
      }),
    );
    const { job } = jobs.start("lamp") as { job: string };
    await settle();
    const report = JSON.parse((jobs.result(job) as { content: string }).content);
    expect(report).toMatchObject({ adapter: "iobroker.demo", connected: false, liveRead: "not connected", extra: 1 });
    expect(report.readMe).not.toBe("mine");
  });

  it("puts the frame at the top of the file, before what the adapter adds", async () => {
    // krobi 2026-10-20: the part that says which adapter, version and runtime the report is from belongs at the start
    const jobs = new ReportJobs(source([{ id: "lamp", connected: false }]));
    const { job } = jobs.start("lamp") as { job: string };
    await settle();
    const keys = Object.keys(JSON.parse((jobs.result(job) as { content: string }).content));
    expect(keys.slice(0, 7)).toEqual([
      "readMe",
      "adapter",
      "version",
      "exportedAt",
      "runtime",
      "connected",
      "liveRead",
    ]);
    expect(keys.indexOf("device")).toBeGreaterThan(6);
  });

  it("says every block once: a later copy points to its first place (krobi 2026-10-20)", async () => {
    // krobi 2026-10-20 00:46, for every adapter with a report: no fixed text and no content twice
    const scenes = Array.from({ length: 5 }, (_, i) => ({ name: `Scene ${i}`, value: i }));
    const jobs = new ReportJobs(
      source([{ id: "lamp", connected: false }], {
        build: () =>
          Promise.resolve({
            fileId: "lamp",
            content: {
              environment: {},
              objectTree: [],
              logs: [],
              scenes,
              cache: { scenes: [...scenes], "a/b~c": scenes },
              host: { node: process.version, platform: `${process.platform} ${process.arch}` },
              small: [{ on: true }, { on: true }],
            },
          }),
      }),
    );
    const { job } = jobs.start("lamp") as { job: string };
    await settle();
    const report = JSON.parse((jobs.result(job) as { content: string }).content);
    expect(report.scenes).toEqual(scenes);
    expect(report.cache).toEqual({ scenes: { sameAs: "/scenes" }, "a/b~c": { sameAs: "/scenes" } });
    // the frame comes first, so a body copy of a frame block points to the frame, never the other way round
    expect(report.host).toEqual({ sameAs: "/runtime" });
    expect(report.runtime).toEqual({ node: process.version, platform: `${process.platform} ${process.arch}` });
    // a pointer longer than the block it replaces would make the file longer: such a copy stays
    expect(report.small).toEqual([{ on: true }, { on: true }]);
  });

  it("writes a pointer to a key with a slash or a tilde the way RFC 6901 escapes it", () => {
    const block = { text: "a block long enough for a pointer" };
    expect(onceEach({ "a/b~c": { inner: block }, again: block })).toEqual({
      "a/b~c": { inner: block },
      again: { sameAs: "/a~1b~0c/inner" },
    });
    expect(onceEach([block, [block]])).toEqual([block, [{ sameAs: "/0" }]]);
    expect(onceEach("plain")).toBe("plain");
    expect(onceEach(undefined)).toBeUndefined();
    expect(onceEach({ at: new Date("2026-10-20T00:46:00Z"), gone: undefined })).toEqual({
      at: "2026-10-20T00:46:00.000Z",
    });
  });

  it("says what the live read did (DB-02)", async () => {
    const said = async (connected: boolean, readLive: ReportSource<string>["readLive"]): Promise<unknown> => {
      const jobs = new ReportJobs(source([{ id: "lamp", connected }], { readLive }));
      const { job } = jobs.start("lamp") as { job: string };
      await settle();
      return JSON.parse((jobs.result(job) as { content: string }).content).liveRead;
    };
    expect(await said(true, () => Promise.resolve("answer"))).toBe("read");
    expect(await said(true, () => Promise.resolve(undefined as unknown as string))).toBe("nothing");
    expect(await said(true, () => Promise.resolve(null as unknown as string))).toBe("nothing");
    expect(await said(true, () => Promise.reject(new Error("connect ECONNREFUSED 192.168.1.20:80")))).toBe("failed");
    expect(await said(false, () => Promise.resolve("answer"))).toBe("not connected");
  });

  it("names the file after the body's placeholder, never the raw device id (DB-04, DB-12)", async () => {
    const jobs = new ReportJobs(
      source([{ id: "kueche", connected: true }], {
        build: () =>
          Promise.resolve({
            fileId: "name-1",
            content: { environment: {}, objectTree: [], logs: [], device: "name-1" },
          }),
      }),
      () => Date.parse("2026-10-08T05:00:00Z"),
    );
    const { job } = jobs.start("kueche") as { job: string };
    await settle();
    const report = jobs.result(job) as { fileName: string; content: string };
    expect(report.fileName).toBe("demo_name-1_v1.0.0_2026-10-08_050000.json");
    expect(report.fileName + report.content).not.toContain("kueche");
  });

  it("drops a finished report nobody fetched after REPORT_KEEP_MS", async () => {
    let t = 0;
    const jobs = new ReportJobs(source([{ id: "lamp", connected: true }]), () => t);
    const { job } = jobs.start("lamp") as { job: string };
    await settle();
    t = REPORT_KEEP_MS + 1;
    expect(await jobs.handle({ action: "result", job })).toEqual({ gone: true });
  });

  it("stops: no message starts a job, and a report being made ends without its file and log line", async () => {
    // round 165 (govee 2026-10-31): four reports were finished through TERMINATE, then the host killed the process
    const later = <T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
    // stopped during the live read: the body is never built
    const read = later<string>();
    const src = source([{ id: "lamp", connected: true }], { readLive: () => read.promise });
    let jobs = new ReportJobs(src);
    const { job } = jobs.start("lamp") as { job: string };
    jobs.stop();
    read.resolve("live answer");
    await settle();
    expect(src.build).not.toHaveBeenCalled();
    expect(jobs.result(job)).toEqual({ gone: true });
    expect(await jobs.handle({ action: "list" })).toEqual({ error: "the adapter is stopping — no report" });
    expect(await jobs.handle({ action: "start", device: "lamp" })).toEqual({
      error: "the adapter is stopping — no report",
    });
    expect(jobs.start("lamp")).toEqual({ error: "the adapter is stopping — no report" });
    // stopped while the body is built: no file, no "ready" line
    const built = later<ReportBody>();
    const src2 = source([{ id: "lamp", connected: false }], { build: () => built.promise });
    jobs = new ReportJobs(src2);
    jobs.start("lamp");
    jobs.stop();
    built.resolve({ fileId: "lamp", content: { environment: {}, objectTree: [], logs: [] } });
    await settle();
    expect(src2.log.info).not.toHaveBeenCalled();
    // a body that fails after the stop is no warning either
    const broken = later<never>();
    const src3 = source([{ id: "lamp", connected: false }], { build: () => broken.promise });
    jobs = new ReportJobs(src3);
    jobs.start("lamp");
    jobs.stop();
    broken.reject(new Error("closed"));
    await settle();
    expect(src3.log.warn).not.toHaveBeenCalled();
  });

  it("answers a second start while one is still being made with the same job", async () => {
    // round 157 (master audit M7): the guard that works is the public one — before, a cast reached a private branch
    // no caller could
    let release: (value: string) => void = () => undefined;
    const slow = new Promise<string>(resolve => {
      release = resolve;
    });
    const jobs = new ReportJobs(source([{ id: "lamp", connected: true }], { readLive: () => slow }));
    const first = jobs.start("lamp") as { job: string };
    expect(jobs.start("lamp")).toEqual(first);
    expect(jobs.result(first.job)).toEqual({ pending: true });
    release("done");
    await settle();
    expect(jobs.result(first.job)).toHaveProperty("fileName");
  });
});

// Round 157 (master audit M44): each half of the report was tested against a hand-made stand-in of the other — the card's
// API now talks to the real jobs, so a drift in the device list, `pending`, the report or an error is red here.
describe("the card's API on the real jobs", () => {
  it("lists the devices, makes a report and hands an error on", async () => {
    const jobs = new ReportJobs(source([{ id: "lamp", label: "Lamp", connected: false }]));
    const api = makeDiagnosticsApi({ sendTo: (_i, _c, data) => jobs.handle(data) }, "demo.0", {
      listMs: 1_000,
      exportMs: 5_000,
      pollMs: 1,
    });
    expect(await api.listDevices()).toEqual(jobs.list());
    expect(jobs.list()).toHaveLength(1);
    const report = await api.exportReport("lamp");
    expect(isReport(report) && report.fileName).toMatch(/^demo_lamp_v1\.0\.0_/);
    expect(await api.exportReport("nope")).toEqual({ error: "unknown device 'nope'" });
  });
});
