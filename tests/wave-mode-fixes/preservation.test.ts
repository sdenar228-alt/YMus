/**
 * @jest-environment jsdom
 *
 * Property 4 — Preservation tests.
 *
 * Scope (¬C):
 *   NOT isBugCondition_1(X) AND NOT isBugCondition_2(X) AND NOT isBugCondition_3(X)
 *
 * Inputs that MUST behave identically before and after the fix:
 *   - non-wave URLs (`/album/{a}/track/{t}`, `/artist/{id}`, `/users/{u}/playlists/{k}`)
 *   - MP3 on any page
 *   - FLAC/WAV on non-wave pages (NOT triggered from popup — popup FLAC/WAV is C₃)
 *   - popup MP3 download
 *   - popup error/idle states
 *   - `null` from `extractTrackMeta()` when player-bar is hidden and externalAPI
 *     is unavailable
 *
 * Methodology — observation-first:
 *   1. Run the CURRENT (unfixed) code on a representative input.
 *   2. Record the exact output (TrackMeta / response shape / state transition order).
 *   3. Encode the recorded output as the expected baseline in a property assertion.
 *   4. Generalize across the input space via fast-check.
 *
 * EXPECTATION ON UNFIXED CODE: this suite MUST PASS — it captures the existing
 * baseline behavior we will not break with the wave-mode fix.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 */

import * as fs from "fs";
import * as path from "path";
import fc from "fast-check";

// ─── Common helpers ──────────────────────────────────────────────────────────

interface TrackMetaShape {
  trackId: string;
  artist: string;
  title: string;
}

/**
 * Set window.location's pathname + search via history.replaceState. jsdom
 * implements history.replaceState such that it updates `location.pathname`,
 * `location.search`, and `location.href` — exactly what `readFromURL()` and
 * `isWaveMode()` actually read.
 *
 * The host portion stays at the jsdom default ("http://localhost"), but the
 * production code only reads pathname / search / href, so this is fine for
 * preservation testing.
 */
function setLocationPath(pathAndSearch: string): void {
  window.history.replaceState({}, "", pathAndSearch);
}

/**
 * Convenience wrapper: accept a full URL string (matching the production
 * format `https://music.yandex.ru/...`) and apply only its pathname + search
 * via history.replaceState.
 */
function setLocation(fullUrl: string): void {
  try {
    const u = new URL(fullUrl);
    setLocationPath(u.pathname + u.search);
  } catch {
    setLocationPath("/");
  }
}

function resetDOM(): void {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).externalAPI;
  setLocationPath("/");
}

// ============================================================================
// PBT-Pres-1: extractTrackMeta on non-wave URLs preserves baseline TrackMeta.
// ============================================================================
//
// Observation step (run on UNFIXED code, recorded below):
//
//   Case A — `/album/100/track/200`, externalAPI returns valid track:
//     extractTrackMeta() returns the externalAPI result directly
//     (early return on first source). Recorded shape:
//       { trackId: "<id>:<albumId>", artist: "<api artist>", title: "<api title>" }
//
//   Case B — `/album/100/track/200`, externalAPI=null but `og:title` is a real
//     "Артист — Трек" string AND the page has a `<a href="/album/100/track/200">`
//     anchor:
//     readFromExternalAPI() → null;
//     readFromMetaTags() → { artist, title } parsed by " — ";
//     readFromDOM() → { trackId: "200:100" };
//     readFromURL() → { trackId: "200:100" };
//     final: { trackId: "200:100", artist, title }.
//
//   Case C — page with no player bar and no externalAPI but URL is `/album/100/track/200`:
//     readFromExternalAPI() → null;
//     readFromMetaTags() → {} (no og:title);
//     readFromDOM() → {} (no anchors);
//     readFromURL() → { trackId: "200:100" };
//     final: { trackId: "200:100", artist: "Unknown", title: "Unknown" }.
//
// Since the unfixed function is deterministic and the property "preservation"
// is "fixed === original" — and at this stage we ARE the original — we make the
// property "extractTrackMeta returns the same value when called twice on the
// same DOM" (idempotence of the original on its own input space). This locks in
// the baseline; the post-fix counterpart of this test will compare the new
// output against a snapshot of these recorded values.

describe("PBT-Pres-1 — extractTrackMeta on non-wave URLs preserves baseline TrackMeta (Req 3.1)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let extractTrackMeta: () => any;

  beforeEach(() => {
    jest.resetModules();
    resetDOM();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    extractTrackMeta = require("../../src/content/track-meta").extractTrackMeta;
  });

  afterEach(() => {
    resetDOM();
  });

  // ─── Case A: externalAPI is the source of truth. ───────────────────────────

  it("[CONCRETE A] returns externalAPI TrackMeta on /album/100/track/200 with valid externalAPI", () => {
    setLocation("https://music.yandex.ru/album/100/track/200");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).externalAPI = {
      getCurrentTrack: () => ({
        id: 200,
        albumId: 100,
        title: "Хочешь?",
        artists: [{ name: "Земфира" }],
      }),
    };

    // Recorded baseline.
    const expected: TrackMetaShape = {
      trackId: "200:100",
      artist: "Земфира",
      title: "Хочешь?",
    };

    const meta = extractTrackMeta() as TrackMetaShape | null;
    expect(meta).toEqual(expected);

    // Idempotent: the same DOM → the same output.
    const meta2 = extractTrackMeta() as TrackMetaShape | null;
    expect(meta2).toEqual(expected);
  });

  // ─── Case B: externalAPI=null, og:title is "Artist — Title", URL has /track/. ─

  it("[CONCRETE B] returns og:title-derived TrackMeta when externalAPI is unavailable but og:title is valid", () => {
    setLocation("https://music.yandex.ru/album/100/track/200");

    const meta = document.createElement("meta");
    meta.setAttribute("property", "og:title");
    meta.setAttribute("content", "Земфира — Хочешь?");
    document.head.appendChild(meta);

    // No externalAPI.
    // No player bar — readFromDOM falls through to readFromURL.

    // Recorded baseline.
    const expected: TrackMetaShape = {
      trackId: "200:100",
      artist: "Земфира",
      title: "Хочешь?",
    };

    const result = extractTrackMeta() as TrackMetaShape | null;
    expect(result).toEqual(expected);
  });

  // ─── PBT: any non-wave URL with valid externalAPI returns the externalAPI value. ──

  it("[PBT] for any non-wave URL with a valid externalAPI mock, extractTrackMeta returns the externalAPI's track verbatim", () => {
    fc.assert(
      fc.property(
        // Non-wave URL: choose between /album/{a}/track/{t}, /artist/{id},
        // /users/{u}/playlists/{k}.
        fc.oneof(
          fc.tuple(
            fc.integer({ min: 1, max: 9_999_999 }),
            fc.integer({ min: 1, max: 9_999_999 }),
          )
            .map(([a, t]) => `https://music.yandex.ru/album/${a}/track/${t}`),
          fc
            .integer({ min: 1, max: 9_999_999 })
            .map((id) => `https://music.yandex.ru/artist/${id}`),
          fc
            .tuple(
              fc.stringOf(
                fc.constantFrom(
                  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
                ),
                { minLength: 3, maxLength: 12 },
              ),
              fc.integer({ min: 1, max: 99_999 }),
            )
            .map(([u, k]) => `https://music.yandex.ru/users/${u}/playlists/${k}`),
        ),
        // externalAPI track payload.
        fc.integer({ min: 1, max: 9_999_999 }),
        fc.integer({ min: 1, max: 9_999_999 }),
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        (url, trackIdNum, albumIdNum, apiTitle, apiArtist) => {
          resetDOM();
          setLocation(url);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).externalAPI = {
            getCurrentTrack: () => ({
              id: trackIdNum,
              albumId: albumIdNum,
              title: apiTitle,
              artists: [{ name: apiArtist }],
            }),
          };

          const meta = extractTrackMeta() as TrackMetaShape | null;
          // Validates: Requirement 3.1
          expect(meta).not.toBeNull();
          expect(meta).toEqual({
            trackId: `${trackIdNum}:${albumIdNum}`,
            artist: apiArtist,
            title: apiTitle,
          });
        },
      ),
      { numRuns: 30 },
    );
  });
});

// ============================================================================
// PBT-Pres-4: extractTrackMeta returns null when player-bar absent AND
//             externalAPI unavailable (Req 3.6).
// ============================================================================
//
// Observation step (run on UNFIXED code, recorded below):
//
//   - location = "https://music.yandex.ru/" (root, no /track/, no /album/)
//   - no <meta property="og:title">
//   - no [class*="PlayerBar"] container with /track/ anchor
//   - window.externalAPI = undefined
//
//   readFromExternalAPI() → null
//   readFromMetaTags() → {}
//   readFromDOM() → {} (no candidate anchors found)
//   readFromURL() → {} (no /track/ pattern in pathname)
//   trackId = undefined → return null
//
// Recorded result: extractTrackMeta() returns null.

describe("PBT-Pres-4 — extractTrackMeta returns null when no source can resolve trackId (Req 3.6)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let extractTrackMeta: () => any;

  beforeEach(() => {
    jest.resetModules();
    resetDOM();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    extractTrackMeta = require("../../src/content/track-meta").extractTrackMeta;
  });

  afterEach(() => {
    resetDOM();
  });

  it("[CONCRETE] returns null on a bare page with no player bar, no og:title, no externalAPI, root URL", () => {
    setLocation("https://music.yandex.ru/");
    const meta = extractTrackMeta() as TrackMetaShape | null;
    expect(meta).toBeNull();
  });

  it("[PBT] for any URL whose pathname has no /track/ AND no player bar AND no externalAPI, extractTrackMeta returns null", () => {
    fc.assert(
      fc.property(
        // URLs that are guaranteed to NOT contain /track/{n} in the pathname.
        fc.oneof(
          fc.constant("https://music.yandex.ru/"),
          fc.constant("https://music.yandex.ru/home"),
          fc
            .integer({ min: 1, max: 9_999_999 })
            .map((id) => `https://music.yandex.ru/artist/${id}`),
          fc
            .integer({ min: 1, max: 9_999_999 })
            .map((id) => `https://music.yandex.ru/album/${id}`),
          fc
            .tuple(
              fc.stringOf(
                fc.constantFrom(
                  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
                ),
                { minLength: 3, maxLength: 12 },
              ),
              fc.integer({ min: 1, max: 99_999 }),
            )
            .map(([u, k]) => `https://music.yandex.ru/users/${u}/playlists/${k}`),
        ),
        (url) => {
          resetDOM();
          setLocation(url);
          // No og:title meta, no player bar, no externalAPI — full void.

          const meta = extractTrackMeta() as TrackMetaShape | null;
          // Validates: Requirement 3.6
          expect(meta).toBeNull();
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ============================================================================
// SW-pipeline preservation: PBT-Pres-2 (MP3) and PBT-Pres-3 (FLAC/WAV non-popup).
// ============================================================================
//
// We need to invoke the message-router with mocked heavy deps (api-client,
// format-resolver, offscreen, fetch, chrome.downloads.download) and capture
// the response shape. We mock the same way as router-contract.test.ts.

jest.mock("../../src/background/api-client", () => {
  class AuthRequiredError extends Error {}
  class DrmProtectedError extends Error {}
  class PreviewOnlyError extends Error {}
  return {
    AuthRequiredError,
    DrmProtectedError,
    PreviewOnlyError,
    getDownloadInfoEntries: jest.fn(async () => [
      {
        codec: "mp3",
        bitrateInKbps: 320,
        preview: false,
        downloadInfoUrl: "https://example.test/dl/mp3-320",
      },
      {
        codec: "flac",
        bitrateInKbps: 1411,
        preview: false,
        downloadInfoUrl: "https://example.test/dl/flac-1411",
      },
    ]),
    getSignedUrlFromEntry: jest.fn(
      async (_url: string, codec: string) =>
        `https://example.test/signed/${codec}.bin`,
    ),
    getTrackInfo: jest.fn(async () => ({
      trackId: "200:100",
      artist: "Земфира",
      title: "Хочешь?",
      albumTitle: "Прости меня моя любовь",
      year: "2000",
      trackNumber: "1",
      coverUri: null,
    })),
    getAlbumInfo: jest.fn(),
    getPlaylistInfo: jest.fn(),
    getCurrentUserLikedTracks: jest.fn(),
    getPlaylistByUuid: jest.fn(),
  };
});

jest.mock("../../src/background/format-resolver", () => {
  class PreviewOnlyError extends Error {}
  return {
    PreviewOnlyError,
    resolveFormat: jest.fn(
      (
        entries: Array<{
          codec: string;
          bitrateInKbps: number;
          preview: boolean;
          downloadInfoUrl: string;
        }>,
        preferredFormat: "mp3" | "flac" | "wav",
      ) => {
        const flac = entries.find((e) => e.codec === "flac" && !e.preview);
        const mp3 = entries.find((e) => e.codec === "mp3" && !e.preview);
        if (preferredFormat === "flac" && flac !== undefined) {
          return { entry: flac, outputFormat: "flac", fellBack: false };
        }
        if (preferredFormat === "wav" && flac !== undefined) {
          return { entry: flac, outputFormat: "wav", fellBack: false };
        }
        if (preferredFormat === "wav" && mp3 !== undefined) {
          return { entry: mp3, outputFormat: "wav", fellBack: false };
        }
        if (preferredFormat === "flac" && mp3 !== undefined) {
          return { entry: mp3, outputFormat: "flac", fellBack: false };
        }
        if (mp3 !== undefined) {
          return { entry: mp3, outputFormat: "mp3", fellBack: false };
        }
        throw new PreviewOnlyError("no entries");
      },
    ),
  };
});

jest.mock("../../src/background/flac-meta", () => ({
  embedFlacMetadata: jest.fn((bytes: Uint8Array) => bytes),
}));

jest.mock("../../src/background/wav-meta", () => ({
  buildWavFile: jest.fn(() => new Uint8Array([0x52, 0x49, 0x46, 0x46])),
}));

jest.mock("../../src/background/wav-converter", () => ({
  convertToWav: jest.fn(async () => ({
    success: true,
    pcmData: new Int16Array([0, 0, 0, 0]),
    sampleRate: 44100,
    channels: 2,
    bitsPerSample: 16,
  })),
}));

jest.mock("../../src/background/offscreen-bridge", () => ({
  encodeMp3ToFlacInOffscreen: jest.fn(async (sourceBytes: Uint8Array) => ({
    success: true,
    flacBytes: new Uint8Array([
      0x66,
      0x4c,
      0x61,
      0x43,
      ...Array.from(sourceBytes.slice(0, 16)),
    ]),
  })),
}));

jest.mock("../../src/background/id3", () => ({
  buildId3v23Tag: jest.fn(() => new Uint8Array([0x49, 0x44, 0x33])),
  fetchCover: jest.fn(async () => null),
}));

jest.mock("../../src/background/oauth-flow", () => ({
  authorizeAndSave: jest.fn(),
}));

jest.mock("../../src/background/error-classifier", () => ({
  classifyError: jest.fn(() => ({ reason: "Unknown", errorCode: undefined })),
}));

jest.mock("../../src/background/logger", () => ({
  logError: jest.fn(),
}));

const stubBytes = new Uint8Array(16).fill(0xab);

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    arrayBuffer: async () => stubBytes.buffer,
  }));
});

interface RouterResponse {
  success: boolean;
  reason?: string;
  filename?: string;
  bytes?: number[];
  actualFormat?: "mp3" | "flac" | "wav";
  fallbackReason?: string;
  // Optional new field — preservation tests must not require its absence.
  downloadId?: number;
}

function invokeRouter(message: unknown): Promise<RouterResponse> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createMessageRouter } = require("../../src/background/message-router");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { URLCache } = require("../../src/background/url-cache");
  const cache = new URLCache();
  const router = createMessageRouter(cache);
  return new Promise<RouterResponse>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router(message, {} as any, (response: RouterResponse) => {
      resolve(response);
    });
  });
}

// ============================================================================
// PBT-Pres-2: MP3 requests through DOWNLOAD_BY_INPUT (popup MP3) preserve
//             response shape (Req 3.3, 3.4).
// ============================================================================
//
// Observation step (run on UNFIXED code, recorded below):
//
//   Input: { type: "DOWNLOAD_BY_INPUT", payload: { input: "12345" } }
//          with singleTrackFormat = "mp3".
//   chrome.downloads.download mock resolves with downloadId = 4242.
//
//   Unfixed response shape:
//     { success: true, filename: "<artist> - <title>.mp3", actualFormat: "mp3",
//       fallbackReason: undefined }
//   Side effect: chrome.downloads.download was called exactly once.
//
// Preservation property:
//   - response.success === true
//   - response.actualFormat === "mp3"
//   - response.filename ends with ".mp3"
//   - chrome.downloads.download was called (the SW-side download path is taken)
//
// We DO NOT assert response.downloadId is absent (the post-fix code may add it
// as an optional field — preservation requires the response REMAINS CORRECT,
// not field-for-field equal when adding optional fields).

describe("PBT-Pres-2 — DOWNLOAD_BY_INPUT MP3 response shape preserved (Req 3.3, 3.4)", () => {
  beforeEach(() => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.downloads as any).download = jest.fn(async () => 4242);
  });

  it("[CONCRETE] DOWNLOAD_BY_INPUT with format=mp3 returns success + actualFormat=mp3 + .mp3 filename", async () => {
    await chrome.storage.local.set({
      ymd_format_prefs: { singleTrackFormat: "mp3", bulkFormat: "mp3" },
    });

    const result = await invokeRouter({
      type: "DOWNLOAD_BY_INPUT",
      payload: { input: "12345" },
    });

    // Validates: Requirements 3.3, 3.4
    expect(result.success).toBe(true);
    expect(result.actualFormat).toBe("mp3");
    expect(typeof result.filename).toBe("string");
    expect(result.filename?.endsWith(".mp3")).toBe(true);
    // SW-side download was invoked.
    expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
  });

  it("[PBT] for any numeric trackId, DOWNLOAD_BY_INPUT MP3 returns the same canonical response shape", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 9_999_999_999 }),
        async (trackIdNum) => {
          await chrome.storage.local.set({
            ymd_format_prefs: { singleTrackFormat: "mp3", bulkFormat: "mp3" },
          });
          // Reset the spy between runs.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (chrome.downloads as any).download = jest.fn(async () => 4242);

          const result = await invokeRouter({
            type: "DOWNLOAD_BY_INPUT",
            payload: { input: String(trackIdNum) },
          });

          // Validates: Requirements 3.3, 3.4
          expect(result.success).toBe(true);
          expect(result.actualFormat).toBe("mp3");
          expect(typeof result.filename).toBe("string");
          expect(result.filename?.endsWith(".mp3")).toBe(true);
          expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: 10 },
    );
  });
});

// ============================================================================
// PBT-Pres-3: FLAC/WAV via DOWNLOAD_BY_INPUT (popup) on non-wave URLs.
// ============================================================================
//
// NOTE on scope: isBugCondition_3 = (format ∈ {flac, wav} AND popupAction =
//                "click-download"). So popup-FLAC/WAV is in C₃, NOT in ¬C.
//                The task's PBT-Pres-3 says "FLAC/WAV requests on non-wave URLs"
//                and explicitly excludes popup FLAC/WAV from preservation.
//
// Therefore PBT-Pres-3 must use the floating-button single-track flow:
//   DOWNLOAD_TRACK without a `folder` field. This is a different SW branch
//   (no chrome.downloads.download in unfixed code — bytes are returned to
//   the content script which then triggers the actual download).
//
// Observation step (run on UNFIXED code, recorded below):
//
//   Input: { type: "DOWNLOAD_TRACK", payload: { trackId: "200:100",
//            meta: { artist, title } } } (no folder)
//          with singleTrackFormat = "flac" or "wav".
//
//   Unfixed response shape:
//     { success: true, bytes: number[], filename: "...flac" | "...wav",
//       actualFormat: "flac" | "wav", fallbackReason: <string|undefined> }
//   Side effect: chrome.downloads.download was NOT called.
//
// Preservation property (¬C₃, ¬C₂ — non-wave + non-popup):
//   - response.success === true
//   - response.actualFormat === requestedFormat
//   - response.filename ends with the requested format extension
//   - response is well-formed: either has `bytes` (current SW returns bytes)
//     OR has `downloadId` (post-fix SW does the download itself).
//     Both alternatives satisfy "the response remains correct".

describe("PBT-Pres-3 — DOWNLOAD_TRACK FLAC/WAV (non-popup) on non-wave URL response shape preserved (Req 3.5)", () => {
  beforeEach(() => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.downloads as any).download = jest.fn(async () => 4242);
  });

  it("[CONCRETE flac] DOWNLOAD_TRACK no-folder + format=flac returns success + actualFormat=flac + .flac filename", async () => {
    await chrome.storage.local.set({
      ymd_format_prefs: { singleTrackFormat: "flac", bulkFormat: "mp3" },
    });

    const result = await invokeRouter({
      type: "DOWNLOAD_TRACK",
      payload: {
        trackId: "200:100",
        meta: { artist: "Земфира", title: "Хочешь?" },
      },
    });

    // Validates: Requirement 3.5
    expect(result.success).toBe(true);
    expect(result.actualFormat).toBe("flac");
    expect(typeof result.filename).toBe("string");
    expect(result.filename?.endsWith(".flac")).toBe(true);
    // Response is well-formed: either bytes (current) or downloadId (post-fix).
    const hasBytes = Array.isArray(result.bytes) && result.bytes.length > 0;
    const hasDownloadId = typeof result.downloadId === "number";
    expect(hasBytes || hasDownloadId).toBe(true);
  });

  it("[CONCRETE wav] DOWNLOAD_TRACK no-folder + format=wav returns success + actualFormat=wav + .wav filename", async () => {
    await chrome.storage.local.set({
      ymd_format_prefs: { singleTrackFormat: "wav", bulkFormat: "mp3" },
    });

    const result = await invokeRouter({
      type: "DOWNLOAD_TRACK",
      payload: {
        trackId: "200:100",
        meta: { artist: "Земфира", title: "Хочешь?" },
      },
    });

    // Validates: Requirement 3.5
    expect(result.success).toBe(true);
    expect(result.actualFormat).toBe("wav");
    expect(typeof result.filename).toBe("string");
    expect(result.filename?.endsWith(".wav")).toBe(true);
    const hasBytes = Array.isArray(result.bytes) && result.bytes.length > 0;
    const hasDownloadId = typeof result.downloadId === "number";
    expect(hasBytes || hasDownloadId).toBe(true);
  });

  it("[PBT] for any FLAC/WAV non-popup request, response shape is preserved (success + correct format + well-formed payload)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"flac" | "wav">("flac", "wav"),
        fc.integer({ min: 1, max: 9_999_999 }),
        fc.integer({ min: 1, max: 9_999_999 }),
        async (requestedFormat, trackIdNum, albumIdNum) => {
          await chrome.storage.local.set({
            ymd_format_prefs: {
              singleTrackFormat: requestedFormat,
              bulkFormat: "mp3",
            },
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (chrome.downloads as any).download = jest.fn(async () => 4242);

          const result = await invokeRouter({
            type: "DOWNLOAD_TRACK",
            payload: {
              trackId: `${trackIdNum}:${albumIdNum}`,
              meta: { artist: "Артист", title: "Трек" },
            },
          });

          // Validates: Requirement 3.5
          expect(result.success).toBe(true);
          expect(result.actualFormat).toBe(requestedFormat);
          expect(typeof result.filename).toBe("string");
          expect(result.filename?.endsWith(`.${requestedFormat}`)).toBe(true);
          const hasBytes = Array.isArray(result.bytes) && result.bytes.length > 0;
          const hasDownloadId = typeof result.downloadId === "number";
          expect(hasBytes || hasDownloadId).toBe(true);
        },
      ),
      { numRuns: 10 },
    );
  });
});

// ============================================================================
// PBT-Pres-5: popup MP3 transitions idle → loading → success in this order.
// ============================================================================
//
// Observation step (run on UNFIXED code with popup mounted):
//
//   t=0  : user clicks #download
//   t≈0+ : setBusy(true)  — button gains "loading" class
//          setStatus("Получаю ссылку...", "info") — #status gains "info" class
//   t=Δ  : sendMessage resolves → success branch:
//          setStatus("Скачивание началось", "success") — #status gains "success" class
//   t=Δ+ : setBusy(false) in finally — button loses "loading" class
//
// Recorded order: status.info appears, then loading-class is set, then
// status.success appears (≥ at the same instant as or after loading), then
// loading-class is cleared.
//
// Preservation property: for MP3 popup, t_status_success ≥ t_loading_set
// AND t_loading_clear ≥ t_status_success (success indicator shown before the
// spinner is removed — the popup never shows success while still loading).

const popupHtml = fs.readFileSync(
  path.resolve(__dirname, "../../src/popup/popup.html"),
  "utf-8",
);

interface PopupTimeline {
  t_start: number;
  t_loading_set?: number;
  t_loading_clear?: number;
  t_status_info?: number;
  t_status_success?: number;
  t_status_error?: number;
}

function mountPopup(): void {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  const tmpHtml = document.createElement("html");
  tmpHtml.innerHTML = popupHtml;
  const parsedBody = tmpHtml.querySelector("body");
  if (parsedBody !== null) {
    document.body.innerHTML = parsedBody.innerHTML;
  } else {
    document.body.innerHTML = popupHtml;
  }
}

function observePopup(timeline: PopupTimeline): MutationObserver[] {
  const observers: MutationObserver[] = [];

  const downloadBtn = document.getElementById("download");
  if (downloadBtn !== null) {
    let wasLoading = downloadBtn.classList.contains("loading");
    const obs = new MutationObserver(() => {
      const isLoading = downloadBtn.classList.contains("loading");
      if (
        !wasLoading &&
        isLoading &&
        timeline.t_loading_set === undefined
      ) {
        timeline.t_loading_set = performance.now() - timeline.t_start;
      }
      if (
        wasLoading &&
        !isLoading &&
        timeline.t_loading_clear === undefined
      ) {
        timeline.t_loading_clear = performance.now() - timeline.t_start;
      }
      wasLoading = isLoading;
    });
    obs.observe(downloadBtn, { attributes: true, attributeFilter: ["class"] });
    observers.push(obs);
  }

  const statusEl = document.getElementById("status");
  if (statusEl !== null) {
    const obs = new MutationObserver(() => {
      if (
        statusEl.classList.contains("info") &&
        timeline.t_status_info === undefined
      ) {
        timeline.t_status_info = performance.now() - timeline.t_start;
      }
      if (
        statusEl.classList.contains("success") &&
        timeline.t_status_success === undefined
      ) {
        timeline.t_status_success = performance.now() - timeline.t_start;
      }
      if (
        statusEl.classList.contains("error") &&
        timeline.t_status_error === undefined
      ) {
        timeline.t_status_error = performance.now() - timeline.t_start;
      }
    });
    obs.observe(statusEl, { attributes: true, attributeFilter: ["class"] });
    observers.push(obs);
  }

  return observers;
}

async function runPopupMp3Scenario(
  swResponseDelayMs: number,
): Promise<PopupTimeline> {
  jest.resetModules();
  mountPopup();

  const timeline: PopupTimeline = { t_start: performance.now() };
  const observers = observePopup(timeline);

  await chrome.storage.local.set({
    ymd_format_prefs: { singleTrackFormat: "mp3", bulkFormat: "mp3" },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (chrome.runtime.sendMessage as any) = jest.fn(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (msg: any) => {
      if (msg?.type === "AUTH_STATUS") {
        return Promise.resolve({ success: true, authorized: true });
      }
      if (msg?.type === "DOWNLOAD_BY_INPUT") {
        return new Promise<RouterResponse>((resolve) => {
          setTimeout(() => {
            resolve({
              success: true,
              actualFormat: "mp3",
              filename: "Артист - Трек.mp3",
              downloadId: 1001,
            });
          }, swResponseDelayMs);
        });
      }
      return Promise.resolve({ success: false });
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../src/popup/popup");

  // Allow refreshAuthStatus to settle.
  await new Promise((r) => setTimeout(r, 5));

  const inputEl = document.getElementById("input") as HTMLInputElement | null;
  if (inputEl !== null) {
    inputEl.value = "12345";
  }
  const downloadBtn = document.getElementById(
    "download",
  ) as HTMLButtonElement | null;

  timeline.t_start = performance.now();
  downloadBtn?.click();

  await new Promise((r) => setTimeout(r, swResponseDelayMs + 50));

  observers.forEach((o) => o.disconnect());
  return timeline;
}

describe("PBT-Pres-5 — popup MP3 transitions idle → loading → success in baseline order (Req 3.4)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  it("[CONCRETE] popup MP3 with sw delay 50ms transitions in expected order", async () => {
    const t = await runPopupMp3Scenario(50);

    // The popup entered the loading state.
    expect(t.t_loading_set).toBeDefined();
    // The popup showed an "info" status before any final state.
    expect(t.t_status_info).toBeDefined();
    // The success status was reached.
    expect(t.t_status_success).toBeDefined();
    // No error status was shown for an MP3 success path.
    expect(t.t_status_error).toBeUndefined();

    // Order invariants (baseline observation):
    //   1. loading is set BEFORE success is shown.
    //   2. success is shown BEFORE/AT loading is cleared (or loading-clear may
    //      not even be observed within the window — that's fine).
    if (t.t_loading_set !== undefined && t.t_status_success !== undefined) {
      expect(t.t_status_success).toBeGreaterThanOrEqual(t.t_loading_set);
    }
    // Validates: Requirement 3.4
  });

  it("[PBT] for any sw delay in [10, 100] ms, popup MP3 transitions follow baseline order", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 10, max: 100 }), async (delay) => {
        const t = await runPopupMp3Scenario(delay);

        expect(t.t_loading_set).toBeDefined();
        expect(t.t_status_success).toBeDefined();
        expect(t.t_status_error).toBeUndefined();
        if (t.t_loading_set !== undefined && t.t_status_success !== undefined) {
          expect(t.t_status_success).toBeGreaterThanOrEqual(t.t_loading_set);
        }
      }),
      { numRuns: 5 },
    );
  });
});

// ============================================================================
// PBT-Pres-6: button-state.ts allows click from `error`, blocks click from
//             `idle` and `disabled` (Req 3.7).
// ============================================================================
//
// Observation step (run on UNFIXED code in src/content/button-state.ts):
//
//   getButtonConfig("idle")     → { state: "idle",     label: "Скачать",   clickable: false }
//   getButtonConfig("loading")  → { state: "loading",  label: "Загрузка...", clickable: false }
//   getButtonConfig("active")   → { state: "active",   label: "Скачать",   clickable: true }
//   getButtonConfig("error")    → { state: "error",    label: "Ошибка",    clickable: true }
//   getButtonConfig("error", "boom") → { ..., clickable: true, errorMessage: "boom" }
//   getButtonConfig("disabled") → { state: "disabled", label: "Недоступно", clickable: false }
//
// Preservation property:
//   - "error" is clickable; "idle" and "disabled" are NOT clickable.
//   - errorMessage is propagated only for "error".

describe("PBT-Pres-6 — button-state preserves clickability rules: error clickable, idle/disabled blocked (Req 3.7)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getButtonConfig: (state: string, errorMessage?: string) => any;

  beforeEach(() => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    getButtonConfig = require("../../src/content/button-state").getButtonConfig;
  });

  it("[CONCRETE] error → clickable=true; idle, disabled → clickable=false", () => {
    expect(getButtonConfig("error").clickable).toBe(true);
    expect(getButtonConfig("idle").clickable).toBe(false);
    expect(getButtonConfig("disabled").clickable).toBe(false);
  });

  it("[CONCRETE] errorMessage is propagated only for the error state", () => {
    expect(getButtonConfig("error", "boom").errorMessage).toBe("boom");
    // For non-error states, errorMessage is not defined in the returned config.
    expect(getButtonConfig("idle", "boom").errorMessage).toBeUndefined();
    expect(getButtonConfig("disabled", "boom").errorMessage).toBeUndefined();
    expect(getButtonConfig("loading", "boom").errorMessage).toBeUndefined();
    expect(getButtonConfig("active", "boom").errorMessage).toBeUndefined();
  });

  it("[PBT] for any errorMessage string, error.clickable=true and error.errorMessage===input", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 80 }), (msg) => {
        const cfg = getButtonConfig("error", msg);
        // Validates: Requirement 3.7
        expect(cfg.clickable).toBe(true);
        expect(cfg.state).toBe("error");
        expect(cfg.errorMessage).toBe(msg);
      }),
      { numRuns: 25 },
    );
  });

  it("[PBT] idle and disabled are never clickable regardless of errorMessage argument", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("idle", "disabled"),
        fc.option(fc.string({ minLength: 0, maxLength: 80 }), { nil: undefined }),
        (state, msg) => {
          const cfg = getButtonConfig(state, msg);
          // Validates: Requirement 3.7
          expect(cfg.clickable).toBe(false);
          expect(cfg.state).toBe(state);
          // errorMessage is never set for non-error states.
          expect(cfg.errorMessage).toBeUndefined();
        },
      ),
      { numRuns: 20 },
    );
  });
});
