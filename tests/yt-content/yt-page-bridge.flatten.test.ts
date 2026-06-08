/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}
 */

/**
 * Unit tests for `flattenItagFromResponses` from
 * `src/yt-content/yt-page-bridge.ts`.
 *
 * The function is an internal closure inside the bridge IIFE — not an
 * export — so we drive it indirectly: feed UMP-shaped responses
 * through the patched fetch hook (`installBridgeFetch` +
 * `feedBridgeOneResponse`), then call `GET_MEDIA_BUFFER` and inspect
 * the resulting `MEDIA_BUFFER_RESPONSE` payload. The `audioSize`,
 * `videoSize`, and `audioData` fields together let us reason about
 * which fragments survived dedup and what file-order the flatten
 * emitted.
 *
 * The fixed implementation does two things differently from the
 * pre-fix code (per design.md "Fix Implementation" `yt-page-bridge.ts`
 * steps 1, 2):
 *
 *   1. Dedup keys on the first 32 bytes of each chunk
 *      (`prefixHash32`) instead of `minTime`. Two distinct fragments
 *      that happen to share `tfdt.baseMediaDecodeTime` are now both
 *      preserved because their `mfhd.sequence_number` bytes (offset
 *      20..23 of the moof) make their first 32 bytes differ.
 *
 *   2. `-1`-chunks (those whose container timestamp could not be
 *      parsed) are interleaved by `arrivalIdx` rather than appended
 *      to the tail. Mixed timestamped + `-1` pairs fall back to
 *      `arrivalIdx`, so the surviving file-order tracks the order
 *      in which YouTube SABR actually delivered them.
 *
 * These tests lock in those behaviours as a Task 4.2 supporting
 * unit suite for spec `youtube-download-mux-corruption-fix`.
 */

import {
  buildBareMoofMdatFragment,
  buildBrokenTfdtFragment,
  buildSingleChunkUmpBody,
  clearBridgeBuffer,
  concat,
  distinctMdat,
  feedBridgeOneResponse,
  getMediaBufferFromBridge,
  installBridgeFetch,
  loadBridgeIIFE,
  padUmpBody,
} from "./yt-page-bridge.test-helpers";

// The videoId the bridge keys chunks under is read from
// `location.search`. Our jsdom URL is fixed at the top of this file,
// so every fixture must look up chunks under THIS id.
const PAGE_VIDEO_ID = "dQw4w9WgXcQ";

const AAC_ITAG = 140;

/**
 * Walk a flattened audio buffer and return the file-order positions
 * (0-based) of fragments identified by a 5-byte sentinel
 * `[0xDE, 0xAD, 0xBE, 0xEF, fragmentIdx]` placed at the start of each
 * `mdat` payload. The 4-byte `0xDE 0xAD 0xBE 0xEF` signature is
 * astronomically unlikely to occur inside `distinctMdat()` distractor
 * bytes, so the walker reliably picks each fragment's id from the
 * 5th byte after the sentinel.
 *
 * Returns an array of fragmentIdx values in the order they appear in
 * the flattened buffer.
 */
function walkFragmentOrder(
  flat: Uint8Array,
  knownIds: ReadonlySet<number>,
): number[] {
  const order: number[] = [];
  for (let pos = 0; pos + 4 < flat.byteLength; pos++) {
    if (
      flat[pos] === 0xde &&
      flat[pos + 1] === 0xad &&
      flat[pos + 2] === 0xbe &&
      flat[pos + 3] === 0xef
    ) {
      const id = flat[pos + 4];
      if (knownIds.has(id) && !order.includes(id)) {
        order.push(id);
      }
      // Skip past the sentinel + id byte to avoid re-matching.
      pos += 4;
    }
  }
  return order;
}

const SENTINEL = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

/**
 * Build a moof+mdat fragment whose mdat payload starts with the
 * fragment-id sentinel. `tfdt.baseMediaDecodeTime` is set per call;
 * pass `null` to produce a broken-tfdt fragment that
 * `readMinTimestamp` will return -1 for.
 */
function buildIdentifiedFragment(
  id: number,
  tfdt: number | null,
  sequenceNumber: number,
): Uint8Array {
  const mdatPayload = concat(
    SENTINEL,
    new Uint8Array([id & 0xff]),
    distinctMdat(100 + id, 32),
  );
  if (tfdt === null) {
    return buildBrokenTfdtFragment(mdatPayload, sequenceNumber);
  }
  return buildBareMoofMdatFragment(tfdt, mdatPayload, sequenceNumber);
}

describe("flattenItagFromResponses (Task 4.2 — dedup + ordering)", () => {
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
    "two distinct fragments with same minTime but different mfhd.sequence_number: both kept",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        clearBridgeBuffer(PAGE_VIDEO_ID);

        // Both fragments share `tfdt.baseMediaDecodeTime = 0` but
        // have DIFFERENT `mfhd.sequence_number` (1 vs 2) and DIFFERENT
        // mdat payloads. The 32-byte prefix-hash dedup distinguishes
        // them through the sequence_number bytes at fragment offsets
        // 20..23 (well within the first 32).
        const fragA = buildBareMoofMdatFragment(0, distinctMdat(1, 32), 1);
        const fragB = buildBareMoofMdatFragment(0, distinctMdat(2, 32), 2);
        expect(fragA).not.toEqual(fragB);

        await feedBridgeOneResponse(
          harness,
          padUmpBody(buildSingleChunkUmpBody(AAC_ITAG, fragA)),
        );
        await feedBridgeOneResponse(
          harness,
          padUmpBody(buildSingleChunkUmpBody(AAC_ITAG, fragB)),
        );

        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);
        const audioSize = Number(resp.audioSize ?? 0);

        // After flatten, both fragments survive. Bare moof+mdat is
        // returned unchanged by `stripIsobmffHeaderToMoofs` (no ftyp
        // prefix), so total bytes ≈ fragA + fragB.
        expect(audioSize).toBeGreaterThanOrEqual(
          fragA.byteLength + fragB.byteLength - 1,
        );
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    20_000,
  );

  it(
    "true duplicate (identical 32-byte prefix): one is kept",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        clearBridgeBuffer(PAGE_VIDEO_ID);

        // Two fragments with IDENTICAL bytes — the same
        // `sequence_number=1` and the same payload. The 32-byte
        // prefix is identical → dedup keeps only one. Mirrors the
        // realistic case where YouTube SABR re-delivers a fragment
        // verbatim during a gap-fill seek.
        const frag = buildBareMoofMdatFragment(0, distinctMdat(7, 32), 1);

        await feedBridgeOneResponse(
          harness,
          padUmpBody(buildSingleChunkUmpBody(AAC_ITAG, frag)),
        );
        await feedBridgeOneResponse(
          harness,
          padUmpBody(buildSingleChunkUmpBody(AAC_ITAG, frag)),
        );

        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);
        const audioSize = Number(resp.audioSize ?? 0);

        // Only one copy survives — total byte count matches a single
        // fragment, NOT 2x.
        expect(audioSize).toBe(frag.byteLength);
        expect(audioSize).toBeLessThan(frag.byteLength * 2);
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    20_000,
  );

  it(
    "-1 chunk in the middle: appears at its arrivalIdx-position, not at the tail",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        clearBridgeBuffer(PAGE_VIDEO_ID);

        // 5 fragments — the 3rd (id=2) has a broken tfdt so
        // `readMinTimestamp` returns -1. The fixed flatten interleaves
        // it by arrivalIdx, so file-order = [0, 1, 2, 3, 4].
        // (Pre-fix code dumped it to the tail → [0, 1, 3, 4, 2].)
        const fragments: Uint8Array[] = [];
        for (let i = 0; i < 5; i++) {
          const tfdt = i === 2 ? null : i * 1024;
          fragments.push(buildIdentifiedFragment(i, tfdt, i + 1));
        }

        for (const frag of fragments) {
          await feedBridgeOneResponse(
            harness,
            padUmpBody(buildSingleChunkUmpBody(AAC_ITAG, frag)),
          );
        }

        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);
        const audioData = resp.audioData as ArrayBuffer | null;
        expect(audioData).not.toBeNull();
        const flat = new Uint8Array(audioData!);

        const order = walkFragmentOrder(flat, new Set([0, 1, 2, 3, 4]));
        expect(order).toEqual([0, 1, 2, 3, 4]);
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    20_000,
  );

  it(
    "all -1 chunks: sorted by arrivalIdx",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        clearBridgeBuffer(PAGE_VIDEO_ID);

        // 5 fragments, all with broken tfdt → all minTime=-1. Fixed
        // comparator falls into the `(a.minTime === -1 && b.minTime
        // === -1)` branch: sort by arrivalIdx.
        const fragments: Uint8Array[] = [];
        for (let i = 0; i < 5; i++) {
          fragments.push(buildIdentifiedFragment(i, /* tfdt */ null, i + 1));
        }

        for (const frag of fragments) {
          await feedBridgeOneResponse(
            harness,
            padUmpBody(buildSingleChunkUmpBody(AAC_ITAG, frag)),
          );
        }

        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);
        const audioData = resp.audioData as ArrayBuffer | null;
        expect(audioData).not.toBeNull();
        const flat = new Uint8Array(audioData!);

        const order = walkFragmentOrder(flat, new Set([0, 1, 2, 3, 4]));
        expect(order).toEqual([0, 1, 2, 3, 4]);
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    20_000,
  );

  it(
    "mixed timestamped + -1: comparator preserves arrivalIdx for mixed pairs",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        clearBridgeBuffer(PAGE_VIDEO_ID);

        // Alternating timestamped and broken-tfdt fragments. Arrival
        // order (and therefore expected file-order under the fixed
        // comparator) is [0, 1, 2, 3, 4, 5].
        // Timestamped tfdt values are NON-DECREASING by arrivalIdx so
        // the timestamped-vs-timestamped branch never reorders the
        // pair — this isolates the mixed branch's `arrivalIdx`
        // tiebreak. The "mixed" branch (`a.minTime !== -1 XOR
        // b.minTime !== -1`) returns `a.arrivalIdx - b.arrivalIdx`,
        // so each -1 chunk sits exactly where it arrived.
        const tfdtSequence: Array<number | null> = [
          0,         // id=0, arrival=1
          null,      // id=1, arrival=2  ← -1 chunk
          1024,      // id=2, arrival=3
          null,      // id=3, arrival=4  ← -1 chunk
          2048,      // id=4, arrival=5
          null,      // id=5, arrival=6  ← -1 chunk
        ];
        const fragments: Uint8Array[] = [];
        for (let i = 0; i < tfdtSequence.length; i++) {
          fragments.push(buildIdentifiedFragment(i, tfdtSequence[i], i + 1));
        }

        for (const frag of fragments) {
          await feedBridgeOneResponse(
            harness,
            padUmpBody(buildSingleChunkUmpBody(AAC_ITAG, frag)),
          );
        }

        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);
        const audioData = resp.audioData as ArrayBuffer | null;
        expect(audioData).not.toBeNull();
        const flat = new Uint8Array(audioData!);

        const order = walkFragmentOrder(flat, new Set([0, 1, 2, 3, 4, 5]));
        expect(order).toEqual([0, 1, 2, 3, 4, 5]);
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    20_000,
  );

  it(
    "empty input (no chunks for the video): returns empty/null without throwing",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        // Clear and DO NOT feed any responses. The bridge has no
        // chunks for PAGE_VIDEO_ID, so `flattenItagFromResponses`
        // returns null, and `handleGetMediaBuffer` posts an empty
        // sentinel with `audioData: null, videoData: null,
        // audioSize: 0, videoSize: 0`.
        clearBridgeBuffer(PAGE_VIDEO_ID);

        const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);

        expect(resp.audioData).toBeNull();
        expect(resp.videoData).toBeNull();
        expect(Number(resp.audioSize)).toBe(0);
        expect(Number(resp.videoSize)).toBe(0);
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    20_000,
  );
});
