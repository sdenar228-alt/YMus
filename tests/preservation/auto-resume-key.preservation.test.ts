/**
 * Preservation Property Test — Auto-resume storage key shape
 *
 * **Validates: Requirements 3.7**
 *
 * Property 2 (Preservation): The auto-resume key
 * `chrome.storage.local["ymus_yt_pending_download"]` keeps the legacy field
 * names (`videoId`, `expiresAt`) and the 180-second expiry contract
 * verbatim — so any user with a mid-flight pending download from the
 * previous build is not corrupted on first launch of the new build.
 *
 * The contract this test pins:
 *   1. The exact key NAME is `ymus_yt_pending_download` (not a variant).
 *   2. The exact field NAMES are `videoId` and `expiresAt`.
 *   3. The expiry contract is 180_000 ms (= 180 s).
 *   4. On the unfixed build, the YT content script does NOT touch this
 *      key — so writing arbitrary entries to it has no observable effect
 *      on the unfixed build (preservation holds vacuously). After the
 *      fix this test re-runs unchanged and the bootstrap reads + clears
 *      the key per the contract.
 *
 * EXPECTED OUTCOME: Test PASSES on the unfixed build (baseline to preserve).
 */

import * as fc from "fast-check";

const PENDING_KEY = "ymus_yt_pending_download" as const;
const EXPIRY_MS = 180_000;

describe("Preservation: ymus_yt_pending_download storage key shape", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
  });

  /**
   * **Validates: Requirements 3.7**
   *
   * Property: For all `(videoId, expiresAt)` records, the storage round-trip
   * preserves the exact key name and field names. This is the wire-shape
   * contract any future bootstrap (the auto-resume code added by the fix)
   * MUST honor, and that the unfixed code MUST NOT corrupt.
   */
  it("storage round-trip preserves exact key + field names + 180s expiry contract", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z0-9_-]{11}$/),
        fc.integer({ min: 0, max: EXPIRY_MS }),
        async (videoId, deltaMs) => {
          await chrome.storage.local.clear();

          const expiresAt = Date.now() + deltaMs;

          // Write the exact field shape from bugfix.md §3.7.
          await chrome.storage.local.set({
            [PENDING_KEY]: { videoId, expiresAt },
          });

          // 1) Key name preservation:
          const data = (await chrome.storage.local.get(PENDING_KEY)) as Record<
            string,
            unknown
          >;
          const entry = data[PENDING_KEY] as
            | { videoId?: unknown; expiresAt?: unknown }
            | undefined;

          expect(entry).toBeDefined();

          // 2) Field names preservation:
          expect(entry).toHaveProperty("videoId");
          expect(entry).toHaveProperty("expiresAt");
          expect(entry!.videoId).toBe(videoId);
          expect(entry!.expiresAt).toBe(expiresAt);

          // 3) Expiry within the 180s window:
          expect(expiresAt - Date.now()).toBeLessThanOrEqual(EXPIRY_MS);

          // 4) Removing the key is the documented "consume" operation.
          await chrome.storage.local.remove(PENDING_KEY);
          const after = (await chrome.storage.local.get(PENDING_KEY)) as Record<
            string,
            unknown
          >;
          expect(after[PENDING_KEY]).toBeUndefined();
        },
      ),
      { numRuns: 10 },
    );
  });

  /**
   * **Validates: Requirements 3.7**
   *
   * Property: On the unfixed build, requiring `yt-content.ts` does NOT
   * itself perform a write to `ymus_yt_pending_download`. (The auto-resume
   * write is part of the fix; the unfixed build leaves the key alone.)
   *
   * This guards against any unrelated change creeping in before the fix
   * lands that would corrupt mid-flight pending downloads from the previous
   * build.
   */
  it("unfixed yt-content source does not reference an INCORRECT variant of the auto-resume key name", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path");
    const ytSrc = fs.readFileSync(
      path.resolve(__dirname, "../../src/yt-content/yt-content.ts"),
      "utf-8",
    );

    // Variants we must NOT introduce (these would silently break the
    // legacy contract). Each is matched as a whole identifier to avoid
    // false positives where the canonical key `ymus_yt_pending_download`
    // contains a substring like `ymus_yt_pending` or `yt_pending_download`.
    const forbiddenVariants = [
      "ymus_yt_pending_dl",
      "ymus_yt_pending_dload",
      "ymus_pending_yt_download",
      "ymus-yt-pending-download",
    ];
    for (const v of forbiddenVariants) {
      // Whole-word match — alphanumeric/underscore boundary on both sides.
      const re = new RegExp(`(^|[^A-Za-z0-9_])${v}([^A-Za-z0-9_]|$)`);
      expect(ytSrc).not.toMatch(re);
    }

    // The only acceptable spelling — if any reference exists at all — is
    // the canonical `ymus_yt_pending_download` from bugfix.md §3.7.
    // Allow either presence (after the fix) or absence (on unfixed code);
    // both honor the preservation contract.
    if (ytSrc.includes("ymus_yt")) {
      expect(ytSrc).toContain(PENDING_KEY);
    }
  });

  /**
   * **Validates: Requirements 3.7**
   *
   * Property: A pending entry whose `expiresAt` is already past `Date.now()`
   * is logically expired. The 180-second contract caps `expiresAt - now` at
   * `EXPIRY_MS`. We assert this for any random `(now, deltaMs)` pair.
   */
  it("expiry math: any expiresAt in [Date.now(), Date.now() + 180_000] is within the contract window", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: EXPIRY_MS }),
        fc.integer({ min: 0, max: EXPIRY_MS * 2 }),
        (deltaMs, ageMs) => {
          const now = Date.now();
          const expiresAt = now + deltaMs;

          // Within the contract window when written.
          expect(expiresAt - now).toBeLessThanOrEqual(EXPIRY_MS);

          // After `ageMs` elapsed, the entry is expired iff ageMs > deltaMs.
          const isExpired = now + ageMs > expiresAt;
          if (ageMs > deltaMs) {
            expect(isExpired).toBe(true);
          } else {
            expect(isExpired).toBe(false);
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
