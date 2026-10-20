import { afterEach, describe, expect, it } from "vitest";
import { forgetLastTab } from "./tabMemory";

const TABS = ["_main", "_expert"];

describe("forgetLastTab", () => {
  // jsdom keeps the page's own storage in `window._localStorage` under vitest 5, the name the admin uses for its
  // server-synced storage: a test that stands in for the admin puts its object there, so the original value goes back
  // afterwards. Deleting it left `localStorage` without methods for every later test of the file (govee 2026-10-20).
  const page = window as unknown as { _localStorage?: unknown };
  const original = page._localStorage;
  afterEach(() => {
    page._localStorage = original;
    localStorage.clear();
  });

  it("stands in for the admin before the page storage is used, and leaves it working", () => {
    page._localStorage = { getItem: () => null, removeItem: () => undefined };
    expect(() => forgetLastTab("demo.0", TABS)).not.toThrow();
  });

  it("removes this adapter's remembered tab, and nothing else", () => {
    localStorage.setItem("App.demo", "_expert");
    localStorage.setItem("Other.demo", "_main");
    localStorage.setItem("App.other", "_expert");
    localStorage.setItem("App.demo-not", "_main");
    localStorage.setItem("Theme.demo", "dark");
    forgetLastTab("demo.0", TABS);
    expect(localStorage.getItem("App.demo")).toBeNull();
    expect(localStorage.getItem("Other.demo")).toBeNull();
    expect(localStorage.getItem("App.other")).toBe("_expert");
    expect(localStorage.getItem("App.demo-not")).toBe("_main");
    expect(localStorage.getItem("Theme.demo")).toBe("dark");
  });

  it("works with the admin's server-synced storage, which cannot be enumerated", () => {
    const store: Record<string, string> = { "App.demo": "_expert", "Other.demo": "_expert" };
    page._localStorage = {
      getItem: (k: string) => store[k] ?? null,
      removeItem: (k: string) => delete store[k],
    };
    forgetLastTab("demo.0", TABS);
    expect(store).toEqual({ "Other.demo": "_expert" });
  });

  it("skips an index the storage has no key or no value for", () => {
    const store: Record<string, string> = { "App.demo": "_expert" };
    page._localStorage = {
      length: 2,
      key: (i: number) => [null, "Gone.demo"][i],
      getItem: (k: string) => store[k] ?? null,
      removeItem: (k: string) => delete store[k],
    };
    forgetLastTab("demo.0", TABS);
    expect(store).toEqual({});
  });

  it("leaves a value that is no tab id of the adapter", () => {
    localStorage.setItem("App.demo", "somethingElse");
    forgetLastTab("demo.0", TABS);
    expect(localStorage.getItem("App.demo")).toBe("somethingElse");
  });

  it("gives up quietly when the storage is blocked", () => {
    page._localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
    };
    expect(() => forgetLastTab("demo.0", TABS)).not.toThrow();
  });
});
