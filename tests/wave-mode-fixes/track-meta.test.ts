/**
 * @jest-environment jsdom
 *
 * Bug 1 — Wave Title / Wave Artist exploration test.
 *
 * Bug Condition (from design.md `isBugCondition_1`):
 *   isWaveMode(url) AND externalAPI=null AND ogTitle CONTAINS "собираем музыку"
 *
 * Expected behavior (Property 1, validates Requirements 2.1, 2.2):
 *   meta !== null
 *   AND meta.title !== "Яндекс Музыка — собираем музыку и подкасты для вас"
 *   AND meta.title === <player-bar track text>
 *   AND meta.artist === <player-bar artist text>
 *   AND meta.trackId === "<track>:<album>"
 *
 * EXPECTATION ON UNFIXED CODE: this suite MUST FAIL.
 * The current `extractTrackMeta()` (src/content/track-meta.ts):
 *   1. readFromExternalAPI() → null (externalAPI undefined on wave)
 *   2. readFromMetaTags() → returns the Page Title Literal as `title`
 *      (no filter for "собираем музыку")
 *   3. readFromDOM() → finds the trackId from `[class*="PlayerBar"] a[href*="/track/"]`,
 *      so `trackId === "200:100"` is observable; but the artist/title are still
 *      taken from og:title (Page Title Literal).
 *   4. Final result: { trackId: "200:100", artist: "Яндекс Музыка", title: "собираем музыку и подкасты для вас" }
 *      (split on " — "). meta.title is therefore the Page Title Literal split,
 *      NOT "Хочешь?".
 *
 * Documented counterexamples (recorded after running this test on unfixed code):
 *   [CONCRETE]   extractTrackMeta() returned title = "собираем музыку и подкасты для вас"
 *                instead of "Хочешь?". Expected meta = { trackId: "200:100",
 *                artist: "Земфира", title: "Хочешь?" }; received title is the
 *                Page Title Literal split via og:title.
 *   [PBT]        fast-check shrunk to ["а", "а", 1, 1] — i.e. for the smallest
 *                possible track title "а" and artist "а", extractTrackMeta()
 *                still returned title = "собираем музыку и подкасты для вас".
 *                Confirms the unfixed code never reads the player-bar text and
 *                always falls back to og:title.
 */

import fc from "fast-check";

// Russian letter sets used to generate plausible track/artist names.
// We avoid characters that could collide with the Page Title Literal fragments
// ("собираем музыку") to keep the property well-defined.
const CYRILLIC_LETTERS =
  "абвгдеёжзийклмнопрстуфхцчшщъыьэюяАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ";
const SAFE_LETTERS = CYRILLIC_LETTERS + "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ ";

const PAGE_TITLE_LITERAL =
  "Яндекс Музыка — собираем музыку и подкасты для вас";

function setupWaveModeDOM(opts: {
  trackId: string;
  albumId: string;
  trackTitle: string;
  artistName: string;
}): void {
  // Wave URL — use jsdom's navigation API to set location.
  // window.location.href is read-only; we use history.replaceState instead so
  // that location.search and URL parsing both reflect the wave parameter.
  window.history.replaceState({}, "", "/?wave=onyourwave");

  // og:title — Page Title Literal (the bug condition).
  const meta = document.createElement("meta");
  meta.setAttribute("property", "og:title");
  meta.setAttribute("content", PAGE_TITLE_LITERAL);
  document.head.appendChild(meta);

  // Player bar with anchor links to track and artist.
  const playerBar = document.createElement("div");
  playerBar.className = "PlayerBarDesktop_root__ABC123";
  document.body.appendChild(playerBar);

  const trackLink = document.createElement("a");
  trackLink.setAttribute("href", `/album/${opts.albumId}/track/${opts.trackId}`);
  trackLink.textContent = opts.trackTitle;
  playerBar.appendChild(trackLink);

  const artistLink = document.createElement("a");
  artistLink.setAttribute("href", `/artist/300`);
  artistLink.textContent = opts.artistName;
  playerBar.appendChild(artistLink);

  // externalAPI = undefined (the bug condition).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).externalAPI;
}

function setupWaveModeTextOnlyPlayer(opts: {
  playerText: string;
}): void {
  window.history.replaceState({}, "", "/?wave=onyourwave");

  const meta = document.createElement("meta");
  meta.setAttribute("property", "og:title");
  meta.setAttribute("content", PAGE_TITLE_LITERAL);
  document.head.appendChild(meta);

  const playerBar = document.createElement("div");
  playerBar.className = "PlayerBarDesktop_root__TEXT_ONLY";
  document.body.appendChild(playerBar);

  const titleEl = document.createElement("div");
  titleEl.className = "PlayerBarDesktop_title__TEXT_ONLY";
  titleEl.textContent = opts.playerText;
  playerBar.appendChild(titleEl);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).externalAPI;
}

function attachReactTrackToTextOnlyPlayer(opts: {
  trackId: string;
  albumId: string;
  title: string;
  artists: string[];
}): void {
  const titleEl = document.querySelector(".PlayerBarDesktop_title__TEXT_ONLY");
  if (titleEl === null) throw new Error("text-only player title missing");

  Object.defineProperty(titleEl, "__reactFiber$ymd_test", {
    configurable: true,
    enumerable: true,
    value: {
      memoizedProps: {
        track: {
          id: opts.trackId,
          albums: [{ id: opts.albumId }],
          title: opts.title,
          artists: opts.artists.map((name) => ({ name })),
        },
      },
      return: null,
    },
  });
}

function resetDOM(): void {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  // Reset location to a benign default.
  window.history.replaceState({}, "", "/");
}

describe("Bug 1 — Wave Mode track-meta returns Page Title Literal instead of real track", () => {
  // We require a fresh module import so any module-level memoization is reset.
  // (`extractTrackMeta` itself has no module-level state, but this keeps the
  // suite robust against future memoization.)
  let extractTrackMeta: () => unknown;

  beforeEach(() => {
    jest.resetModules();
    resetDOM();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    extractTrackMeta = require("../../src/content/track-meta").extractTrackMeta;
  });

  afterEach(() => {
    resetDOM();
  });

  // ─── Concrete example (Хочешь? / Земфира) ──────────────────────────────────

  it("[CONCRETE] extracts real track from player bar on wave URL with Page Title Literal og:title", () => {
    setupWaveModeDOM({
      trackId: "200",
      albumId: "100",
      trackTitle: "Хочешь?",
      artistName: "Земфира",
    });

    const meta = extractTrackMeta() as
      | { trackId: string; artist: string; title: string }
      | null;

    // Property: fixed extractTrackMeta returns valid meta with real values.
    expect(meta).not.toBeNull();
    expect(meta?.title).not.toBe(PAGE_TITLE_LITERAL);
    expect(meta?.title).toBe("Хочешь?");
    expect(meta?.artist).toBe("Земфира");
    expect(meta?.trackId).toBe("200:100");
  });

  // ─── PBT: many artist/title/trackId combinations ───────────────────────────

  it("[PBT] for any wave-bug-condition input, extractTrackMeta returns player-bar values, never Page Title Literal", () => {
    fc.assert(
      fc.property(
        // Track title: 1..40 chars from a safe alphabet, never empty/whitespace,
        // never accidentally containing the Page Title Literal fragment.
        fc
          .stringOf(fc.constantFrom(...SAFE_LETTERS.split("")), {
            minLength: 1,
            maxLength: 40,
          })
          .filter(
            (s) =>
              s.trim().length > 0 &&
              !s.toLowerCase().includes("собираем музыку") &&
              !s.toLowerCase().includes("music for you"),
          ),
        // Artist name: same shape.
        fc
          .stringOf(fc.constantFrom(...SAFE_LETTERS.split("")), {
            minLength: 1,
            maxLength: 40,
          })
          .filter(
            (s) =>
              s.trim().length > 0 &&
              !s.toLowerCase().includes("собираем музыку") &&
              !s.toLowerCase().includes("music for you"),
          ),
        // Track + album numeric IDs.
        fc.integer({ min: 1, max: 9_999_999 }),
        fc.integer({ min: 1, max: 9_999_999 }),
        (rawTitle, rawArtist, trackIdNum, albumIdNum) => {
          const trackTitle = rawTitle.trim();
          const artistName = rawArtist.trim();
          const trackId = String(trackIdNum);
          const albumId = String(albumIdNum);

          resetDOM();
          setupWaveModeDOM({ trackId, albumId, trackTitle, artistName });

          const meta = extractTrackMeta() as
            | { trackId: string; artist: string; title: string }
            | null;

          // Validates: Requirements 2.1, 2.2
          expect(meta).not.toBeNull();
          expect(meta?.title).not.toBe(PAGE_TITLE_LITERAL);
          expect(meta?.title).toBe(trackTitle);
          expect(meta?.artist).toBe(artistName);
          expect(meta?.trackId).toBe(`${trackId}:${albumId}`);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("Regression — Wave Mode prefers now-playing DOM over bridge prefetch", () => {
  beforeEach(() => {
    jest.resetModules();
    resetDOM();
  });

  afterEach(() => {
    jest.dontMock("../../src/content/ym-bridge-listener");
    resetDOM();
  });

  it("[CONCRETE] downloads the current player-bar track when the bridge last saw the next track", () => {
    setupWaveModeDOM({
      trackId: "200",
      albumId: "100",
      trackTitle: "Текущий трек",
      artistName: "Текущий артист",
    });

    jest.doMock("../../src/content/ym-bridge-listener", () => ({
      getLastBridgeTrack: () => ({
        trackId: "201",
        albumId: "101",
        artist: "Следующий артист",
        title: "Следующий трек",
        receivedAt: Date.now(),
      }),
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { extractTrackMeta } = require("../../src/content/track-meta");
    const meta = extractTrackMeta() as
      | { trackId: string; artist: string; title: string }
      | null;

    expect(meta).toEqual({
      trackId: "200:100",
      artist: "Текущий артист",
      title: "Текущий трек",
    });
  });

  it("[CONCRETE] uses playback bridge id with visible text-only player metadata", () => {
    setupWaveModeTextOnlyPlayer({
      playerText: "Evillfan, tixaye! — буду не в сети",
    });

    jest.doMock("../../src/content/ym-bridge-listener", () => ({
      getLastBridgeTrack: () => ({
        trackId: "200",
        albumId: "100",
        artist: "Evillfan, tixaye!",
        title: "буду не в сети",
        detectionSource: "playback",
        receivedAt: Date.now(),
      }),
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { extractTrackMeta } = require("../../src/content/track-meta");
    const meta = extractTrackMeta() as
      | { trackId: string; artist: string; title: string }
      | null;

    expect(meta).toEqual({
      trackId: "200:100",
      artist: "Evillfan, tixaye!",
      title: "буду не в сети",
    });
  });

  it("[CONCRETE] ignores prefetch bridge id when visible text belongs to another current track", () => {
    setupWaveModeTextOnlyPlayer({
      playerText: "Evillfan, tixaye! — буду не в сети",
    });

    jest.doMock("../../src/content/ym-bridge-listener", () => ({
      getLastBridgeTrack: () => ({
        trackId: "201",
        albumId: "101",
        artist: "kokaa",
        title: "ноги",
        detectionSource: "prefetch",
        receivedAt: Date.now(),
      }),
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { extractTrackMeta } = require("../../src/content/track-meta");
    const meta = extractTrackMeta() as
      | { trackId: string; artist: string; title: string }
      | null;

    expect(meta).toBeNull();
  });

  it("[CONCRETE] extracts current id from React props when bridge points at next track", () => {
    setupWaveModeTextOnlyPlayer({
      playerText: "Evillfan, tixaye! — буду не в сети",
    });
    attachReactTrackToTextOnlyPlayer({
      trackId: "200",
      albumId: "100",
      title: "буду не в сети",
      artists: ["Evillfan", "tixaye!"],
    });

    jest.doMock("../../src/content/ym-bridge-listener", () => ({
      getLastBridgeTrack: () => ({
        trackId: "201",
        albumId: "101",
        artist: "kokaa",
      title: "ноги",
        detectionSource: "playback",
        receivedAt: Date.now(),
      }),
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { extractTrackMeta } = require("../../src/content/track-meta");
    const meta = extractTrackMeta() as
      | { trackId: string; artist: string; title: string }
      | null;

    expect(meta).toEqual({
      trackId: "200:100",
      artist: "Evillfan, tixaye!",
      title: "буду не в сети",
    });
  });

  it("[CONCRETE] ignores wave bridge id when no visible player metadata confirms it", () => {
    window.history.replaceState({}, "", "/?wave=onyourwave");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).externalAPI;

    jest.doMock("../../src/content/ym-bridge-listener", () => ({
      getLastBridgeTrack: () => ({
        trackId: "201",
        albumId: "101",
        artist: "kokaa",
        title: "ноги",
        detectionSource: "playback",
        receivedAt: Date.now(),
      }),
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { extractTrackMeta } = require("../../src/content/track-meta");
    const meta = extractTrackMeta() as
      | { trackId: string; artist: string; title: string }
      | null;

    expect(meta).toBeNull();
  });
});
