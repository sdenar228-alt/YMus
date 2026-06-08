/**
 * @jest-environment jsdom
 */
/**
 * Bug Condition Exploration Test: VK Playlist Download Uses Player API and Clicks "Слушать"
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4
 *
 * This test encodes the EXPECTED (correct) behavior:
 * - handlePlaylistClick should collect tracks from DOM with correct artist/title
 * - "Слушать" button should NOT be clicked
 * - Unavailable tracks should NOT be included
 *
 * On UNFIXED code this test is EXPECTED TO FAIL — that failure proves the bug exists.
 * After the fix, this test should PASS.
 */

import * as fc from "fast-check";

// ─── Arbitraries ────────────────────────────────────────────────────────────

const artistArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0 && s !== "Unknown"),
  fc.constant("Кино"),
  fc.constant("Imagine Dragons"),
  fc.constant("Noize MC"),
);

const titleArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0 && s !== "audio"),
  fc.constant("Группа крови"),
  fc.constant("Believer"),
  fc.constant("Выдыхай"),
);

const ownerIdArb = fc.integer({ min: -999999, max: 999999 }).filter((n) => n !== 0).map(String);
const audioIdArb = fc.integer({ min: 1, max: 999999 }).map(String);

interface TrackInput {
  ownerId: string;
  audioId: string;
  artist: string;
  title: string;
  unavailable: boolean;
}

const trackInputArb: fc.Arbitrary<TrackInput> = fc.record({
  ownerId: ownerIdArb,
  audioId: audioIdArb,
  artist: artistArb,
  title: titleArb,
  unavailable: fc.boolean(),
});

// Generate a playlist with at least 1 available and 1 unavailable track
const playlistArb = fc.tuple(
  // At least one available track
  trackInputArb.map((t) => ({ ...t, unavailable: false })),
  // At least one unavailable track
  trackInputArb.map((t) => ({ ...t, unavailable: true })),
  // Additional random tracks (0-5)
  fc.array(trackInputArb, { minLength: 0, maxLength: 5 }),
).map(([available, unavailable, rest]) => [available, unavailable, ...rest]);

// ─── DOM Builder ────────────────────────────────────────────────────────────

function buildPlaylistDOM(tracks: TrackInput[]): {
  listenBtnClicked: () => boolean;
} {
  document.body.innerHTML = "";

  // Create playlist container
  const container = document.createElement("div");
  container.className = "AudioPlaylist__list_abc123";

  // Create actions area with "Слушать" button
  const actionsDiv = document.createElement("div");
  actionsDiv.className = "AudioPlaylist__actions_xyz";

  const listenBtn = document.createElement("button");
  listenBtn.textContent = "Слушать";
  let listenClicked = false;
  listenBtn.addEventListener("click", () => {
    listenClicked = true;
  });
  actionsDiv.appendChild(listenBtn);
  document.body.appendChild(actionsDiv);

  // Create audio rows
  for (const track of tracks) {
    const row = document.createElement("div");
    row.className = track.unavailable
      ? "audio_row audio_row__unavailable"
      : "audio_row";
    row.setAttribute("data-full-id", `${track.ownerId}_${track.audioId}`);

    // data-audio: [audioId, ownerId, encryptedUrl, title, artist]
    const dataAudio = JSON.stringify([
      parseInt(track.audioId),
      parseInt(track.ownerId),
      "https://encrypted.url/test",
      track.title,
      track.artist,
    ]);
    row.setAttribute("data-audio", dataAudio);

    // Also add DOM elements for artist/title fallback
    const titleEl = document.createElement("span");
    titleEl.className = "audio_row__title_inner";
    titleEl.textContent = track.title;
    row.appendChild(titleEl);

    const artistEl = document.createElement("span");
    artistEl.className = "audio_row__performers";
    artistEl.textContent = track.artist;
    row.appendChild(artistEl);

    container.appendChild(row);
  }

  document.body.appendChild(container);

  // Create playlist title element
  const titleHeader = document.createElement("h1");
  titleHeader.className = "AudioPlaylist__title_abc";
  titleHeader.textContent = "Test Playlist";
  document.body.appendChild(titleHeader);

  return { listenBtnClicked: () => listenClicked };
}

// ─── Mock for getPlaylistTracksFromBridge (simulates player API bug) ────────

/**
 * We need to test handlePlaylistClick which is not exported directly.
 * We'll test by importing the module and triggering the button click flow.
 * 
 * Since handlePlaylistClick is internal, we test indirectly through
 * startVkPlaylistInjector → clicking the injected button.
 */

// ─── Property Test ──────────────────────────────────────────────────────────

describe("Bug Condition: VK Playlist Download Uses Player API and Clicks 'Слушать'", () => {
  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = "";
    // Mock setTimeout to resolve immediately for testing
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
   *
   * Property: For any playlist page with audio rows containing valid artist/title
   * in DOM, and some rows marked as unavailable:
   * 1. handlePlaylistClick should NOT click the "Слушать" button
   * 2. Tracks should have non-empty, correct artist/title (not "Unknown", not "audio")
   * 3. Unavailable tracks should NOT be included in the result
   *
   * On UNFIXED code:
   * - handlePlaylistClick clicks "Слушать" (listenBtn.click())
   * - Uses player API (getPlaylistTracksFromBridge) which returns empty/wrong metadata
   * - Does not filter unavailable tracks
   *
   * This test asserts EXPECTED behavior, so it FAILS on unfixed code.
   */
  it("handlePlaylistClick should collect DOM tracks without clicking 'Слушать' and filter unavailable", async () => {
    await fc.assert(
      fc.asyncProperty(playlistArb, async (tracks) => {
        jest.resetModules();

        // Build DOM with tracks
        const { listenBtnClicked } = buildPlaylistDOM(tracks);

        // Mock the custom event for getPlaylistTracksFromBridge
        // Simulate player API returning tracks with EMPTY artist/title (the bug)
        document.addEventListener("ymus-get-playlist-tracks", (event: Event) => {
          const detail = (event as CustomEvent).detail;
          // Return tracks with empty metadata (simulating player API bug)
          const emptyTracks = tracks.map((t) => ({
            ownerId: t.ownerId,
            audioId: t.audioId,
            artist: "", // Player API returns empty
            title: "", // Player API returns empty
          }));
          document.dispatchEvent(
            new CustomEvent("ymus-playlist-tracks-result", {
              detail: { requestId: detail.requestId, tracks: emptyTracks },
            }),
          );
        });

        // Import the module fresh
        const { startVkPlaylistInjector } = await import(
          "../../src/vk-content/vk-playlist"
        );

        // Track what onDownloadPlaylist receives
        let receivedTracks: any[] | null = null;
        const onDownloadPlaylist = jest.fn(
          (downloadTracks: any[], _title: string, _progress: any) => {
            receivedTracks = downloadTracks;
          },
        );

        // Start the injector — this will inject the "Скачать плейлист" button
        startVkPlaylistInjector(onDownloadPlaylist);

        // Find and click the injected download button
        const downloadBtn = document.querySelector(
          ".ymus-vk-playlist-btn",
        ) as HTMLButtonElement;
        expect(downloadBtn).not.toBeNull();

        // Click the download button
        downloadBtn!.click();

        // Fast-forward all timers (the 1500ms wait and 5000ms timeout)
        await jest.advanceTimersByTimeAsync(6000);

        // ─── Assertions (EXPECTED behavior) ─────────────────────────────

        // 1. "Слушать" button should NOT have been clicked
        expect(listenBtnClicked()).toBe(false);

        // 2. onDownloadPlaylist should have been called
        expect(onDownloadPlaylist).toHaveBeenCalled();

        if (receivedTracks === null) {
          // If no tracks received, that's also a bug condition failure
          return;
        }

        const resultTracks = receivedTracks as any[];

        // 3. All received tracks should have non-empty, correct artist/title
        for (const track of resultTracks) {
          expect(track.artist).not.toBe("");
          expect(track.artist).not.toBe("Unknown");
          expect(track.title).not.toBe("");
          expect(track.title).not.toMatch(/^audio_?\d*$/);
        }

        // 4. No unavailable tracks should be included
        const unavailableIds = new Set(
          tracks
            .filter((t) => t.unavailable)
            .map((t) => `${t.ownerId}_${t.audioId}`),
        );

        for (const track of resultTracks) {
          const key = `${track.ownerId}_${track.audioId}`;
          expect(unavailableIds.has(key)).toBe(false);
        }

        // 5. All available tracks from DOM should be present
        const availableTracks = tracks.filter((t) => !t.unavailable);
        expect(resultTracks.length).toBe(availableTracks.length);
      }),
      { numRuns: 30 },
    );
  });
});
