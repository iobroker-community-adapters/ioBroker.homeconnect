import { afterEach, describe, expect, it } from "vitest";
import { forgetLastTab } from "./tabMemory";

const TABS = ["_main", "_expert"];

describe("forgetLastTab", () => {
  afterEach(() => {
    delete (window as unknown as { _localStorage?: unknown })._localStorage;
    localStorage.clear();
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
    (window as unknown as { _localStorage: unknown })._localStorage = {
      getItem: (k: string) => store[k] ?? null,
      removeItem: (k: string) => delete store[k],
    };
    forgetLastTab("demo.0", TABS);
    expect(store).toEqual({ "Other.demo": "_expert" });
  });

  it("skips an index the storage has no key or no value for", () => {
    const store: Record<string, string> = { "App.demo": "_expert" };
    (window as unknown as { _localStorage: unknown })._localStorage = {
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
    (window as unknown as { _localStorage: unknown })._localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
    };
    expect(() => forgetLastTab("demo.0", TABS)).not.toThrow();
  });
});
