/**
 * @jest-environment jsdom
 *
 * Bug 2 — Wave FLAC/WAV pipeline exploration test.
 *
 * Bug Condition (from design.md `isBugCondition_2`):
 *   isWaveMode(url) AND format ∈ {flac, wav}
 *
 * Expected behavior (Property 2, validates Requirements 2.3, 2.4):
 *   result.success === true
 *   AND typeof result.downloadId === "number"
 *   AND result.actualFormat === requestedFormat
 *
 * EXPECTATION ON UNFIXED CODE: this suite MUST FAIL.
 *
 * Why it fails on unfixed code (two reasons stack):
 *   1) extractTrackMeta() may return mangled meta on wave (Bug 1) but the
 *      trackId itself is extractable from the player-bar DOM, so the SW
 *      pipeline IS invoked with a valid trackId.
 *   2) The unfixed `DOWNLOAD_TRACK` handler (no-folder branch in
 *      src/background/message-router.ts) responds with
 *         { success: true, bytes: number[], filename, actualFormat, fallbackReason }
 *      and DOES NOT include `downloadId`. The SW never calls
 *      `chrome.downloads.download()` itself in that branch — it returns
 *      the bytes for the content script to handle. Therefore
 *      `typeof result.downloadId === "number"` is FALSE on unfixed code.
 *
 * Documented counterexamples (recorded after running this test on unfixed code):
 *   [CONCRETE flac]  DOWNLOAD_TRACK (no folder) for FLAC returned
 *                    { success: true, bytes: [...], filename: "...flac",
 *                      actualFormat: "flac" } — `downloadId` is undefined.
 *   [CONCRETE wav]   DOWNLOAD_TRACK (no folder) for WAV returned
 *                    { success: true, bytes: [...], filename: "...wav",
 *                      actualFormat: "wav" } — `downloadId` is undefined.
 *   [PBT]            fast-check shrunk to ["flac", 1, 1] — i.e. even for the
 *                    smallest plausible trackId/albumId pair, the SW response
 *                    omits `downloadId`. Confirms the SW never invokes
 *                    `chrome.downloads.download()` on the no-folder branch.
 */

import fc from "fast-check";

// ─── Mock all heavy SW dependencies BEFORE importing message-router ───────────

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
  // Real-ish behaviour: pick the entry matching the preferred format.
  // For FLAC preference and a flac entry available, return flac; for WAV,
  // prefer the flac entry as source.
  return {
    PreviewOnlyError,
    resolveFormat: jest.fn(
      (
        entries: Array<{ codec: string; bitrateInKbps: number; preview: boolean; downloadInfoUrl: string }>,
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
    flacBytes: new Uint8Array([0x66, 0x4c, 0x61, 0x43, ...Array.from(sourceBytes.slice(0, 16))]),
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

// ─── Mock global fetch for the SW source download ─────────────────────────────

const stubBytes = new Uint8Array(16).fill(0xab);

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    arrayBuffer: async () => stubBytes.buffer,
  }));
});

// ─── chrome.downloads.download mock returning a numeric downloadId ────────────

beforeEach(() => {
  // jest-webextension-mock provides chrome.downloads. We override download to
  // resolve with a deterministic numeric id, matching real Chrome behavior.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (chrome.downloads as any).download = jest.fn(async () => 4242);
});

// ─── Helper: invoke createMessageRouter and await the sendResponse callback ──

interface RouterResponse {
  success: boolean;
  reason?: string;
  filename?: string;
  bytes?: number[];
  actualFormat?: "mp3" | "flac" | "wav";
  fallbackReason?: string;
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
    // sender is unused in handler.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router(message, {} as any, (response: RouterResponse) => {
      resolve(response);
    });
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Bug 2 — Wave FLAC/WAV pipeline must end with a numeric downloadId", () => {
  beforeEach(() => {
    jest.resetModules();
    // Re-establish mocks (jest.mock declarations persist across resetModules).
    // Re-set storage prefs default — getFormatPreferences uses chrome.storage.local.
  });

  // ─── Concrete: FLAC on wave ────────────────────────────────────────────────

  it("[CONCRETE flac] floating-button DOWNLOAD_TRACK on wave returns success with numeric downloadId and actualFormat=flac", async () => {
    // Set single-track preference to FLAC so the floating-button (no folder)
    // pipeline picks FLAC.
    await chrome.storage.local.set({
      ymd_format_prefs: { singleTrackFormat: "flac", bulkFormat: "mp3" },
    });

    const result = await invokeRouter({
      type: "DOWNLOAD_TRACK",
      payload: {
        trackId: "200:100",
        meta: { artist: "Земфира", title: "Хочешь?" },
        // No folder — this is the floating-button (single track) flow.
      },
    });

    // Validates: Requirements 2.3, 2.4
    expect(result.success).toBe(true);
    expect(typeof result.downloadId).toBe("number");
    expect(result.actualFormat).toBe("flac");
  });

  // ─── Concrete: WAV on wave ─────────────────────────────────────────────────

  it("[CONCRETE wav] floating-button DOWNLOAD_TRACK on wave returns success with numeric downloadId and actualFormat=wav", async () => {
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

    // Validates: Requirements 2.3, 2.4
    expect(result.success).toBe(true);
    expect(typeof result.downloadId).toBe("number");
    expect(result.actualFormat).toBe("wav");
  });

  // ─── PBT: any flac/wav request on wave drives the pipeline to downloadId ───

  it("[PBT] for any FLAC/WAV request on wave, response has success=true, numeric downloadId, and actualFormat===requestedFormat", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"flac" | "wav">("flac", "wav"),
        // Generate a wave-style trackId derivable from the player-bar DOM.
        fc.integer({ min: 1, max: 9_999_999 }),
        fc.integer({ min: 1, max: 9_999_999 }),
        async (requestedFormat, trackIdNum, albumIdNum) => {
          await chrome.storage.local.set({
            ymd_format_prefs: {
              singleTrackFormat: requestedFormat,
              bulkFormat: "mp3",
            },
          });

          const result = await invokeRouter({
            type: "DOWNLOAD_TRACK",
            payload: {
              trackId: `${trackIdNum}:${albumIdNum}`,
              meta: { artist: "Артист", title: "Трек" },
            },
          });

          expect(result.success).toBe(true);
          expect(typeof result.downloadId).toBe("number");
          expect(result.actualFormat).toBe(requestedFormat);
        },
      ),
      { numRuns: 10 },
    );
  });
});
