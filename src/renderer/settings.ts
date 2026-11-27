/**
 * The settings, kept in a file by the main process (settings.json, next to recent.json) instead of the page's own
 * localStorage: that's a database only one process can hold — a second YDDD open (another file, to copy between
 * them) waited ~4 s on a blank window for it, then ran with none of the settings and lost its changes. Only the first
 * YDDD open saves changes (the main process ignores the others'): another one starts with the saved settings, and what
 * it changes lasts until it closes. `localStorage` is replaced by this before anything reads it (imported first), so
 * the code using it is as it was. The first start without the file: the old localStorage settings copied into it.
 * Outside the app (no main process): localStorage.
 */
const api = window.yddd?.settings;
if (api) {
  let saved = api.load();
  if (!saved) {
    saved = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      saved[key] = localStorage.getItem(key)!;
      api.set(key, saved[key]);
    }
    // (the file made even with nothing to copy: localStorage isn't looked at again)
    if (!localStorage.length) api.set("yddd.settingsFile", "1");
  }
  const data = new Map(Object.entries(saved));
  const store = {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem(key: string, value: string) {
      value = String(value);
      if (data.get(key) === value) return;
      data.set(key, value);
      api.set(key, value);
    },
    removeItem(key: string) {
      if (data.delete(key)) api.set(key, null);
    },
    clear() {
      for (const key of [...data.keys()]) store.removeItem(key);
    },
  };
  Object.defineProperty(window, "localStorage", { value: store, configurable: true });
}
