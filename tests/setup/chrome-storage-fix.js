/**
 * Patch jest-webextension-mock's chrome.storage to match real Chrome behavior.
 *
 * The mock (v3.9.1) has a long-standing bug where `chrome.storage.local.get(key)`
 * returns `{ key: value }` (literal "key" property) instead of `{ [key]: value }`.
 * Real Chrome returns `{ [key]: value }`. This patch makes the mock match real
 * Chrome so production code can use the standard pattern
 * `(await chrome.storage.local.get(KEY))[KEY]` in both production and tests.
 *
 * The patch replaces each storage area's `get` method with a correct
 * implementation that reads from the same backing store the original mock uses
 * via its `set` method. Since we cannot access the internal `store` directly,
 * we install our own backing store and rewire `set`, `get`, `remove`, and
 * `clear` to use it.
 */

function installCorrectStorageMock(area) {
  const store = {};

  const resolveKey = (key) => {
    if (typeof key === "string") {
      return key in store ? { [key]: store[key] } : {};
    }
    if (Array.isArray(key)) {
      return key.reduce((acc, k) => Object.assign(acc, resolveKey(k)), {});
    }
    if (key !== null && typeof key === "object") {
      // Defaults form: { key1: defaultValue1, ... }
      return Object.entries(key).reduce((acc, [k, fallback]) => {
        acc[k] = k in store ? store[k] : fallback;
        return acc;
      }, {});
    }
    throw new Error("Wrong key given");
  };

  area.get = jest.fn((id, cb) => {
    const result = id == null ? { ...store } : resolveKey(id);
    if (cb !== undefined) return cb(result);
    return Promise.resolve(result);
  });

  area.set = jest.fn((payload, cb) => {
    Object.keys(payload).forEach((k) => {
      store[k] = payload[k];
    });
    if (cb !== undefined) return cb();
    return Promise.resolve();
  });

  area.remove = jest.fn((id, cb) => {
    const keys = typeof id === "string" ? [id] : id;
    keys.forEach((k) => delete store[k]);
    if (cb !== undefined) return cb();
    return Promise.resolve();
  });

  area.clear = jest.fn((cb) => {
    Object.keys(store).forEach((k) => delete store[k]);
    if (cb !== undefined) return cb();
    return Promise.resolve();
  });
}

if (typeof chrome !== "undefined" && chrome.storage) {
  ["local", "sync", "session", "managed"].forEach((name) => {
    if (chrome.storage[name]) {
      installCorrectStorageMock(chrome.storage[name]);
    }
  });
}
