import { describe, expect, it, vi } from "vitest";
import {
  REPORT_COOLDOWN_MS,
  REPORT_KEEP_MS,
  ReportJobs,
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
        content: { device: id, ...(live ? { live } : {}), ...(liveError ? { liveError } : {}) },
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
    const gone = (jobs as unknown as { make(id: string): Promise<unknown> }).make("lamp");
    expect(await gone).toEqual({ error: "unknown device 'lamp'" });
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
    expect(plug.job).not.toBe(first.job);
    await settle();
    t = 10 * REPORT_COOLDOWN_MS;
    const again = jobs.start("lamp") as { job: string };
    expect(again.job).not.toBe(first.job);
    await settle();
  });

  it("keeps every frame field when the body names the same key (DB-06)", async () => {
    const jobs = new ReportJobs(
      source([{ id: "lamp", connected: false }], {
        build: () =>
          Promise.resolve({
            fileId: "lamp",
            content: { readMe: "mine", adapter: "other", connected: true, liveRead: "read", extra: 1 },
          }),
      }),
    );
    const { job } = jobs.start("lamp") as { job: string };
    await settle();
    const report = JSON.parse((jobs.result(job) as { content: string }).content);
    expect(report).toMatchObject({ adapter: "iobroker.demo", connected: false, liveRead: "not connected", extra: 1 });
    expect(report.readMe).not.toBe("mine");
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
        build: () => Promise.resolve({ fileId: "name-1", content: { device: "name-1" } }),
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

  it("refuses a second report while one is still being made", async () => {
    let release: (value: string) => void = () => undefined;
    const slow = new Promise<string>(resolve => {
      release = resolve;
    });
    const jobs = new ReportJobs(source([{ id: "lamp", connected: true }], { readLive: () => slow }));
    jobs.start("lamp");
    const busy = (jobs as unknown as { make(id: string): Promise<unknown> }).make("lamp");
    expect(await busy).toEqual({ error: "a report for this device is being made right now — try again in a moment" });
    release("done");
    await settle();
  });
});
