/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}
 */

/**
 * Integration test — youtube-download-mux-corruption-fix Task 5.1
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4**
 *
 * End-to-end content-script ↔ bridge response shape test for a
 * synthetic capture that mirrors a real ~116-second 1080p YouTube
 * watch session:
 *
 *   - 30 audio iTag-140 (AAC, mdhd timescale 44100) moof+mdat
 *     fragments with `tfdt.baseMediaDecodeTime` covering [0, 116] s.
 *   - 30 video iTag-137 (H.264 1080p, mdhd timescale 15360) moof+mdat
 *     fragments with `tfdt.baseMediaDecodeTime` covering [0, 116] s.
 *   - One ISOBMFF init segment per iTag (ftyp + moov > trak > mdia >
 *     mdhd) so `parseTrackTimescale` returns the correct divisor for
 *     `computeLastTimestampSec`.
 *
 * The test drives `handleGetMediaBuffer` end-to-end through the
 * bridge IIFE harness from `tests/yt-content/yt-page-bridge.test-helpers.ts`:
 *
 *   1. **Happy path (`audio 116s ≈ video 116s`)** — coverage gate
 *      passes, `MEDIA_BUFFER_RESPONSE` carries non-empty `audioData`
 *      and `videoData`. Both `audioSize > 0` AND `videoSize > 0`.
 *   2. **Coverage mismatch (`audio 116s vs video 110s`)** — coverage
 *      gate fires (diff > 1.0 s), `MEDIA_BUFFER_RESPONSE` carries the
 *      empty sentinel: `audioSize === 0` AND `videoSize === 0`,
 *      `audioData === null` AND `videoData === null`.
 *
 * NOT exercised here: ffmpeg.wasm, offscreen muxer, content-script
 * click-flow. We test the bridge's `MEDIA_BUFFER_RESPONSE` shape ONLY
 * — the contract `yt-content.ts` reads to drive
 * `BUFFER_CAPTURE_FAILED` vs `YT_DOWNLOAD_VIDEO`.
 */

import {
  buildBareMoofMdatFragment,
  buildIsobmffInitSegment,
  buildSingleChunkUmpBody,
  clearBridgeBuffer,
  feedBridgeOneResponse,
  getMediaBufferFromBridge,
  installBridgeFetch,
  loadBridgeIIFE,
  padUmpBody,
} from "../yt-content/yt-page-bridge.test-helpers";

// ─── Constants matching the synthetic capture ───────────────────────────────

/** The videoId the bridge reads from `location.search` for our jsdom URL. */
const PAGE_VIDEO_ID = "dQw4w9WgXcQ";

/** Audio iTag — AAC m4a 128 kbps. mdhd.timescale conventionally 44100. */
const AUDIO_ITAG = 140;
/** mdhd.timescale used by AAC tracks delivered over YouTube SABR. */
const AUDIO_TIMESCALE = 44100;

/** Video iTag — H.264 1080p mp4. mdhd.timescale conventionally 15360. */
const VIDEO_ITAG = 137;
/** mdhd.timescale used by H.264 1080p tracks delivered over YouTube SABR. */
const VIDEO_TIMESCALE = 15360;

/** Number of media fragments per iTag, mirroring a real 116-s capture. */
const NUM_FRAGMENTS = 30;

/** Per-fragment mdat payload size — kept large enough that the picked
 *  buffer comfortably exceeds the 100 KB threshold required by the
 *  task acceptance criteria, and the per-response UMP body always
 *  exceeds the bridge's 100-byte filter without padding. */
const AUDIO_MDAT_BYTES = 4 * 1024; // 4 KB → ~120 KB total over 30 fragments
const VIDEO_MDAT_BYTES = 8 * 1024; // 8 KB → ~240 KB total over 30 fragments

// ─── helpers ────────────────────────────────────────────────────────────────

/** Build a deterministic distractor mdat payload of `length` bytes. */
function buildMdatPayload(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (seed * 31 + i * 17) & 0xff;
  }
  return out;
}

/**
 * Compute monotonic `tfdt.baseMediaDecodeTime` values that span exactly
 * `coverageSec` seconds across `numFragments` fragments at the given
 * `timescale`. tfdt[0] = 0; tfdt[numFragments - 1] = coverageSec * timescale.
 *
 * This mirrors what real YouTube SABR ships — fragment N's tfdt is
 * the decode time of its first sample in track timescale units.
 */
function computeTfdtSchedule(
  coverageSec: number,
  numFragments: number,
  timescale: number,
): number[] {
  const out: number[] = [];
  const lastTfdt = coverageSec * timescale;
  for (let i = 0; i < numFragments; i++) {
    // Even spread: tfdt[i] = round(i / (N-1) * lastTfdt) so first = 0
    // and last = coverageSec * timescale exactly.
    const t = Math.round((i / (numFragments - 1)) * lastTfdt);
    out.push(t);
  }
  return out;
}

/**
 * Drive the bridge through one synthetic capture: feed the iTag's init
 * segment, then `numFragments` moof+mdat media fragments with monotonic
 * `tfdt.baseMediaDecodeTime` values spanning `coverageSec` seconds.
 *
 * Each fragment is shipped as its own UMP response keyed off `itag`.
 * The bridge's per-response chunk store records each one with a fresh
 * `arrivalIdx`, and `flattenItagFromResponses` will sort by `minTime`
 * with `arrivalIdx` as tiebreak. mdat payloads are deterministically
 * distinct per fragment so the 32-byte prefix-hash dedup never drops
 * any of them.
 *
 * The init segment is shipped FIRST so that `parseTrackTimescale`
 * (used by the coverage gate via `computeLastTimestampSec`) finds the
 * correct timescale when probing `chunks.find(c => c.isInit)`.
 */
async function feedTrack(
  harness: ReturnType<typeof installBridgeFetch>,
  itag: number,
  timescale: number,
  coverageSec: number,
  numFragments: number,
  mdatBytes: number,
  /** Distinct seed prefix so audio and video mdats never share bytes. */
  seedOffset: number,
): Promise<void> {
  // 1. Init segment (ftyp + moov > trak > mdia > mdhd(timescale)).
  const init = buildIsobmffInitSegment(timescale);
  await feedBridgeOneResponse(
    harness,
    padUmpBody(buildSingleChunkUmpBody(itag, init)),
  );

  // 2. Per-fragment moof+mdat with tfdt[i] spanning [0, coverageSec].
  const tfdtSchedule = computeTfdtSchedule(coverageSec, numFragments, timescale);
  for (let i = 0; i < numFragments; i++) {
    const mdat = buildMdatPayload(seedOffset + i, mdatBytes);
    const frag = buildBareMoofMdatFragment(
      tfdtSchedule[i],
      mdat,
      /* sequenceNumber */ i + 1,
    );
    // mdatBytes is already > 100 so the body comfortably exceeds the
    // bridge's 100-byte filter without explicit padding, but we pad
    // anyway for symmetry with the rest of the suite.
    await feedBridgeOneResponse(
      harness,
      padUmpBody(buildSingleChunkUmpBody(itag, frag)),
    );
  }
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe("Integration: synthetic 116s capture → flatten → strip → bridge", () => {
  // Console noise from the bridge IIFE is not relevant to assertion
  // outcomes — we silence it for clarity in test reports.
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
    "happy path: audio 116s ≈ video 116s → both tracks shipped " +
      "(audioSize > 100 KB AND videoSize > 100 KB)",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        clearBridgeBuffer(PAGE_VIDEO_ID);

        // Audio: 30 fragments spanning [0, 116] s at timescale 44100.
        await feedTrack(
          harness,
          AUDIO_ITAG,
          AUDIO_TIMESCALE,
          /* coverageSec */ 116,
          NUM_FRAGMENTS,
          AUDIO_MDAT_BYTES,
          /* seedOffset */ 1000,
        );
        // Video: 30 fragments spanning [0, 116] s at timescale 15360.
        await feedTrack(
          harness,
          VIDEO_ITAG,
          VIDEO_TIMESCALE,
          /* coverageSec */ 116,
          NUM_FRAGMENTS,
          VIDEO_MDAT_BYTES,
          /* seedOffset */ 2000,
        );

        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);
        const audioSize = Number(resp.audioSize ?? 0);
        const videoSize = Number(resp.videoSize ?? 0);
        const audioData = resp.audioData as ArrayBuffer | null;
        const videoData = resp.videoData as ArrayBuffer | null;
        const audioItag = Number(resp.audioItag ?? 0);
        const videoItag = Number(resp.videoItag ?? 0);

        // Both tracks shipped, well above the 100 KB threshold from the
        // task acceptance criteria.
        expect(audioSize).toBeGreaterThan(100 * 1024);
        expect(videoSize).toBeGreaterThan(100 * 1024);
        expect(audioData).not.toBeNull();
        expect(videoData).not.toBeNull();
        expect(audioItag).toBe(AUDIO_ITAG);
        expect(videoItag).toBe(VIDEO_ITAG);
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    60_000,
  );

  it(
    "coverage mismatch: audio reaches 116s, video reaches only 110s " +
      "→ empty sentinel (audioSize=0, videoSize=0, *Data=null)",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        clearBridgeBuffer(PAGE_VIDEO_ID);

        // Audio fully covers 116 s.
        await feedTrack(
          harness,
          AUDIO_ITAG,
          AUDIO_TIMESCALE,
          /* coverageSec */ 116,
          NUM_FRAGMENTS,
          AUDIO_MDAT_BYTES,
          /* seedOffset */ 3000,
        );
        // Video covers only 110 s — 6 s short of audio. The coverage
        // gate (`Math.abs(audioLastSec - videoLastSec) > 1.0`) fires
        // because |116 - 110| = 6 > 1, and `handleGetMediaBuffer`
        // posts the empty sentinel.
        await feedTrack(
          harness,
          VIDEO_ITAG,
          VIDEO_TIMESCALE,
          /* coverageSec */ 110,
          NUM_FRAGMENTS,
          VIDEO_MDAT_BYTES,
          /* seedOffset */ 4000,
        );

        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);
        const audioSize = Number(resp.audioSize ?? 0);
        const videoSize = Number(resp.videoSize ?? 0);
        const audioData = resp.audioData as ArrayBuffer | null;
        const videoData = resp.videoData as ArrayBuffer | null;

        // Empty sentinel — content script reads this and drives
        // BUFFER_CAPTURE_FAILED instead of saving a truncated MP4.
        expect(audioSize).toBe(0);
        expect(videoSize).toBe(0);
        expect(audioData).toBeNull();
        expect(videoData).toBeNull();
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    60_000,
  );
});
