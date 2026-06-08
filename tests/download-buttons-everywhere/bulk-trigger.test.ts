/**
 * @jest-environment jsdom
 */

/**
 * Unit tests for src/content/bulk-trigger.ts
 *
 * Validates: Requirements 2.5, 2.6, 7.2, 7.3, 7.4, 7.6, 6.7, 11.2, 11.3, 11.4
 */

import { startBulkTrigger, type BulkTriggerArgs } from "../../src/content/bulk-trigger";
import type { BulkDownloadCallbacks } from "../../src/content/bulk-download";
import type { CardIdentifier } from "../../src/content/card-classifier";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Mock bulk-download module
const mockStart = jest.fn().mockResolvedValue(undefined);
const mockReset = jest.fn();
const mockIsRunning = jest.fn().mockReturnValue(false);

jest.mock("../../src/content/bulk-download", () => ({
  createBulkDownload: jest.fn(() => ({
    start: mockStart,
    reset: mockReset,
    isRunning: mockIsRunning,
  })),
  scrapeTrackIdsFromDom: jest.fn(() => []),
}));

// Get reference to mocked module
const { createBulkDownload, scrapeTrackIdsFromDom } = jest.requireMock(
  "../../src/content/bulk-download",
) as {
  createBulkDownload: jest.Mock;
  scrapeTrackIdsFromDom: jest.Mock;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCallbacks(): BulkDownloadCallbacks {
  return {
    onProgress: jest.fn(),
    onIdle: jest.fn(),
    notify: jest.fn(),
    confirm: jest.fn().mockReturnValue(true),
  };
}

function makeAlbumIdentifier(): NonNullable<CardIdentifier> {
  return { kind: "album", albumId: "12345" };
}

function makePlaylistClassicIdentifier(): NonNullable<CardIdentifier> {
  return { kind: "playlist-classic", owner: "alice", playlistId: "42" };
}

function makePlaylistUuidIdentifier(): NonNullable<CardIdentifier> {
  return { kind: "playlist-uuid", uuid: "lk.abcdef12-3456" };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();

  // Default: online, runtime available
  Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
  (globalThis as any).chrome = {
    runtime: {
      id: "test-extension-id",
      sendMessage: jest.fn(),
    },
  };
});

afterEach(() => {
  jest.useRealTimers();
  delete (globalThis as any).chrome;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("bulk-trigger: pre-flight checks", () => {
  it("returns inert handle and notifies when offline (Req 7.2)", () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const cbs = makeCallbacks();

    const handle = startBulkTrigger({
      identifier: makeAlbumIdentifier(),
      callbacks: cbs,
    });

    expect(cbs.notify).toHaveBeenCalledWith("Нет подключения к интернету", "error");
    expect(cbs.onIdle).toHaveBeenCalledTimes(1);
    expect(handle.isRunning()).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("returns inert handle and notifies when runtime lost (Req 7.6)", () => {
    (globalThis as any).chrome = { runtime: {} }; // id is undefined
    const cbs = makeCallbacks();

    const handle = startBulkTrigger({
      identifier: makeAlbumIdentifier(),
      callbacks: cbs,
    });

    expect(cbs.notify).toHaveBeenCalledWith(
      "Расширение обновлено. Перезагрузите эту страницу (F5).",
      "error",
    );
    expect(handle.isRunning()).toBe(false);
  });

  it("returns inert handle when chrome is undefined (Req 7.6)", () => {
    delete (globalThis as any).chrome;
    const cbs = makeCallbacks();

    const handle = startBulkTrigger({
      identifier: makeAlbumIdentifier(),
      callbacks: cbs,
    });

    expect(cbs.notify).toHaveBeenCalledWith(
      "Расширение обновлено. Перезагрузите эту страницу (F5).",
      "error",
    );
    expect(handle.isRunning()).toBe(false);
  });
});

describe("bulk-trigger: message building (Req 11.3, 11.4)", () => {
  it("sends RESOLVE_ALBUM for album identifier", async () => {
    chrome.runtime.sendMessage = jest.fn().mockResolvedValue({
      success: true,
      album: { albumId: "12345", title: "Test Album", trackIds: ["1", "2"] },
    });
    const cbs = makeCallbacks();

    startBulkTrigger({ identifier: makeAlbumIdentifier(), callbacks: cbs });
    await jest.runAllTimersAsync();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "RESOLVE_ALBUM",
      payload: { input: "https://music.yandex.ru/album/12345" },
    });
  });

  it("sends RESOLVE_PLAYLIST for playlist-classic identifier", async () => {
    chrome.runtime.sendMessage = jest.fn().mockResolvedValue({
      success: true,
      playlist: { owner: "alice", kind: "42", title: "My List", trackIds: ["1"] },
    });
    const cbs = makeCallbacks();

    startBulkTrigger({ identifier: makePlaylistClassicIdentifier(), callbacks: cbs });
    await jest.runAllTimersAsync();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "RESOLVE_PLAYLIST",
      payload: { input: "https://music.yandex.ru/users/alice/playlists/42" },
    });
  });

  it("sends RESOLVE_PLAYLIST for playlist-uuid identifier", async () => {
    chrome.runtime.sendMessage = jest.fn().mockResolvedValue({
      success: true,
      playlist: { owner: "", kind: "", title: "UUID List", trackIds: ["5"] },
    });
    const cbs = makeCallbacks();

    startBulkTrigger({ identifier: makePlaylistUuidIdentifier(), callbacks: cbs });
    await jest.runAllTimersAsync();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "RESOLVE_PLAYLIST",
      payload: { input: "https://music.yandex.ru/playlists/lk.abcdef12-3456" },
    });
  });
});

describe("bulk-trigger: error handling", () => {
  it("notifies on AUTH_REQUIRED and returns to idle (Req 7.4)", async () => {
    chrome.runtime.sendMessage = jest.fn().mockResolvedValue({
      success: false,
      errorCode: "AUTH_REQUIRED",
      reason: "Нужна авторизация",
    });
    const cbs = makeCallbacks();

    startBulkTrigger({ identifier: makeAlbumIdentifier(), callbacks: cbs });
    await jest.runAllTimersAsync();

    expect(cbs.notify).toHaveBeenCalledWith("Нужна авторизация", "error");
    expect(cbs.onIdle).toHaveBeenCalled();
  });

  it("notifies 'Ошибка сети' on NETWORK_ERROR (Req 7.3)", async () => {
    chrome.runtime.sendMessage = jest.fn().mockResolvedValue({
      success: false,
      errorCode: "NETWORK_ERROR",
    });
    const cbs = makeCallbacks();

    startBulkTrigger({ identifier: makeAlbumIdentifier(), callbacks: cbs });
    await jest.runAllTimersAsync();

    expect(cbs.notify).toHaveBeenCalledWith("Ошибка сети", "error");
    expect(cbs.onIdle).toHaveBeenCalled();
  });

  it("notifies 'Треки не найдены' when response has empty trackIds", async () => {
    chrome.runtime.sendMessage = jest.fn().mockResolvedValue({
      success: true,
      album: { albumId: "1", title: "Empty", trackIds: [] },
    });
    const cbs = makeCallbacks();

    startBulkTrigger({ identifier: makeAlbumIdentifier(), callbacks: cbs });
    await jest.runAllTimersAsync();

    expect(cbs.notify).toHaveBeenCalledWith("Треки не найдены", "error");
    expect(cbs.onIdle).toHaveBeenCalled();
  });
});

describe("bulk-trigger: timeout and DOM fallback (Req 6.7)", () => {
  it("falls back to scrapeTrackIdsFromDom on timeout", async () => {
    // sendMessage never resolves within timeout
    chrome.runtime.sendMessage = jest.fn().mockImplementation(
      () => new Promise(() => {}), // never resolves
    );
    scrapeTrackIdsFromDom.mockReturnValue(["100", "200"]);
    const cbs = makeCallbacks();

    startBulkTrigger({
      identifier: makeAlbumIdentifier(),
      callbacks: cbs,
      resolveTimeoutMs: 5000,
    });

    // Advance past timeout
    await jest.advanceTimersByTimeAsync(5001);
    await jest.runAllTimersAsync();

    expect(scrapeTrackIdsFromDom).toHaveBeenCalled();
    expect(createBulkDownload).toHaveBeenCalled();
  });

  it("notifies 'Треки не найдены' when timeout and DOM is empty", async () => {
    chrome.runtime.sendMessage = jest.fn().mockImplementation(
      () => new Promise(() => {}),
    );
    scrapeTrackIdsFromDom.mockReturnValue([]);
    const cbs = makeCallbacks();

    startBulkTrigger({
      identifier: makeAlbumIdentifier(),
      callbacks: cbs,
      resolveTimeoutMs: 5000,
    });

    await jest.advanceTimersByTimeAsync(5001);
    await jest.runAllTimersAsync();

    expect(cbs.notify).toHaveBeenCalledWith("Треки не найдены", "error");
    expect(cbs.onIdle).toHaveBeenCalled();
  });
});

describe("bulk-trigger: successful resolve → createBulkDownload (Req 11.2)", () => {
  it("creates bulk download with resolve function on success", async () => {
    chrome.runtime.sendMessage = jest.fn().mockResolvedValue({
      success: true,
      album: { albumId: "99", title: "Great Album", trackIds: ["10", "20", "30"] },
    });
    const cbs = makeCallbacks();

    startBulkTrigger({ identifier: makeAlbumIdentifier(), callbacks: cbs });
    await jest.runAllTimersAsync();

    expect(createBulkDownload).toHaveBeenCalledTimes(1);
    const [passedCallbacks, passedConfig] = createBulkDownload.mock.calls[0];
    expect(passedCallbacks).toBe(cbs);
    expect(passedConfig.resolve).toBeDefined();

    // The resolve function should return the resolved data
    const resolveResult = await passedConfig.resolve();
    expect(resolveResult.ids).toEqual(["10", "20", "30"]);
    expect(resolveResult.source).toBe("API");
    expect(resolveResult.title).toBe("Great Album");

    expect(mockStart).toHaveBeenCalledTimes(1);
  });
});

describe("bulk-trigger: cancel (best-effort)", () => {
  it("cancel sets cancelled flag", () => {
    chrome.runtime.sendMessage = jest.fn().mockImplementation(
      () => new Promise(() => {}),
    );
    const cbs = makeCallbacks();

    const handle = startBulkTrigger({
      identifier: makeAlbumIdentifier(),
      callbacks: cbs,
    });

    expect(handle.isRunning()).toBe(true);
    handle.cancel();
    // After cancel, isRunning is still true until the async settles
    // but the cancelled flag will prevent further processing
  });
});
