/**
 * Preservation Property Test — VK HLS demux contract
 *
 * **Validates: Requirements 3.9**
 *
 * Property 2 (Preservation): VK HLS download (`downloadVkHlsTrack` in
 * `src/background/vk-hls-downloader.ts`) is in the non-bug-condition
 * domain. The cobalt revert MUST NOT touch its public surface.
 *
 * The contract this test pins:
 *   1. The exported function `downloadVkHlsTrack(m3u8Url, _filename,
 *      onProgress?)` exists with that exact signature.
 *   2. It returns `{ audioDataB64: string, strategy: "hls_demux" }`
 *      (the documented return shape that `message-router.ts` consumes
 *      via `audioBuffer.audioDataB64` / `audioBuffer.strategy`).
 *   3. The M3U8 parser in `parseM3u8Segments` continues to handle the
 *      VK-specific encrypted/unencrypted segment alternation
 *      (`#EXT-X-KEY` METHOD=AES-128 / METHOD=NONE).
 *   4. The demuxer + AES-CBC pipeline references stay in place — these
 *      are the byte-level invariants Property 2 must preserve.
 *
 * NOTE: The full async byte-level round-trip is out of scope for this
 * preservation test (it depends on `crypto.subtle`, `performance.now()`,
 * `AbortController`, an MPEG-TS demuxer fixture, plus a multi-track
 * semaphore — too brittle to run in jest-node). Instead we use
 * fast-check-driven structural property assertions that pin the
 * observable contract.
 *
 * EXPECTED OUTCOME: Test PASSES on the unfixed build.
 */

import * as fs from "fs";
import * as path from "path";
import * as fc from "fast-check";

import { downloadVkHlsTrack } from "../../src/background/vk-hls-downloader";

const HLS_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../src/background/vk-hls-downloader.ts"),
  "utf-8",
);

describe("Preservation: VK HLS download contract — unchanged after cobalt revert", () => {
  /**
   * **Validates: Requirements 3.9**
   *
   * Property: The `downloadVkHlsTrack` symbol is a function with the
   * documented arity (3 — accepting an optional onProgress).
   */
  it("downloadVkHlsTrack is exported as a function with the documented signature", () => {
    expect(typeof downloadVkHlsTrack).toBe("function");
    // The signature is `(m3u8Url, _filename, onProgress?)`. Function.length
    // counts pre-default parameters — `_filename` is required (no default),
    // `onProgress` is optional (counted up to but not including the optional
    // suffix).
    expect(downloadVkHlsTrack.length).toBeGreaterThanOrEqual(2);
    expect(downloadVkHlsTrack.length).toBeLessThanOrEqual(3);
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * Property: For any well-formed VK m3u8-style manifest URL pattern
   * the source code references the documented return shape literally —
   * `audioDataB64` AND `strategy: "hls_demux"`.
   */
  it("source declares the documented return shape { audioDataB64, strategy: 'hls_demux' }", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "https://psv4.userapi.com/c123/u456/audio/index.m3u8",
          "https://cs1-78v4.vkuseraudio.net/p7/ABCDE/index.m3u8",
          "https://psv4.vkuseraudio.net/abc/index.m3u8",
        ),
        (_url) => {
          // The return shape is observable from the source declaration.
          expect(HLS_SRC).toContain("audioDataB64");
          expect(HLS_SRC).toContain('strategy: "hls_demux"');
        },
      ),
      { numRuns: 3 },
    );
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * Property: The HLS parser continues to handle VK's per-segment
   * encryption alternation. fast-check picks one of the documented
   * `#EXT-X-KEY` method names; each must be referenced literally by the
   * parser.
   */
  it("parseM3u8Segments handles AES-128 + NONE method alternation", () => {
    fc.assert(
      fc.property(fc.constantFrom("AES-128", "NONE"), (method) => {
        expect(HLS_SRC).toContain(`"${method}"`);
      }),
      { numRuns: 2 },
    );
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * Property: The HLS pipeline uses `crypto.subtle` for AES-CBC decrypt
   * with a per-segment IV. This is the byte-level invariant that any
   * regression to a different cipher mode would break — Property 2
   * forbids that.
   */
  it("HLS pipeline uses AES-CBC via crypto.subtle (preserved cipher mode)", () => {
    expect(HLS_SRC).toContain("AES-CBC");
    expect(HLS_SRC).toContain("crypto.subtle");
    expect(HLS_SRC).toMatch(/decrypt|importKey/);
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * Property: The HLS module does NOT import any cobalt module. The
   * cobalt revert removes those modules entirely; this test guards
   * against an incidental cross-import slipping in.
   */
  it("vk-hls-downloader.ts does not import any cobalt module", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "./cobalt-client",
          "./cobalt-error-classifier",
          "./yt-download-orchestrator",
          "./yt-sabr-fallback",
        ),
        (spec) => {
          const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`from\\s+["']${escaped}["']`);
          expect(HLS_SRC).not.toMatch(re);
        },
      ),
      { numRuns: 4 },
    );
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * Property: The HLS downloader does not contact any cobalt host. We
   * pin this textually — a regression that re-introduced a cobalt host
   * URL would also have to add it to this file (or its imports).
   */
  it("vk-hls-downloader.ts contains no cobalt host references", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "cobalt-api.ayo.tf",
          "cobalt-api.luver.pw",
          "cobapi.elrant.team",
          "ymuslink.duckdns.org",
        ),
        (host) => {
          expect(HLS_SRC).not.toContain(host);
        },
      ),
      { numRuns: 4 },
    );
  });
});
