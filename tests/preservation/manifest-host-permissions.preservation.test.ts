/**
 * Preservation Property Test — Manifest host_permissions for unrelated services
 *
 * **Validates: Requirements 3.9**
 *
 * Property 2 (Preservation): The cobalt revert touches ONLY YouTube-related
 * manifest entries. Yandex Music, VK, Yandex OAuth, and the chrome
 * `permissions` block (downloads / cookies / storage / tabs / identity /
 * offscreen / scripting / management / alarms) MUST stay byte-identical.
 *
 * The contract this test pins:
 *   1. Required Yandex Music host_permissions are present:
 *      `https://music.yandex.ru/*`, `https://*.music.yandex.ru/*`,
 *      `https://*.mds.yandex.net/*`, `https://*.music.yandex.net/*`.
 *   2. Required VK host_permissions are present:
 *      `https://vk.com/*`, `https://*.vk.com/*`, `https://*.userapi.com/*`.
 *   3. Required OAuth host: `https://oauth.yandex.ru/*`.
 *   4. The chrome `permissions` array contains at minimum:
 *      `downloads`, `cookies`, `storage`, `tabs`, `identity`, `offscreen`,
 *      `scripting`, `management`, `alarms`.
 *   5. No Yandex Music or VK content_scripts entry is touched (they remain
 *      with the same `matches`, `js`, `run_at`, and `world` fields).
 *
 * EXPECTED OUTCOME: Test PASSES on the unfixed build (baseline to preserve).
 */

import * as fc from "fast-check";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const manifest = require("../../manifest.json") as {
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

// ─── Required entries (Property 2: must NOT regress) ────────────────────────

const REQUIRED_HOST_PERMISSIONS_YANDEX = [
  "https://music.yandex.ru/*",
  "https://*.music.yandex.ru/*",
  "https://*.mds.yandex.net/*",
  "https://*.music.yandex.net/*",
  "https://oauth.yandex.ru/*",
] as const;

const REQUIRED_HOST_PERMISSIONS_VK = [
  "https://vk.com/*",
  "https://*.vk.com/*",
  "https://*.userapi.com/*",
] as const;

const REQUIRED_PERMISSIONS = [
  "downloads",
  "cookies",
  "storage",
  "tabs",
  "identity",
  "offscreen",
  "scripting",
  "management",
  "alarms",
] as const;

describe("Preservation: manifest.json — Yandex Music + VK + Yandex OAuth entries unchanged", () => {
  /**
   * **Validates: Requirements 3.9**
   *
   * Property: For every required Yandex Music or VK or OAuth host listed
   * above, it appears in `manifest.host_permissions`.
   *
   * Phrased as a property: ∀ host ∈ REQUIRED_*, host ∈ host_permissions.
   * fast-check picks one host per iteration and asserts its presence.
   */
  it("all required Yandex Music + VK + OAuth host_permissions are present", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          ...REQUIRED_HOST_PERMISSIONS_YANDEX,
          ...REQUIRED_HOST_PERMISSIONS_VK,
        ),
        (host) => {
          expect(manifest.host_permissions).toContain(host);
        },
      ),
      { numRuns: REQUIRED_HOST_PERMISSIONS_YANDEX.length +
                 REQUIRED_HOST_PERMISSIONS_VK.length },
    );
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * Property: ∀ p ∈ REQUIRED_PERMISSIONS, p ∈ manifest.permissions.
   */
  it("all required chrome.permissions are present", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REQUIRED_PERMISSIONS),
        (perm) => {
          expect(manifest.permissions).toContain(perm);
        },
      ),
      { numRuns: REQUIRED_PERMISSIONS.length },
    );
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * Property: The Yandex Music content_scripts entry has the canonical
   * shape `{ matches: ["https://music.yandex.ru/*"], js: [...], run_at: ... }`
   * and is NOT touched by the cobalt revert. We pin every observable field.
   */
  it("Yandex Music content_scripts entries are present and unchanged", () => {
    const ymPageBridge = manifest.content_scripts.find(
      (e) =>
        Array.isArray(e.matches) &&
        e.matches.length === 1 &&
        e.matches[0] === "https://music.yandex.ru/*" &&
        Array.isArray(e.js) &&
        e.js.includes("ym-page-bridge.js"),
    );
    expect(ymPageBridge).toBeDefined();
    expect(ymPageBridge!.run_at).toBe("document_start");
    expect(ymPageBridge!.world).toBe("MAIN");

    const ymContent = manifest.content_scripts.find(
      (e) =>
        Array.isArray(e.matches) &&
        e.matches.length === 1 &&
        e.matches[0] === "https://music.yandex.ru/*" &&
        Array.isArray(e.js) &&
        e.js.includes("content.js"),
    );
    expect(ymContent).toBeDefined();
    expect(ymContent!.run_at).toBe("document_idle");
    // No `world` field on the isolated-world entry.
    expect(ymContent!.world).toBeUndefined();
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * Property: VK content_scripts entries (vk-content.js + vk-page-bridge.js)
   * stay with the canonical shape from before the revert.
   */
  it("VK content_scripts entries are present and unchanged", () => {
    const vkContent = manifest.content_scripts.find(
      (e) =>
        Array.isArray(e.matches) &&
        e.matches.length === 1 &&
        e.matches[0] === "https://vk.com/*" &&
        Array.isArray(e.js) &&
        e.js.includes("vk-content.js"),
    );
    expect(vkContent).toBeDefined();
    expect(vkContent!.run_at).toBe("document_idle");

    const vkPageBridge = manifest.content_scripts.find(
      (e) =>
        Array.isArray(e.matches) &&
        e.matches.length === 1 &&
        e.matches[0] === "https://vk.com/*" &&
        Array.isArray(e.js) &&
        e.js.includes("vk-page-bridge.js"),
    );
    expect(vkPageBridge).toBeDefined();
    expect(vkPageBridge!.world).toBe("MAIN");
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * Property: `background.service_worker` and `background.type` keep their
   * documented values.
   */
  it("background service_worker + type unchanged", () => {
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.background.type).toBe("module");
  });

  /**
   * Negative property: Yandex Music + VK + OAuth host strings are
   * byte-stable across the revert. Done as a regex test so any variant
   * spelling (e.g. dropped subdomain wildcard) shows up as a failure.
   */
  it("no required Yandex / VK / OAuth host appears in a degraded form", () => {
    const serialized = JSON.stringify(manifest);

    // Each canonical host appears verbatim somewhere in the serialized
    // manifest.
    for (const host of [
      ...REQUIRED_HOST_PERMISSIONS_YANDEX,
      ...REQUIRED_HOST_PERMISSIONS_VK,
    ]) {
      expect(serialized).toContain(host);
    }

    // Forbidden degraded variants we must never introduce:
    const forbiddenVariants = [
      "http://music.yandex.ru",
      "https://music.yandex.ru/",
      "http://vk.com",
      "https://oauth.yandex.com/",
    ];
    for (const bad of forbiddenVariants) {
      // host_permissions strictly use the wildcard form ending in `/*`,
      // so the bare `https://music.yandex.ru/` (no wildcard) is forbidden.
      expect(manifest.host_permissions).not.toContain(bad);
    }
  });
});
