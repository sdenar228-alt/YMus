/**
 * Manifest static test — youtube-buffer-capture-revert (Task 5.2)
 *
 * **Validates: Requirements 2.1, 2.10, 3.9**
 *
 * After Task 3.9 ships, `manifest.json` MUST encode the legacy buffer-capture
 * pipeline's surface area:
 *
 *   1. `host_permissions` contains `https://*.googlevideo.com/*` so the
 *      MAIN-world bridge can observe `videoplayback` responses on
 *      `*.googlevideo.com`.
 *   2. `host_permissions` does NOT contain the offline self-hosted cobalt
 *      instance (`https://ymuslink.duckdns.org/*`) nor any of the public
 *      cobalt mirrors (`cobalt-api.ayo.tf`, `cobalt-api.luver.pw`,
 *      `cobapi.elrant.team`).  None of the cobalt host strings may appear
 *      anywhere in the serialized manifest.
 *   3. `content_scripts` declares two YouTube entries:
 *        a. `yt-page-bridge.js`  → `world: "MAIN"`,    `run_at: "document_start"`
 *        b. `yt-content.js`      → (isolated world),    `run_at: "document_idle"`
 *      Both entries match `https://www.youtube.com/watch*` AND
 *      `https://www.youtube.com/shorts/*`.
 *      The MAIN-world bridge entry is listed BEFORE the isolated-world
 *      content-script entry (otherwise the bridge misses the early
 *      `videoplayback` responses).
 *   4. Yandex Music + VK content-script entries and host_permissions are
 *      untouched by the revert — sanity check that this surgical change
 *      did not collaterally damage unrelated services.
 *
 * Property-based tests use `fast-check` to assert the same predicate over
 * every required entry / host (one iteration per item, equivalent to a
 * universally-quantified set membership check) so a missing entry surfaces
 * as a counterexample.
 */

import * as fc from "fast-check";

// `tsconfig.json` does not enable `resolveJsonModule` for the source build,
// but `jest.config.js` injects a per-test tsconfig that does — `require()`
// keeps this test compatible with both code paths and matches the existing
// `tests/manifest.test.ts` style.
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
    world?: string;
  }>;
};

// ─── Constants ──────────────────────────────────────────────────────────────

const YT_GOOGLEVIDEO_HOST = "https://*.googlevideo.com/*";

const YT_WATCH_MATCH = "https://www.youtube.com/watch*";
const YT_SHORTS_MATCH = "https://www.youtube.com/shorts/*";

const FORBIDDEN_COBALT_HOSTS = [
  "https://ymuslink.duckdns.org/*",
  "https://cobalt-api.ayo.tf/*",
  "https://cobalt-api.luver.pw/*",
  "https://cobapi.elrant.team/*",
] as const;

const FORBIDDEN_COBALT_SUBSTRINGS = [
  "ymuslink.duckdns.org",
  "cobalt-api.ayo.tf",
  "cobalt-api.luver.pw",
  "cobapi.elrant.team",
] as const;

// Sanity-set: Yandex Music + VK entries that must survive the revert.
const PRESERVED_HOSTS = [
  "https://music.yandex.ru/*",
  "https://*.music.yandex.ru/*",
  "https://*.mds.yandex.net/*",
  "https://*.music.yandex.net/*",
  "https://oauth.yandex.ru/*",
  "https://vk.com/*",
  "https://*.vk.com/*",
  "https://*.userapi.com/*",
] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function findContentScript(
  predicate: (e: (typeof manifest.content_scripts)[number]) => boolean,
) {
  return manifest.content_scripts.find(predicate);
}

function isYtPageBridgeEntry(
  e: (typeof manifest.content_scripts)[number],
): boolean {
  return Array.isArray(e.js) && e.js.includes("yt-page-bridge.js");
}

function isYtContentEntry(
  e: (typeof manifest.content_scripts)[number],
): boolean {
  return Array.isArray(e.js) && e.js.includes("yt-content.js");
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("manifest.json — YouTube buffer-capture revert (Task 5.2)", () => {
  // ─── host_permissions ───────────────────────────────────────────────────

  /**
   * **Validates: Requirements 2.2, 2.10**
   *
   * The MAIN-world bridge intercepts `videoplayback` responses served from
   * `*.googlevideo.com`, so the host permission MUST be granted.
   */
  it("host_permissions contains https://*.googlevideo.com/*", () => {
    expect(Array.isArray(manifest.host_permissions)).toBe(true);
    expect(manifest.host_permissions).toContain(YT_GOOGLEVIDEO_HOST);
  });

  /**
   * **Validates: Requirements 2.1, 2.10**
   *
   * Property: ∀ host ∈ FORBIDDEN_COBALT_HOSTS, host ∉ host_permissions.
   *
   * The cobalt path is removed entirely; no cobalt host may be granted.
   */
  it("host_permissions does NOT contain any cobalt-style host", () => {
    fc.assert(
      fc.property(fc.constantFrom(...FORBIDDEN_COBALT_HOSTS), (host) => {
        expect(manifest.host_permissions).not.toContain(host);
      }),
      { numRuns: FORBIDDEN_COBALT_HOSTS.length },
    );
  });

  /**
   * **Validates: Requirements 2.1**
   *
   * Stronger negative check: no cobalt host substring appears ANYWHERE in
   * the serialized manifest — not in `host_permissions`, not in
   * `content_security_policy`, not buried in any other field. This catches
   * a regression where the host string is reintroduced in a surprise
   * location.
   */
  it("serialized manifest contains no cobalt-style host substring", () => {
    const serialized = JSON.stringify(manifest);
    fc.assert(
      fc.property(
        fc.constantFrom(...FORBIDDEN_COBALT_SUBSTRINGS),
        (badSubstring) => {
          expect(serialized).not.toContain(badSubstring);
        },
      ),
      { numRuns: FORBIDDEN_COBALT_SUBSTRINGS.length },
    );
  });

  // ─── content_scripts: yt-page-bridge.js (MAIN world, document_start) ────

  /**
   * **Validates: Requirements 2.2, 2.10**
   *
   * The bridge MUST run in MAIN at `document_start` so `window.fetch` is
   * patched BEFORE YouTube installs its own player handlers — anything later
   * misses the early `videoplayback` responses and produces an incomplete
   * captured buffer.
   */
  it("content_scripts has a yt-page-bridge.js entry with world MAIN at document_start", () => {
    const entry = findContentScript(isYtPageBridgeEntry);
    expect(entry).toBeDefined();
    expect(entry!.world).toBe("MAIN");
    expect(entry!.run_at).toBe("document_start");
  });

  /**
   * **Validates: Requirements 2.10, 3.2, 3.3**
   *
   * Both YouTube content-script entries must match BOTH `/watch*` and
   * `/shorts/*` so the legacy click flow works on either page type.
   */
  it("yt-page-bridge.js entry matches both /watch* and /shorts/*", () => {
    const entry = findContentScript(isYtPageBridgeEntry);
    expect(entry).toBeDefined();
    fc.assert(
      fc.property(
        fc.constantFrom(YT_WATCH_MATCH, YT_SHORTS_MATCH),
        (requiredMatch) => {
          expect(entry!.matches).toContain(requiredMatch);
        },
      ),
      { numRuns: 2 },
    );
  });

  // ─── content_scripts: yt-content.js (isolated world, document_idle) ─────

  /**
   * **Validates: Requirements 2.10, 3.2, 3.3**
   *
   * The isolated-world content script handles button injection, click
   * handling, and `chrome.runtime.sendMessage` — runs at `document_idle`
   * (the default) AFTER the player tree is mounted.
   */
  it("content_scripts has a yt-content.js entry at document_idle (isolated world)", () => {
    const entry = findContentScript(isYtContentEntry);
    expect(entry).toBeDefined();
    expect(entry!.run_at).toBe("document_idle");
    // Isolated world: `world` is either undefined or explicitly "ISOLATED".
    // The MV3 default is the isolated world, so YouTube content script
    // typically omits the `world` key.
    expect(
      entry!.world === undefined || entry!.world === "ISOLATED",
    ).toBe(true);
  });

  it("yt-content.js entry matches both /watch* and /shorts/*", () => {
    const entry = findContentScript(isYtContentEntry);
    expect(entry).toBeDefined();
    fc.assert(
      fc.property(
        fc.constantFrom(YT_WATCH_MATCH, YT_SHORTS_MATCH),
        (requiredMatch) => {
          expect(entry!.matches).toContain(requiredMatch);
        },
      ),
      { numRuns: 2 },
    );
  });

  // ─── Ordering: bridge BEFORE content script ─────────────────────────────

  /**
   * **Validates: Requirements 2.2, 2.10**
   *
   * The MAIN-world bridge entry MUST appear earlier in the array than the
   * isolated-world content-script entry. Chrome processes content_scripts
   * in declaration order, and a `document_start` MAIN-world entry that is
   * declared after a `document_idle` entry can lose the early-fetch race.
   */
  it("yt-page-bridge.js entry is listed BEFORE yt-content.js entry", () => {
    const bridgeIndex = manifest.content_scripts.findIndex(isYtPageBridgeEntry);
    const contentIndex = manifest.content_scripts.findIndex(isYtContentEntry);
    expect(bridgeIndex).toBeGreaterThanOrEqual(0);
    expect(contentIndex).toBeGreaterThanOrEqual(0);
    expect(bridgeIndex).toBeLessThan(contentIndex);
  });

  // ─── Sanity: Yandex Music + VK entries unchanged ────────────────────────

  /**
   * **Validates: Requirements 3.9**
   *
   * Property: ∀ host ∈ PRESERVED_HOSTS (Yandex Music + VK + OAuth),
   * host ∈ manifest.host_permissions.
   *
   * The revert must not collaterally damage unrelated services.
   */
  it("Yandex Music + VK + OAuth host_permissions are unchanged (sanity)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PRESERVED_HOSTS), (host) => {
        expect(manifest.host_permissions).toContain(host);
      }),
      { numRuns: PRESERVED_HOSTS.length },
    );
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * The Yandex Music page bridge keeps `world: "MAIN"` at `document_start`
   * with the canonical `ym-page-bridge.js` filename and the single
   * `https://music.yandex.ru/*` match.
   */
  it("Yandex Music ym-page-bridge.js content_scripts entry is unchanged", () => {
    const entry = findContentScript(
      (e) => Array.isArray(e.js) && e.js.includes("ym-page-bridge.js"),
    );
    expect(entry).toBeDefined();
    expect(entry!.matches).toEqual(["https://music.yandex.ru/*"]);
    expect(entry!.run_at).toBe("document_start");
    expect(entry!.world).toBe("MAIN");
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * The Yandex Music isolated-world content script keeps the canonical
   * `content.js` filename, single match, and `document_idle` run timing.
   */
  it("Yandex Music content.js content_scripts entry is unchanged", () => {
    const entry = findContentScript(
      (e) =>
        Array.isArray(e.js) &&
        e.js.includes("content.js") &&
        Array.isArray(e.matches) &&
        e.matches.length === 1 &&
        e.matches[0] === "https://music.yandex.ru/*",
    );
    expect(entry).toBeDefined();
    expect(entry!.run_at).toBe("document_idle");
    // No explicit world → isolated world (Chrome's default).
    expect(entry!.world).toBeUndefined();
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * VK content-script entries (`vk-content.js` isolated world,
   * `vk-page-bridge.js` MAIN world) keep their canonical shape.
   */
  it("VK content_scripts entries are unchanged (sanity)", () => {
    const vkContent = findContentScript(
      (e) =>
        Array.isArray(e.js) &&
        e.js.includes("vk-content.js") &&
        Array.isArray(e.matches) &&
        e.matches.length === 1 &&
        e.matches[0] === "https://vk.com/*",
    );
    expect(vkContent).toBeDefined();
    expect(vkContent!.run_at).toBe("document_idle");

    const vkPageBridge = findContentScript(
      (e) =>
        Array.isArray(e.js) &&
        e.js.includes("vk-page-bridge.js") &&
        Array.isArray(e.matches) &&
        e.matches.length === 1 &&
        e.matches[0] === "https://vk.com/*",
    );
    expect(vkPageBridge).toBeDefined();
    expect(vkPageBridge!.world).toBe("MAIN");
  });
});
