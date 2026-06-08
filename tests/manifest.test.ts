// Unit tests for manifest.json validation.
// Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
// Feature: yandex-music-downloader

// Use require() because tsconfig.json does not enable resolveJsonModule
// and rootDir is "src", which would otherwise prevent importing manifest.json.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const manifest = require("../manifest.json") as {
  manifest_version: number;
  permissions: string[];
  host_permissions: string[];
  background: { service_worker: string; type: string };
  content_scripts: Array<{
    matches: string[];
    js: string[];
    run_at: string;
  }>;
};

describe("manifest.json", () => {
  test("manifest_version equals 3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  test("permissions includes downloads, cookies, storage, tabs", () => {
    expect(Array.isArray(manifest.permissions)).toBe(true);
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["downloads", "cookies", "storage", "tabs"])
    );
  });

  test("host_permissions is an array with each entry starting with https://", () => {
    expect(Array.isArray(manifest.host_permissions)).toBe(true);
    expect(manifest.host_permissions.length).toBeGreaterThan(0);
    for (const entry of manifest.host_permissions) {
      expect(typeof entry).toBe("string");
      expect(entry.startsWith("https://")).toBe(true);
    }
  });

  test("host_permissions includes Yandex Music and CDN hosts", () => {
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining([
        "https://music.yandex.ru/*",
        "https://*.mds.yandex.net/*",
        "https://*.music.yandex.net/*",
      ])
    );
  });

  test("background.service_worker is set and points to a .js file", () => {
    expect(manifest.background).toBeDefined();
    expect(typeof manifest.background.service_worker).toBe("string");
    expect(manifest.background.service_worker.length).toBeGreaterThan(0);
    expect(manifest.background.service_worker.endsWith(".js")).toBe(true);
  });

  test('background.type is "module"', () => {
    expect(manifest.background.type).toBe("module");
  });

  test("content_scripts first entry has matches, non-empty js, and run_at: document_idle", () => {
    expect(Array.isArray(manifest.content_scripts)).toBe(true);
    expect(manifest.content_scripts.length).toBeGreaterThan(0);

    const first = manifest.content_scripts[0];
    expect(Array.isArray(first.matches)).toBe(true);
    expect(first.matches).toEqual(
      expect.arrayContaining(["https://music.yandex.ru/*"])
    );

    expect(Array.isArray(first.js)).toBe(true);
    expect(first.js.length).toBeGreaterThan(0);

    expect(first.run_at).toBe("document_idle");
  });
});
