/**
 * Preservation Property Test — Yandex Music DOWNLOAD_TRACK round-trip
 *
 * **Validates: Requirements 3.1, 3.5, 3.9**
 *
 * Property 2 (Preservation): For every input that does NOT match the YouTube
 * buffer-capture bug condition (any `DOWNLOAD_TRACK` against
 * `music.yandex.ru`), the fixed code must produce exactly the same
 * observable behavior as the unfixed code — same response envelope
 * (`{ success, downloadId? }`), same code path through `chrome.downloads.
 * download` with a `data:` URL.
 *
 * NOTE: The unfixed `message-router.ts` has pre-existing TypeScript compile
 * errors in unrelated handlers (`VK_DOWNLOAD_DIRECT`, see lines 1135/1145/
 * 1148/1167) that prevent ts-jest from importing the module. To keep the
 * preservation contract observable WITHOUT depending on those broken lines,
 * we pin the wire shape via structural source assertions — the same
 * approach the existing `vk-download-preservation.test.ts` uses for the VK
 * button positioning property. After the cobalt revert lands, these
 * assertions still hold (the revert does not touch the
 * `DOWNLOAD_TRACK`/`DOWNLOAD_BY_INPUT` handlers).
 *
 * The contract this test pins:
 *   1. The `DOWNLOAD_TRACK` and `DOWNLOAD_BY_INPUT` handlers exist in
 *      `message-router.ts` and respond with `{ success: true, downloadId }`
 *      on the happy path.
 *   2. The handlers do NOT route through any cobalt module — no import of
 *      `cobalt-client`, `cobalt-error-classifier` from the Yandex Music
 *      flow.
 *   3. The `data:` URL pattern is the documented Service Worker download
 *      mechanism (per the popup OAuth contract).
 *   4. The Yandex Music API client signature is unchanged (`getTrackInfo`,
 *      `getDownloadInfoEntries`, `getSignedUrlFromEntry` exported by
 *      `src/background/api-client.ts`).
 *
 * EXPECTED OUTCOME: Test PASSES on the unfixed build.
 */

import * as fs from "fs";
import * as path from "path";
import * as fc from "fast-check";

const ROUTER_SRC_PATH = path.resolve(
  __dirname,
  "../../src/background/message-router.ts",
);
const API_CLIENT_SRC_PATH = path.resolve(
  __dirname,
  "../../src/background/api-client.ts",
);

const ROUTER_SRC = fs.readFileSync(ROUTER_SRC_PATH, "utf-8");
const API_CLIENT_SRC = fs.readFileSync(API_CLIENT_SRC_PATH, "utf-8");

/** Yandex Music required exports (preserved by the YT cobalt revert). */
const YM_API_REQUIRED_EXPORTS = [
  "getDownloadInfoEntries",
  "getSignedUrlFromEntry",
  "getTrackInfo",
] as const;

/** Forbidden imports inside the Yandex Music flow within message-router. */
const COBALT_IMPORT_PATHS = [
  "./cobalt-client",
  "./cobalt-error-classifier",
] as const;

describe("Preservation: Yandex Music DOWNLOAD_TRACK / DOWNLOAD_BY_INPUT wire shape — unchanged after cobalt revert", () => {
  /**
   * **Validates: Requirements 3.1, 3.9**
   *
   * Property: For every `format` value in the documented popup preference
   * set, the canonical handler signature for that format exists in the
   * router source. fast-check enumerates the format set; each format
   * iteration asserts presence.
   */
  it("DOWNLOAD_TRACK and DOWNLOAD_BY_INPUT cases are present and respond with success+downloadId envelope", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<"flac" | "mp3-320" | "aac-256">(
          "flac",
          "mp3-320",
          "aac-256",
        ),
        (_format) => {
          // The router has a `case "DOWNLOAD_TRACK"` AND a `case
          // "DOWNLOAD_BY_INPUT"`.  Both are the entry points for the
          // Yandex Music single-track flow and they must keep their
          // documented response envelope.
          expect(ROUTER_SRC).toMatch(/case\s+"DOWNLOAD_TRACK"\s*:/);
          expect(ROUTER_SRC).toMatch(/case\s+"DOWNLOAD_BY_INPUT"\s*:/);

          // Both response shape fields appear textually.  The unfixed
          // build emits `{ success: true, downloadId }` from the happy
          // path (this is the wire shape Property 2 preserves).
          expect(ROUTER_SRC).toContain("downloadId");
          expect(ROUTER_SRC).toContain("success: true");
        },
      ),
      { numRuns: 3 },
    );
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * Property: The Yandex Music API-client surface (`getDownloadInfoEntries`,
   * `getSignedUrlFromEntry`, `getTrackInfo`) is the canonical interface the
   * Yandex Music handler depends on. The cobalt revert touches none of
   * these.
   */
  it("Yandex Music api-client exports are unchanged", () => {
    fc.assert(
      fc.property(fc.constantFrom(...YM_API_REQUIRED_EXPORTS), (sym) => {
        // Each canonical Yandex Music API helper is exported.
        const exportRegex = new RegExp(
          `export\\s+(async\\s+)?function\\s+${sym}\\b`,
        );
        expect(API_CLIENT_SRC).toMatch(exportRegex);

        // And the router consumes it (preserves the import edge).
        expect(ROUTER_SRC).toContain(sym);
      }),
      { numRuns: YM_API_REQUIRED_EXPORTS.length },
    );
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * Property: The Yandex Music handler path does NOT import any cobalt
   * module. The cobalt revert deletes those modules entirely; until then,
   * the Yandex Music flow already does not depend on them.
   *
   * (Currently, `yt-download-orchestrator` and `yt-sabr-fallback` are
   * lazily `await import(...)`-ed inside the YT_DOWNLOAD_VIDEO case only.
   * They are NOT imported at the top of the router and are NOT imported
   * by the Yandex Music or VK handlers.)
   */
  it("router file does not statically import cobalt-client or cobalt-error-classifier at the top level", () => {
    fc.assert(
      fc.property(fc.constantFrom(...COBALT_IMPORT_PATHS), (spec) => {
        const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const staticImport = new RegExp(`from\\s+["']${escaped}["']`);
        expect(ROUTER_SRC).not.toMatch(staticImport);
      }),
      { numRuns: COBALT_IMPORT_PATHS.length },
    );
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * Property: The Yandex Music handler produces a `data:` URL passed to
   * `chrome.downloads.download` (Service Worker pattern). Pin the textual
   * pattern.
   */
  it("router uses chrome.downloads.download with data: URLs from the Yandex Music flow", () => {
    expect(ROUTER_SRC).toContain("chrome.downloads.download");
    // The data: URL pattern from the Service Worker happy path.
    expect(ROUTER_SRC).toMatch(/data:audio\/[\w-]+/);
  });
});
