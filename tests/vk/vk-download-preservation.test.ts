/**
 * Preservation Property Tests: Non-VK Downloads and VK UI Unchanged
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 *
 * These tests confirm that the baseline behavior is preserved:
 * - Non-VK downloads (DOWNLOAD_TRACK, DOWNLOAD_BY_INPUT) use chrome.downloads.download
 *   and return { success: true, downloadId }
 * - VK error scenarios propagate correct error codes via response
 * - VK button positioning uses position: absolute; left: -30px
 * - VK bulk download uses 500ms sequential delay
 *
 * EXPECTED OUTCOME: All tests PASS on unfixed code (confirms baseline to preserve).
 */

import * as fc from "fast-check";

// ─── Property 1: Non-VK downloads use chrome.downloads.download ─────────────

describe("Preservation: Non-VK Downloads use chrome.downloads.download", () => {
  let downloadCalled: boolean;
  let downloadOptions: { url: string; filename?: string } | null = null;
  let routerHandler: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (r: any) => void,
  ) => boolean;

  beforeEach(() => {
    downloadCalled = false;
    downloadOptions = null;
    jest.resetModules();

    // Mock chrome.downloads.download to capture calls
    (chrome.downloads.download as jest.Mock).mockImplementation(
      (options: { url: string; filename?: string }) => {
        downloadCalled = true;
        downloadOptions = options;
        return Promise.resolve(42);
      },
    );
  });

  /**
   * **Validates: Requirements 3.3**
   *
   * Property: For all non-VK download messages (DOWNLOAD_TRACK with valid trackId),
   * the handler calls chrome.downloads.download and returns { success: true, downloadId }.
   *
   * This observes that Яндекс.Музыка DOWNLOAD_TRACK handler uses
   * chrome.downloads.download with a data: URL and returns downloadId.
   */
  it("DOWNLOAD_TRACK handler calls chrome.downloads.download and returns downloadId", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate track IDs (numeric strings)
        fc.stringOf(fc.char().filter((c) => /[0-9]/.test(c)), {
          minLength: 1,
          maxLength: 8,
        }).filter((s) => /^\d+$/.test(s)),
        // Generate artist names
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        // Generate titles
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        async (trackId, artist, title) => {
          jest.resetModules();
          downloadCalled = false;
          downloadOptions = null;

          // Re-mock chrome.downloads.download after resetModules
          (chrome.downloads.download as jest.Mock).mockImplementation(
            (options: { url: string; filename?: string }) => {
              downloadCalled = true;
              downloadOptions = options;
              return Promise.resolve(42);
            },
          );

          // Mock all dependencies used by the DOWNLOAD_TRACK handler
          jest.doMock("../../src/background/api-client", () => ({
            getDownloadInfoEntries: jest.fn().mockResolvedValue([
              {
                codec: "mp3",
                bitrateInKbps: 320,
                preview: false,
                downloadInfoUrl: "https://storage.yandexcloud.net/download-info",
                directUrl: `https://storage.yandexcloud.net/${trackId}.mp3`,
              },
            ]),
            getSignedUrlFromEntry: jest
              .fn()
              .mockResolvedValue(`https://storage.yandexcloud.net/${trackId}.mp3`),
            getTrackInfo: jest.fn().mockResolvedValue({
              trackId,
              artist,
              title,
              albumTitle: "Album",
              year: "2024",
              trackNumber: "1",
              coverUri: null,
            }),
            DrmProtectedError: class extends Error {},
            AuthRequiredError: class extends Error {},
            PreviewOnlyError: class extends Error {},
          }));

          jest.doMock("../../src/background/error-classifier", () => ({
            classifyError: jest.fn().mockReturnValue("UNKNOWN"),
          }));

          jest.doMock("../../src/background/logger", () => ({
            logError: jest.fn(),
          }));

          jest.doMock("../../src/shared/auth", () => ({
            getStoredToken: jest.fn().mockResolvedValue("test-token"),
            setStoredToken: jest.fn().mockResolvedValue(undefined),
            clearStoredToken: jest.fn().mockResolvedValue(undefined),
          }));

          jest.doMock("../../src/shared/folder-sanitizer", () => ({
            sanitizeFolderName: jest.fn((f: string) => f),
          }));

          jest.doMock("../../src/background/oauth-flow", () => ({
            authorizeAndSave: jest.fn().mockResolvedValue(undefined),
          }));

          jest.doMock("../../src/background/id3", () => ({
            buildId3v23Tag: jest.fn().mockReturnValue(new Uint8Array(0)),
            fetchCover: jest.fn().mockResolvedValue(null),
          }));

          jest.doMock("../../src/shared/filename", () => ({
            buildFilename: jest.fn(
              (p: { artist: string; title: string; codec: string }) =>
                `${p.artist} - ${p.title}.${p.codec}`,
            ),
          }));

          jest.doMock("../../src/shared/format-storage", () => ({
            getFormatPreferences: jest
              .fn()
              .mockResolvedValue({ singleTrackFormat: "mp3", bulkFormat: "mp3" }),
            getServiceFormatPreferences: jest
              .fn()
              .mockResolvedValue({ singleTrackFormat: "mp3", bulkFormat: "mp3" }),
          }));

          jest.doMock("../../src/background/format-resolver", () => ({
            resolveFormat: jest.fn().mockReturnValue({
              entry: {
                codec: "mp3",
                bitrateInKbps: 320,
                preview: false,
                downloadInfoUrl: "https://storage.yandexcloud.net/download-info",
                directUrl: `https://storage.yandexcloud.net/${trackId}.mp3`,
              },
              outputFormat: "mp3",
              fellBack: false,
            }),
            PreviewOnlyError: class extends Error {},
          }));

          jest.doMock("../../src/background/flac-meta", () => ({
            embedFlacMetadata: jest.fn(),
          }));

          jest.doMock("../../src/background/wav-converter", () => ({
            convertToWav: jest.fn(),
          }));

          jest.doMock("../../src/background/wav-meta", () => ({
            buildWavFile: jest.fn(),
          }));

          jest.doMock("../../src/background/offscreen-bridge", () => ({
            encodeMp3ToFlacInOffscreen: jest.fn(),
          }));

          jest.doMock("../../src/shared/base64", () => ({
            bytesToBase64: jest.fn().mockReturnValue("AAAA"),
          }));

          jest.doMock("../../src/background/vk-api-client", () => ({
            VkApiClient: jest.fn().mockImplementation(() => ({
              getAudioUrl: jest.fn(),
            })),
            VkApiError: class extends Error {
              code: string;
              constructor(msg: string, code: string) {
                super(msg);
                this.code = code;
              }
            },
          }));

          jest.doMock("../../src/background/vk-url-cache", () => ({
            VkUrlCache: jest.fn().mockImplementation(() => ({})),
          }));

          jest.doMock("../../src/background/vk-rate-limiter", () => ({
            createVkRateLimiter: jest.fn().mockReturnValue({}),
          }));

          jest.doMock("../../src/background/vk-session-validator", () => ({}));

          jest.doMock("../../src/shared/vk-filename", () => ({
            buildVkFilename: jest.fn().mockReturnValue("artist - title.mp3"),
          }));

          jest.doMock("../../src/background/vk-hls-downloader", () => ({
            downloadVkHlsTrack: jest.fn().mockResolvedValue(100),
          }));

          // Mock global fetch
          (global as any).fetch = jest.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(128)),
          });

          const { URLCache } = await import("../../src/background/url-cache");
          const { createMessageRouter } = await import(
            "../../src/background/message-router"
          );

          const cache = new URLCache();
          routerHandler = createMessageRouter(cache);

          // Send DOWNLOAD_TRACK message (non-VK, Яндекс.Музыка flow)
          const response = await new Promise<any>((resolve) => {
            routerHandler(
              {
                type: "DOWNLOAD_TRACK",
                payload: {
                  trackId,
                  meta: { artist, title },
                },
              },
              {} as chrome.runtime.MessageSender,
              resolve,
            );
          });

          // Property assertions:
          // 1. chrome.downloads.download was called
          expect(downloadCalled).toBe(true);
          // 2. Response includes success: true and a downloadId
          expect(response.success).toBe(true);
          expect(typeof response.downloadId).toBe("number");
          // 3. download was called with a data: URL (Service Worker pattern)
          expect(downloadOptions!.url).toMatch(/^data:/);
        },
      ),
      { numRuns: 10 },
    );
  });

  /**
   * **Validates: Requirements 3.3**
   *
   * Property: For all DOWNLOAD_BY_INPUT messages with valid track input,
   * the handler calls chrome.downloads.download and returns { success: true, downloadId }.
   */
  it("DOWNLOAD_BY_INPUT handler calls chrome.downloads.download and returns downloadId", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate track IDs or URLs
        fc.oneof(
          fc.stringOf(fc.char().filter((c) => /[0-9]/.test(c)), {
            minLength: 1,
            maxLength: 8,
          }).filter((s) => /^\d+$/.test(s)),
          fc.stringOf(fc.char().filter((c) => /[0-9]/.test(c)), {
            minLength: 1,
            maxLength: 8,
          })
            .filter((s) => /^\d+$/.test(s))
            .map((id) => `https://music.yandex.ru/album/123/track/${id}`),
        ),
        async (input) => {
          jest.resetModules();
          downloadCalled = false;
          downloadOptions = null;

          (chrome.downloads.download as jest.Mock).mockImplementation(
            (options: { url: string; filename?: string }) => {
              downloadCalled = true;
              downloadOptions = options;
              return Promise.resolve(77);
            },
          );

          // Same mocks as DOWNLOAD_TRACK
          jest.doMock("../../src/background/api-client", () => ({
            getDownloadInfoEntries: jest.fn().mockResolvedValue([
              {
                codec: "mp3",
                bitrateInKbps: 320,
                preview: false,
                downloadInfoUrl: "https://storage.yandexcloud.net/download-info",
                directUrl: "https://storage.yandexcloud.net/track.mp3",
              },
            ]),
            getSignedUrlFromEntry: jest
              .fn()
              .mockResolvedValue("https://storage.yandexcloud.net/track.mp3"),
            getTrackInfo: jest.fn().mockResolvedValue({
              trackId: "12345",
              artist: "TestArtist",
              title: "TestTitle",
              albumTitle: "Album",
              year: "2024",
              trackNumber: "1",
              coverUri: null,
            }),
            DrmProtectedError: class extends Error {},
            AuthRequiredError: class extends Error {},
            PreviewOnlyError: class extends Error {},
          }));

          jest.doMock("../../src/background/error-classifier", () => ({
            classifyError: jest.fn().mockReturnValue("UNKNOWN"),
          }));
          jest.doMock("../../src/background/logger", () => ({
            logError: jest.fn(),
          }));
          jest.doMock("../../src/shared/auth", () => ({
            getStoredToken: jest.fn().mockResolvedValue("test-token"),
            setStoredToken: jest.fn().mockResolvedValue(undefined),
            clearStoredToken: jest.fn().mockResolvedValue(undefined),
          }));
          jest.doMock("../../src/shared/folder-sanitizer", () => ({
            sanitizeFolderName: jest.fn((f: string) => f),
          }));
          jest.doMock("../../src/background/oauth-flow", () => ({
            authorizeAndSave: jest.fn().mockResolvedValue(undefined),
          }));
          jest.doMock("../../src/background/id3", () => ({
            buildId3v23Tag: jest.fn().mockReturnValue(new Uint8Array(0)),
            fetchCover: jest.fn().mockResolvedValue(null),
          }));
          jest.doMock("../../src/shared/filename", () => ({
            buildFilename: jest.fn(
              (p: { artist: string; title: string; codec: string }) =>
                `${p.artist} - ${p.title}.${p.codec}`,
            ),
          }));
          jest.doMock("../../src/shared/format-storage", () => ({
            getFormatPreferences: jest
              .fn()
              .mockResolvedValue({ singleTrackFormat: "mp3", bulkFormat: "mp3" }),
            getServiceFormatPreferences: jest
              .fn()
              .mockResolvedValue({ singleTrackFormat: "mp3", bulkFormat: "mp3" }),
          }));
          jest.doMock("../../src/background/format-resolver", () => ({
            resolveFormat: jest.fn().mockReturnValue({
              entry: {
                codec: "mp3",
                bitrateInKbps: 320,
                preview: false,
                downloadInfoUrl: "https://storage.yandexcloud.net/download-info",
                directUrl: "https://storage.yandexcloud.net/track.mp3",
              },
              outputFormat: "mp3",
              fellBack: false,
            }),
            PreviewOnlyError: class extends Error {},
          }));
          jest.doMock("../../src/background/flac-meta", () => ({
            embedFlacMetadata: jest.fn(),
          }));
          jest.doMock("../../src/background/wav-converter", () => ({
            convertToWav: jest.fn(),
          }));
          jest.doMock("../../src/background/wav-meta", () => ({
            buildWavFile: jest.fn(),
          }));
          jest.doMock("../../src/background/offscreen-bridge", () => ({
            encodeMp3ToFlacInOffscreen: jest.fn(),
          }));
          jest.doMock("../../src/shared/base64", () => ({
            bytesToBase64: jest.fn().mockReturnValue("AAAA"),
          }));
          jest.doMock("../../src/background/vk-api-client", () => ({
            VkApiClient: jest.fn().mockImplementation(() => ({
              getAudioUrl: jest.fn(),
            })),
            VkApiError: class extends Error {
              code: string;
              constructor(msg: string, code: string) {
                super(msg);
                this.code = code;
              }
            },
          }));
          jest.doMock("../../src/background/vk-url-cache", () => ({
            VkUrlCache: jest.fn().mockImplementation(() => ({})),
          }));
          jest.doMock("../../src/background/vk-rate-limiter", () => ({
            createVkRateLimiter: jest.fn().mockReturnValue({}),
          }));
          jest.doMock("../../src/background/vk-session-validator", () => ({}));
          jest.doMock("../../src/shared/vk-filename", () => ({
            buildVkFilename: jest.fn().mockReturnValue("artist - title.mp3"),
          }));
          jest.doMock("../../src/background/vk-hls-downloader", () => ({
            downloadVkHlsTrack: jest.fn().mockResolvedValue(100),
          }));

          (global as any).fetch = jest.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(128)),
          });

          const { URLCache } = await import("../../src/background/url-cache");
          const { createMessageRouter } = await import(
            "../../src/background/message-router"
          );

          const cache = new URLCache();
          routerHandler = createMessageRouter(cache);

          const response = await new Promise<any>((resolve) => {
            routerHandler(
              {
                type: "DOWNLOAD_BY_INPUT",
                payload: { input },
              },
              {} as chrome.runtime.MessageSender,
              resolve,
            );
          });

          // Property assertions:
          expect(downloadCalled).toBe(true);
          expect(response.success).toBe(true);
          expect(typeof response.downloadId).toBe("number");
          expect(downloadOptions!.url).toMatch(/^data:/);
        },
      ),
      { numRuns: 10 },
    );
  });
});

// ─── Property 2: VK error scenarios propagate error codes ───────────────────

describe("Preservation: VK error scenarios propagate error codes", () => {
  /**
   * **Validates: Requirements 3.5**
   *
   * Property: For all VK error scenarios (rate limit, auth, unavailable),
   * the VK_DOWNLOAD_TRACK handler returns { success: false, errorCode, reason }
   * so that the content script can display the appropriate toast message.
   */
  it("VK_DOWNLOAD_TRACK propagates VkApiError codes in response", async () => {
    const vkErrorCodes = [
      "VK_NOT_LOGGED_IN",
      "VK_SESSION_EXPIRED",
      "VK_RATE_LIMITED",
      "VK_TRACK_UNAVAILABLE",
      "VK_TIMEOUT",
      "VK_URL_NOT_FOUND",
      "VK_NETWORK_ERROR",
      "VK_AUTH_REQUIRED",
    ] as const;

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...vkErrorCodes),
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
        fc.stringOf(fc.char().filter((c) => /[0-9-]/.test(c)), {
          minLength: 1,
          maxLength: 10,
        }).filter((s) => /^-?\d+$/.test(s)),
        fc.stringOf(fc.char().filter((c) => /[0-9]/.test(c)), {
          minLength: 1,
          maxLength: 10,
        }).filter((s) => /^\d+$/.test(s)),
        async (errorCode, errorMessage, ownerId, audioId) => {
          jest.resetModules();

          // Mock VkApiClient to throw VkApiError with the given code
          const mockVkApiError = class extends Error {
            code: string;
            constructor(msg: string, code: string) {
              super(msg);
              this.code = code;
              this.name = "VkApiError";
            }
          };

          jest.doMock("../../src/background/vk-api-client", () => ({
            VkApiClient: jest.fn().mockImplementation(() => ({
              getAudioUrl: jest.fn().mockRejectedValue(
                new mockVkApiError(errorMessage, errorCode),
              ),
            })),
            VkApiError: mockVkApiError,
          }));

          jest.doMock("../../src/background/api-client", () => ({
            getDownloadInfoEntries: jest.fn(),
            getSignedUrlFromEntry: jest.fn(),
            getTrackInfo: jest.fn(),
            DrmProtectedError: class extends Error {},
            AuthRequiredError: class extends Error {},
            PreviewOnlyError: class extends Error {},
          }));
          jest.doMock("../../src/background/error-classifier", () => ({
            classifyError: jest.fn().mockReturnValue("UNKNOWN"),
          }));
          jest.doMock("../../src/background/logger", () => ({
            logError: jest.fn(),
          }));
          jest.doMock("../../src/shared/auth", () => ({
            getStoredToken: jest.fn().mockResolvedValue("test-token"),
            setStoredToken: jest.fn().mockResolvedValue(undefined),
            clearStoredToken: jest.fn().mockResolvedValue(undefined),
          }));
          jest.doMock("../../src/shared/folder-sanitizer", () => ({
            sanitizeFolderName: jest.fn((f: string) => f),
          }));
          jest.doMock("../../src/background/oauth-flow", () => ({
            authorizeAndSave: jest.fn().mockResolvedValue(undefined),
          }));
          jest.doMock("../../src/background/id3", () => ({
            buildId3v23Tag: jest.fn().mockReturnValue(new Uint8Array(0)),
            fetchCover: jest.fn().mockResolvedValue(null),
          }));
          jest.doMock("../../src/shared/filename", () => ({
            buildFilename: jest.fn().mockReturnValue("file.mp3"),
          }));
          jest.doMock("../../src/shared/format-storage", () => ({
            getFormatPreferences: jest
              .fn()
              .mockResolvedValue({ singleTrackFormat: "mp3", bulkFormat: "mp3" }),
            getServiceFormatPreferences: jest
              .fn()
              .mockResolvedValue({ singleTrackFormat: "mp3", bulkFormat: "mp3" }),
          }));
          jest.doMock("../../src/background/format-resolver", () => ({
            resolveFormat: jest.fn(),
            PreviewOnlyError: class extends Error {},
          }));
          jest.doMock("../../src/background/flac-meta", () => ({
            embedFlacMetadata: jest.fn(),
          }));
          jest.doMock("../../src/background/wav-converter", () => ({
            convertToWav: jest.fn(),
          }));
          jest.doMock("../../src/background/wav-meta", () => ({
            buildWavFile: jest.fn(),
          }));
          jest.doMock("../../src/background/offscreen-bridge", () => ({
            encodeMp3ToFlacInOffscreen: jest.fn(),
          }));
          jest.doMock("../../src/shared/base64", () => ({
            bytesToBase64: jest.fn().mockReturnValue("AAAA"),
          }));
          jest.doMock("../../src/background/vk-url-cache", () => ({
            VkUrlCache: jest.fn().mockImplementation(() => ({})),
          }));
          jest.doMock("../../src/background/vk-rate-limiter", () => ({
            createVkRateLimiter: jest.fn().mockReturnValue({}),
          }));
          jest.doMock("../../src/background/vk-session-validator", () => ({}));
          jest.doMock("../../src/shared/vk-filename", () => ({
            buildVkFilename: jest.fn().mockReturnValue("artist - title.mp3"),
          }));
          jest.doMock("../../src/background/vk-hls-downloader", () => ({
            downloadVkHlsTrack: jest.fn().mockResolvedValue(100),
          }));

          const { URLCache } = await import("../../src/background/url-cache");
          const { createMessageRouter } = await import(
            "../../src/background/message-router"
          );

          const cache = new URLCache();
          const handler = createMessageRouter(cache);

          const response = await new Promise<any>((resolve) => {
            handler(
              {
                type: "VK_DOWNLOAD_TRACK",
                payload: {
                  ownerId,
                  audioId,
                  artist: "TestArtist",
                  title: "TestTitle",
                },
              },
              {} as chrome.runtime.MessageSender,
              resolve,
            );
          });

          // Property assertions:
          // 1. Response indicates failure
          expect(response.success).toBe(false);
          // 2. Error code is propagated correctly
          expect(response.errorCode).toBe(errorCode);
          // 3. Reason message is present
          expect(typeof response.reason).toBe("string");
          expect(response.reason.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 15 },
    );
  });
});

// ─── Property 3: VK button positioning ──────────────────────────────────────

describe("Preservation: VK button positioning unchanged", () => {
  /**
   * **Validates: Requirements 3.1**
   *
   * Property: The VK download button CSS uses position: absolute; left: -30px
   * to position the button to the left of the audio row.
   *
   * This is a structural observation test — we verify the CSS string in
   * vk-track-injector.ts contains the expected positioning rules.
   */
  it("VK download button uses position: absolute and left: -30px", () => {
    // Read the source directly and verify CSS positioning
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../src/vk-content/vk-track-injector.ts"),
      "utf-8",
    );

    // Verify the CSS contains the expected positioning
    expect(source).toContain("position: absolute;");
    expect(source).toContain("left: -30px;");
    // Also verify parent row gets relative positioning and margin offset
    expect(source).toContain("position: relative !important;");
    expect(source).toContain("margin-left: 30px !important;");
  });
});

// ─── Property 4: VK bulk download sequential with 500ms delay ───────────────

describe("Preservation: VK bulk download 500ms sequential delay", () => {
  /**
   * **Validates: Requirements 3.4**
   *
   * Property: The VK content script downloads tracks sequentially with a
   * 500ms delay between each track via setTimeout.
   *
   * We verify this by observing the source code structure of the
   * onDownloadPlaylist function in vk-content.ts.
   */
  it("VK playlist download uses 500ms delay between tracks", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../src/vk-content/vk-content.ts"),
      "utf-8",
    );

    // Verify the 500ms sequential delay pattern
    expect(source).toContain("setTimeout(() => downloadNext(index + 1), 500)");
  });
});

// ─── Property 5: VK error messages mapping in content script ────────────────

describe("Preservation: VK error messages mapped in content script", () => {
  /**
   * **Validates: Requirements 3.5**
   *
   * Property: For all VK error codes, the content script has a corresponding
   * human-readable error message that gets shown via toast.
   */
  it("all VK error codes have corresponding messages in content script", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../src/vk-content/vk-content.ts"),
      "utf-8",
    );

    const expectedCodes = [
      "VK_NOT_LOGGED_IN",
      "VK_SESSION_EXPIRED",
      "VK_RATE_LIMITED",
      "VK_TRACK_UNAVAILABLE",
      "VK_TIMEOUT",
      "VK_URL_NOT_FOUND",
      "VK_NETWORK_ERROR",
      "VK_AUTH_REQUIRED",
    ];

    for (const code of expectedCodes) {
      expect(source).toContain(code);
    }

    // Verify error message display logic exists
    expect(source).toContain("showToast");
    expect(source).toContain("ERROR_MESSAGES");
  });
});
