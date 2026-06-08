/**
 * Bug Condition Exploration Test: VK Download Produces GUID Filename
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 *
 * This test encodes the EXPECTED (correct) behavior: downloadVkHlsTrack and
 * VK_DOWNLOAD_TRACK handler should NOT use chrome.downloads.download with
 * data:/blob: URLs from Service Worker (because Chrome ignores the filename
 * param for such URLs, producing GUID filenames).
 *
 * On UNFIXED code this test is EXPECTED TO FAIL — that failure proves the bug exists.
 * After the fix, this test should PASS.
 */

import * as fc from "fast-check";
import { buildVkFilename } from "../../src/shared/vk-filename";

// ─── Bug condition predicate ────────────────────────────────────────────────

interface VkDownloadRequest {
  source: "VK_DOWNLOAD_TRACK";
  downloadMethod: "chrome.downloads.download";
  urlScheme: "data:" | "blob:";
  artist: string;
  title: string;
  ownerId: string;
  audioId: string;
}

function isBugCondition(x: VkDownloadRequest): boolean {
  return (
    x.source === "VK_DOWNLOAD_TRACK" &&
    x.downloadMethod === "chrome.downloads.download" &&
    (x.urlScheme === "data:" || x.urlScheme === "blob:")
  );
}

// ─── Mocks & helpers ────────────────────────────────────────────────────────

// Track what chrome.downloads.download was called with
let lastDownloadOptions: { url: string; filename?: string } | null = null;

// Mock chrome.downloads.download to capture the call
const originalDownload = chrome.downloads.download;

beforeEach(() => {
  lastDownloadOptions = null;
  (chrome.downloads.download as jest.Mock).mockImplementation(
    (options: { url: string; filename?: string }) => {
      lastDownloadOptions = options;
      return Promise.resolve(12345);
    },
  );
});

// Mock chrome.runtime.sendMessage for offscreen blob creation
(chrome.runtime.sendMessage as jest.Mock).mockImplementation(
  (msg: any) => {
    if (msg?.target === "offscreen" && msg?.type === "VK_CREATE_BLOB_URL") {
      return Promise.resolve({
        success: true,
        blobUrl: "blob:chrome-extension://abc123/fake-blob-id",
      });
    }
    return Promise.resolve({ success: false });
  },
);

// Mock chrome.runtime.getContexts (for offscreen doc check)
if (!(chrome.runtime as any).getContexts) {
  (chrome.runtime as any).getContexts = jest.fn().mockResolvedValue([{ id: "offscreen" }]);
}

// Mock chrome.offscreen
if (!(chrome as any).offscreen) {
  (chrome as any).offscreen = { createDocument: jest.fn().mockResolvedValue(undefined) };
}

// Mock global fetch for HLS manifest + segments
const mockFetch = jest.fn().mockImplementation((url: string) => {
  if (url.includes(".m3u8")) {
    return Promise.resolve({
      ok: true,
      text: () =>
        Promise.resolve(
          [
            "#EXTM3U",
            "#EXT-X-TARGETDURATION:10",
            "#EXTINF:10,",
            "segment0.ts",
            "#EXT-X-ENDLIST",
          ].join("\n"),
        ),
    });
  }
  // Segment or any other URL — return small binary data
  return Promise.resolve({
    ok: true,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(128)),
  });
});

(global as any).fetch = mockFetch;

// Mock crypto.subtle (not available in Node)
if (!global.crypto?.subtle) {
  (global as any).crypto = {
    subtle: {
      importKey: jest.fn().mockResolvedValue({}),
      decrypt: jest.fn().mockImplementation((_alg, _key, data) => Promise.resolve(data)),
    },
  };
}

// ─── Arbitraries ────────────────────────────────────────────────────────────

const vkArtistArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
  fc.constant("Кино"),
  fc.constant("Imagine Dragons"),
  fc.constant("Моргенштерн feat. Тимати"),
);

const vkTitleArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0),
  fc.constant("Группа крови"),
  fc.constant("Believer"),
  fc.constant("Лёд (Ice)"),
);

const vkOwnerIdArb = fc.stringOf(fc.char().filter((c) => /[0-9-]/.test(c)), {
  minLength: 1,
  maxLength: 10,
}).filter((s) => s.length > 0 && /^-?\d+$/.test(s));

const vkAudioIdArb = fc.stringOf(fc.char().filter((c) => /[0-9]/.test(c)), {
  minLength: 1,
  maxLength: 10,
}).filter((s) => s.length > 0 && /^\d+$/.test(s));

const vkDownloadRequestArb: fc.Arbitrary<VkDownloadRequest> = fc.record({
  source: fc.constant("VK_DOWNLOAD_TRACK" as const),
  downloadMethod: fc.constant("chrome.downloads.download" as const),
  urlScheme: fc.oneof(
    fc.constant("data:" as const),
    fc.constant("blob:" as const),
  ),
  artist: vkArtistArb,
  title: vkTitleArb,
  ownerId: vkOwnerIdArb,
  audioId: vkAudioIdArb,
});

// ─── Property Test ──────────────────────────────────────────────────────────

describe("Bug Condition: VK Download Produces GUID Filename", () => {
  /**
   * **Validates: Requirements 1.1, 1.2, 1.3**
   *
   * Property: For all VkTrackMeta inputs where isBugCondition(X) holds,
   * the download mechanism should NOT use chrome.downloads.download with
   * data:/blob: URLs (because Chrome ignores the filename parameter for
   * such URLs in Service Worker context).
   *
   * On UNFIXED code: downloadVkHlsTrack calls chrome.downloads.download
   * with a blob URL, and VK_DOWNLOAD_TRACK direct path uses a data: URL.
   * Both trigger the Chrome GUID naming bug.
   *
   * This test asserts the EXPECTED behavior: the function should NOT call
   * chrome.downloads.download at all (the fix moves download to content script).
   * Therefore on unfixed code, this test FAILS — proving the bug exists.
   */
  it("downloadVkHlsTrack should NOT call chrome.downloads.download (blob URL causes GUID filename)", async () => {
    await fc.assert(
      fc.asyncProperty(vkDownloadRequestArb, async (request) => {
        // Only test cases matching bug condition
        fc.pre(isBugCondition(request));

        // Reset mocks
        lastDownloadOptions = null;
        mockFetch.mockClear();

        // Import the function under test (unfixed: calls chrome.downloads.download)
        const { downloadVkHlsTrack } = await import(
          "../../src/background/vk-hls-downloader"
        );

        const expectedFilename = buildVkFilename({
          artist: request.artist,
          title: request.title,
          ownerId: request.ownerId,
          audioId: request.audioId,
          ext: "mp3",
        });

        const m3u8Url = `https://vk.com/audio_hls/${request.ownerId}_${request.audioId}/index.m3u8`;

        // Call the function
        const result = await downloadVkHlsTrack(m3u8Url, expectedFilename);

        // EXPECTED BEHAVIOR (after fix):
        // - downloadVkHlsTrack should return { audioDataB64, totalBytes }
        //   instead of a downloadId number
        // - It should NOT call chrome.downloads.download
        //
        // ON UNFIXED CODE:
        // - result is a number (downloadId)
        // - chrome.downloads.download WAS called with a blob: URL
        // - This means Chrome will generate a GUID filename, ignoring the
        //   filename parameter

        // Assert: result should be an object with audioDataB64, NOT a number
        const resultIsObject =
          typeof result === "object" &&
          result !== null &&
          "audioDataB64" in result &&
          "totalBytes" in result;

        // This assertion will FAIL on unfixed code because result is a number (downloadId)
        expect(resultIsObject).toBe(true);

        // Additionally: chrome.downloads.download should NOT have been called
        expect(lastDownloadOptions).toBeNull();
      }),
      { numRuns: 20 },
    );
  });
});
