/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}
 */

/**
 * Unit tests for the audio/video coverage-check inside
 * `handleGetMediaBuffer` from `src/yt-content/yt-page-bridge.ts`.
 *
 * The function is an internal closure inside the bridge IIFE; the
 * coverage gate sits between `pickBestFromResponses` and the final
 * `MEDIA_BUFFER_RESPONSE` postMessage. Two failure modes drive the
 * gate to post the empty sentinel (`audioSize: 0, videoSize: 0`):
 *
 *   1. Empty-track guard (`audioFlat.bytes.byteLength === 0` OR
 *      `videoFlat.bytes.byteLength === 0`).
 *   2. Coverage diff `Math.abs(audioLastSec - videoLastSec) > 1.0`,
 *      where `lastSec = max(c.minTime where c.minTime !== -1) /
 *      timescale`. WebM uses a fixed timescale of 1000; ISOBMFF reads
 *      the timescale from the `mdhd` box of the init segment, falling
 *      back to 1000 on parse failure.
 *
 * These tests drive the bridge through the same patched-fetch harness
 * used by the bug-condition test — feed init + media fragments per
 * iTag, then assert the gate's verdict from the `MEDIA_BUFFER_RESPONSE`
 * payload's `audioSize`/`videoSize` fields.
 *
 * Lock-in for Task 4.3 supporting unit suite of spec
 * `youtube-download-mux-corruption-fix`.
 */

import {
  buildBareMoofMdatFragment,
  buildIsobmffInitSegment,
  buildIsobmffInitSegmentNoTrak,
  buildSingleChunkUmpBody,
  clearBridgeBuffer,
  distinctMdat,
  feedBridgeOneResponse,
  getMediaBufferFromBridge,
  installBridgeFetch,
  loadBridgeIIFE,
  padUmpBody,
  type BridgeFetchHarness,
} from "./yt-page-bridge.test-helpers";

const PAGE_VIDEO_ID = "dQw4w9WgXcQ";

// Bridge's audio iTag preference order picks 140 first (when present).
const AUDIO_ITAG = 140;
// Bridge's video iTag preference order picks 137 first (when present).
const VIDEO_ITAG = 137;

/**
 * Push an init segment + a sequence of media fragments at the given
 * tfdt values for one iTag. Each fragment carries a unique
 * `mfhd.sequence_number` so the 32-byte prefix-hash dedup keeps them
 * apart even when two fragments have the same `tfdt`.
 */
async function pushTrack(
  harness: BridgeFetchHarness,
  itag: number,
  initSegment: Uint8Array | null,
  tfdtValues: readonly number[],
  seedBase: number,
): Promise<void> {
  if (initSegment) {
    await feedBridgeOneResponse(
      harness,
      padUmpBody(buildSingleChunkUmpBody(itag, initSegment)),
    );
  }
  let seq = 1;
  for (const t of tfdtValues) {
    const frag = buildBareMoofMdatFragment(
      t,
      distinctMdat(seedBase + t, 16),
      seq++,
    );
    await feedBridgeOneResponse(
      harness,
      padUmpBody(buildSingleChunkUmpBody(itag, frag)),
    );
  }
}

describe("handleGetMediaBuffer coverage-check (Task 4.3 — gate behaviour)", () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    jest.resetModules();
  });

  it(
    "both tracks fully covered, diff < 1s: response with non-zero audioSize/videoSize",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        clearBridgeBuffer(PAGE_VIDEO_ID);

        // timescale=1000 → tfdt is in ms. Audio reaches 10000ms (10s),
        // video reaches 10000ms (10s) → diff = 0s → gate passes.
        const audioInit = buildIsobmffInitSegment(/* timescale */ 1000);
        const videoInit = buildIsobmffInitSegment(/* timescale */ 1000);

        await pushTrack(harness, AUDIO_ITAG, audioInit, [0, 5000, 10000], 1);
        await pushTrack(harness, VIDEO_ITAG, videoInit, [0, 5000, 10000], 1000);

        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);

        expect(Number(resp.audioSize)).toBeGreaterThan(0);
        expect(Number(resp.videoSize)).toBeGreaterThan(0);
        expect(resp.audioData).not.toBeNull();
        expect(resp.videoData).not.toBeNull();
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    20_000,
  );

  it(
    "audio fully covered, video short by 6s: empty sentinel",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        clearBridgeBuffer(PAGE_VIDEO_ID);

        // timescale=1000. Audio reaches 116000ms (116s); video reaches
        // 110000ms (110s) → diff = 6s > 1.0 → empty sentinel.
        const audioInit = buildIsobmffInitSegment(1000);
        const videoInit = buildIsobmffInitSegment(1000);

        await pushTrack(
          harness,
          AUDIO_ITAG,
          audioInit,
          [0, 50000, 100000, 116000],
          1,
        );
        await pushTrack(
          harness,
          VIDEO_ITAG,
          videoInit,
          [0, 50000, 100000, 110000],
          1000,
        );

        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);

        expect(Number(resp.audioSize)).toBe(0);
        expect(Number(resp.videoSize)).toBe(0);
        expect(resp.audioData).toBeNull();
        expect(resp.videoData).toBeNull();
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    20_000,
  );

  it(
    "video fully covered, audio short by 6s: empty sentinel",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        clearBridgeBuffer(PAGE_VIDEO_ID);

        // Symmetry check: roles swapped — audio is now the short
        // track. Gate uses absolute diff so direction does not matter.
        const audioInit = buildIsobmffInitSegment(1000);
        const videoInit = buildIsobmffInitSegment(1000);

        await pushTrack(
          harness,
          AUDIO_ITAG,
          audioInit,
          [0, 50000, 100000, 110000],
          1,
        );
        await pushTrack(
          harness,
          VIDEO_ITAG,
          videoInit,
          [0, 50000, 100000, 116000],
          1000,
        );

        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);

        expect(Number(resp.audioSize)).toBe(0);
        expect(Number(resp.videoSize)).toBe(0);
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    20_000,
  );

  it(
    "audio empty, video full: empty sentinel",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        clearBridgeBuffer(PAGE_VIDEO_ID);

        // No audio chunks at all. `pickBestFromResponses` for audio
        // returns null, and `handleGetMediaBuffer` ships the empty
        // sentinel because audioFlat is null (one-sided picks fall
        // through to the post-gate `audioFlat ? ... : null` branch).
        const videoInit = buildIsobmffInitSegment(1000);
        await pushTrack(
          harness,
          VIDEO_ITAG,
          videoInit,
          [0, 5000, 10000],
          1000,
        );

        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);

        // audio side empty.
        expect(Number(resp.audioSize)).toBe(0);
        expect(resp.audioData).toBeNull();
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    20_000,
  );

  it(
    "both tracks empty: empty sentinel",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        clearBridgeBuffer(PAGE_VIDEO_ID);

        // No fetches at all → no chunks for PAGE_VIDEO_ID.
        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);

        expect(Number(resp.audioSize)).toBe(0);
        expect(Number(resp.videoSize)).toBe(0);
        expect(resp.audioData).toBeNull();
        expect(resp.videoData).toBeNull();
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    20_000,
  );

  it(
    "diff exactly 1.0s: NOT a mismatch (boundary > 1.0)",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        clearBridgeBuffer(PAGE_VIDEO_ID);

        // timescale=1000. Audio reaches 11000ms (11s); video reaches
        // 10000ms (10s) → diff = 1.0s exactly. Gate uses `> 1.0`
        // (strict greater-than), so the pair is shipped as-is.
        const audioInit = buildIsobmffInitSegment(1000);
        const videoInit = buildIsobmffInitSegment(1000);

        await pushTrack(
          harness,
          AUDIO_ITAG,
          audioInit,
          [0, 5000, 11000],
          1,
        );
        await pushTrack(
          harness,
          VIDEO_ITAG,
          videoInit,
          [0, 5000, 10000],
          1000,
        );

        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);

        expect(Number(resp.audioSize)).toBeGreaterThan(0);
        expect(Number(resp.videoSize)).toBeGreaterThan(0);
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    20_000,
  );

  it(
    "parseTrackTimescale = 0 (init unparseable): falls back to timescale=1000",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        clearBridgeBuffer(PAGE_VIDEO_ID);

        // The init segment lacks a `trak` box, so `parseTrackTimescale`
        // returns 0; the gate falls back to timescale=1000 for both
        // tracks.  Audio tfdt=10000 → 10s, video tfdt=10000 → 10s
        // → diff = 0s < 1.0s → gate passes → non-zero sizes shipped.
        // If the fallback had chosen any other divisor (e.g. the raw
        // tfdt value, or the moov timescale), the diff would not
        // collapse to 0 and we could not assert non-zero sizes here.
        const audioInit = buildIsobmffInitSegmentNoTrak();
        const videoInit = buildIsobmffInitSegmentNoTrak();

        await pushTrack(harness, AUDIO_ITAG, audioInit, [0, 5000, 10000], 1);
        await pushTrack(harness, VIDEO_ITAG, videoInit, [0, 5000, 10000], 1000);

        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);

        // Both tracks shipped, sizes > 0, because the fallback
        // timescale=1000 produces the same lastSec for both tracks.
        expect(Number(resp.audioSize)).toBeGreaterThan(0);
        expect(Number(resp.videoSize)).toBeGreaterThan(0);
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    20_000,
  );
});
