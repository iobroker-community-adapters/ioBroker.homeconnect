// Fleet master (.consistency-master/src-admin/src/tabMemory.ts) — never edit the copy in an adapter.
//
// Settings always open on the first tab "Configuration" (krobi 2026-10-06 19:11, GV-07 as fleet standard).

/** What the tab memory is kept in: a real Storage, or the admin's server-synced object without enumeration. */
type TabMemoryStorage = Pick<Storage, "getItem" | "removeItem"> & Partial<Pick<Storage, "length" | "key">>;

/**
 * Forget which tab was open last, so the next visit to the instance settings starts on the first tab.
 *
 * The admin's json-config remembers the last tab per adapter (Admin 8.0.12 / json-config 10.0.0, `ConfigTabs`): every
 * tab switch writes `localStorage["<dialogName || 'App'>.<adapter>"]`, and the dialog opens on that entry whenever the
 * URL names no tab — which a fresh open never does. A component on every tab but the first calls this when it mounts
 * (the tab is entered, after that write) and when it unmounts (the settings close).
 *
 * With "store GUI settings on the server", `window._localStorage` is a plain object with getItem / setItem /
 * removeItem only (no `length`, no `key()`), so the known key is asked for directly; the enumeration only covers a
 * real Storage. Only this adapter's entries holding one of its own tab ids are touched.
 *
 * @param namespace the instance, e.g. `demo.0`
 * @param tabIds the tab ids of the adapter's `admin/jsonConfig.json`
 */
export function forgetLastTab(namespace: string, tabIds: readonly string[]): void {
  const adapterName = namespace.split(".")[0];
  const own = new Set(tabIds);
  try {
    const w = window as Window & { _localStorage?: TabMemoryStorage };
    const storage: TabMemoryStorage = w._localStorage ?? window.localStorage;
    const stale = new Set<string>();
    const known = `App.${adapterName}`;
    if (own.has(storage.getItem(known) ?? "")) {
      stale.add(known);
    }
    if (typeof storage.length === "number" && typeof storage.key === "function") {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.endsWith(`.${adapterName}`) && own.has(storage.getItem(key) ?? "")) {
          stale.add(key);
        }
      }
    }
    // Collect first, then remove — deleting while indexing skips entries.
    for (const key of stale) {
      storage.removeItem(key);
    }
  } catch {
    // Storage blocked (private window, disabled site data): nothing to forget.
  }
}
