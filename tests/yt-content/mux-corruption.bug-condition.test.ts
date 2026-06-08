/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}
 */

/**
 * Bug Condition Exploration Test — youtube-download-mux-corruption-fix
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4**
 *
 * Property 1 — Bug Condition (from `design.md` `isBugCondition`):
 *
 *   matchesYtWatchOrShortsPage(pageUrl) AND NOT isDrm AND NOT isLive AND
 *   (savedMp4Bytes is empty OR demux fails OR durationDelta > 1s OR
 *   segments not monotonic OR segmentCount < expected*0.99 OR
 *   avDrift > 100ms)
 *
 * On the unfixed build, every non-DRM, non-live click on a ≥30s video
 * lands in `runClickFlow()`'s inline 16x-play-loop (root cause #1) and
 * `flattenItagFromResponses()`'s minTime-keyed dedup (root cause #2),
 * `-1`-chunk tail-append (root cause #3), audio/video coverage-blind
 * picker (root cause #4), `bufferedEnd`-only tail check (root cause #5),
 * and `stripIsobmffHeaderToMoofs()`'s brute-force `"moof"` scan (root
 * cause #6).
 *
 * **THIS TEST IS EXPECTED TO FAIL ON THE UNFIXED CODE.** The failure
 * surfaces concrete counterexamples that prove every root cause from
 * design.md "Hypothesized Root Cause" #1–#6 produces a
 * Bug-Condition-positive output.
 *
 * Five independent assertions, each scoped to `fast-check`-generated
 * `videoId ∈ [A-Za-z0-9_-]{11}` with a fixed page state
 * `{ isDrm: false, isLive: false, durationOriginal ∈ {35, 116, 240} }`
 * so every input satisfies `isBugCondition`:
 *
 *   1. **`flattenItagFromResponses` dedup loses unique segments with
 *       shared `minTime`** — root cause #2.  Two distinct moof+mdat
 *       fragments both carry `tfdt.baseMediaDecodeTime = 0`; bridge
 *       drops one because the post-sort `if (c.minTime === prevTime)`
 *       branch is byte-blind. Realistic SABR fragments always include
 *       an `mfhd` box with a unique `sequence_number`, so the FIXED
 *       byte-prefix dedup (32-byte hash) distinguishes them through
 *       the `mfhd.sequence_number` bytes inside the first 32 bytes of
 *       the moof. Our fixture mirrors this — `buildBareMoofMdatFragment`
 *       takes a `sequence_number` parameter and writes
 *       `[size][moof][mfhd: ver+flags+seq_num][traf: tfdt]` so two
 *       fragments with `tfdt = 0` but different `sequence_number`
 *       produce distinct first-32-byte prefixes.
 *
 *   2. **`-1`-chunks are appended to tail, not interleaved by
 *       `arrivalIdx`** — root cause #3.  A middle-arriving fragment
 *       with malformed `tfdt` (so `readMinTimestamp` returns -1) gets
 *       hoisted to the end of the byte stream, reordering ~5–10% of
 *       segments. The walker that recovers file-order from the
 *       flattened output uses a multi-byte sentinel
 *       `[0xDE, 0xAD, 0xBE, 0xEF, fragmentIdx]` at the start of each
 *       `mdat` payload — single-byte markers (0x10..0x19) collide
 *       with the deterministic `(seed*31 + i*17) & 0xff` distractor
 *       bytes that fill the rest of the payload, which made the
 *       walker pick up noise. The 4-byte signature is
 *       astronomically unlikely to occur inside `distinctMdat()`
 *       output, so the 5th byte after the sentinel reliably tells
 *       us which fragment we are looking at.
 *
 *   3. **`stripIsobmffHeaderToMoofs` is fooled by `"moof"` bytes
 *       inside `moov` payload** — root cause #6.  Brute-force scan
 *       returns the wrong offset when the four-byte sequence
 *       `0x6d 0x6f 0x6f 0x66` appears before the real moof box.
 *
 *   4. **`runClickFlow` inline 16x-loop fails to detect mid-buffer
 *       gaps** — root causes #1, #5.  Source-text assertion against
 *       `src/yt-content/yt-content.ts` confirms the buggy
 *       `playbackRate = 16` block + `bufferedEnd >= duration - 0.5`
 *       check are still present (they replace `forceFullBuffer()`).
 *
 *   5. **`handleGetMediaBuffer` does not detect audio/video coverage
 *       mismatch** — root cause #4.  Audio chunks reach
 *       `tfdt = 116000` while video chunks only reach `tfdt = 110000`;
 *       bridge ships both verbatim and ffmpeg `-shortest` later
 *       truncates to the shorter track.
 *
 * Per the bugfix workflow we do NOT attempt to fix the failures
 * surfaced here — failure IS the success criterion at this stage.
 * Counterexamples are documented inline as JSDoc comments below
 * each assertion.
 */

import * as fs from "fs";
import * as path from "path";
import fc from "fast-check";

import {
  stripIsobmffHeaderToMoofs,
} from "../../src/yt-content/yt-ump-parser";

// ─── shared scoped arbitrary (every input ∈ isBugCondition) ─────────────────

/**
 * The videoId the bridge keys chunks under is read from
 * `location.search`. Our jsdom URL is fixed at the top of this file, so
 * every fixture must look up chunks under THIS id (not the random
 * fc-generated videoId, which the bridge has never seen). The
 * fc-generated videoId is still useful for surfacing distinct
 * counterexamples in error messages.
 */
const PAGE_VIDEO_ID = "dQw4w9WgXcQ";

/**
 * Scoped fc.record so each generated input falls inside isBugCondition:
 *  - matchesYtWatchOrShortsPage: implied by the jsdom URL above.
 *  - !isDrm, !isLive: held constant.
 *  - durationOriginal: 35s (Shorts), 116s (1080p baseline ролик),
 *    240s (long ролик). All ≥ 30s so the inline 16x-loop has a chance
 *    to skip mid-buffer segments.
 */
const bugConditionInput = fc.record({
  videoId: fc.stringMatching(/^[A-Za-z0-9_-]{11}$/),
  isDrm: fc.constant(false),
  isLive: fc.constant(false),
  durationOriginal: fc.constantFrom(116, 35, 240),
});

// ─── ISOBMFF byte-level fixture builders ────────────────────────────────────

/**
 * Concatenate Uint8Arrays into one buffer.
 */
function concat(...parts: ArrayLike<number>[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p as Uint8Array, offset);
    offset += p.length;
  }
  return out;
}

/** Encode a 32-bit big-endian unsigned int. */
function u32be(value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value >>> 0, false);
  return b;
}

/** Encode a 64-bit big-endian unsigned int (split into hi/lo 32). */
function u64be(value: number): Uint8Array {
  const b = new Uint8Array(8);
  const big = BigInt(value);
  const view = new DataView(b.buffer);
  view.setUint32(0, Number((big >> 32n) & 0xffffffffn), false);
  view.setUint32(4, Number(big & 0xffffffffn), false);
  return b;
}

/** ASCII 4cc → 4-byte sequence. */
function fourcc(s: string): Uint8Array {
  if (s.length !== 4) throw new Error(`fourcc must be length 4, got "${s}"`);
  return new Uint8Array([
    s.charCodeAt(0),
    s.charCodeAt(1),
    s.charCodeAt(2),
    s.charCodeAt(3),
  ]);
}

/**
 * Build a generic ISOBMFF box `[size:4 BE][type:4cc][payload]`. `size`
 * is the total box size (header + payload). 0-payload boxes have size 8.
 */
function buildBox(type: string, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const totalSize = 8 + payload.byteLength;
  return concat(u32be(totalSize), fourcc(type), payload);
}

/**
 * Build a `tfdt` box (FullBox version=0) with `baseMediaDecodeTime`.
 * Layout: [size:4][type:'tfdt'][version:1][flags:3][baseMediaDecodeTime:4 (v0)]
 */
function buildTfdtV0(baseMediaDecodeTime: number): Uint8Array {
  const payload = concat(
    new Uint8Array([0x00, 0x00, 0x00, 0x00]), // version=0, flags=0
    u32be(baseMediaDecodeTime),
  );
  return buildBox("tfdt", payload);
}

/**
 * Build an `mfhd` box (FullBox version=0) carrying a unique
 * `sequence_number`. Layout (16 bytes total):
 *   [size:4 BE = 0x10][type:'mfhd'][version:1 = 0x00][flags:3 = 0x000000][sequence_number:4 BE]
 *
 * Real YouTube SABR fragments always include `mfhd`, and its
 * `sequence_number` is per-fragment unique. The 32-byte prefix-hash
 * dedup in `flattenItagFromResponses` relies on this — two fragments
 * with the same `tfdt.baseMediaDecodeTime` but different
 * `mfhd.sequence_number` produce distinct prefix hashes because
 * `sequence_number` lies at fragment-bytes 20..23 (well within the
 * first 32). Our fixtures must mirror this shape; otherwise the
 * test exercises a counterfactual moof layout the production code
 * would never see.
 */
function buildMfhd(sequenceNumber: number): Uint8Array {
  const payload = concat(
    new Uint8Array([0x00, 0x00, 0x00, 0x00]), // version=0, flags=0
    u32be(sequenceNumber),
  );
  return buildBox("mfhd", payload);
}

/**
 * Build a `traf` box wrapping a single `tfdt`. `extraTrafBytes` lets us
 * inject malformed bytes after tfdt (e.g. truncate the tfdt so
 * `readMinTimestamp` returns -1).
 */
function buildTraf(tfdt: Uint8Array): Uint8Array {
  return buildBox("traf", tfdt);
}

/**
 * Build a `moof` box with `mfhd` followed by one `traf`. Real SABR
 * `moof` boxes always carry `mfhd` first, so we mirror that layout.
 * `readMinTimestamp` walks `moof > traf > tfdt` and skips past `mfhd`
 * via the box-walker, so `mfhd` does not interfere with timestamp
 * parsing.
 */
function buildMoof(mfhd: Uint8Array, traf: Uint8Array): Uint8Array {
  return buildBox("moof", concat(mfhd, traf));
}

/**
 * Build an `mdat` box with arbitrary payload bytes.
 */
function buildMdat(payload: Uint8Array): Uint8Array {
  return buildBox("mdat", payload);
}

/**
 * Build a fragmented-MP4 init prefix: `[ftyp][moov]`. Both are
 * minimally-shaped. `moovExtra` lets a caller inject bytes at the
 * tail of the `moov` payload (used by Assertion 3 to insert false
 * `"moof"` bytes inside `moov`).
 */
function buildFtypMoovInit(moovExtra: Uint8Array = new Uint8Array(0)): Uint8Array {
  // ftyp: major_brand='isom', minor_version=512, compat brand='isom'
  const ftypPayload = concat(
    fourcc("isom"),
    u32be(512),
    fourcc("isom"),
  );
  const ftyp = buildBox("ftyp", ftypPayload);
  // moov: empty payload + caller's optional extra (e.g. fake moof bytes).
  const moov = buildBox("moov", moovExtra);
  return concat(ftyp, moov);
}

/**
 * Build a complete bare moof+mdat fragment with the given
 * `sequenceNumber` (carried in `mfhd`), `baseMediaDecodeTime`
 * (carried in `tfdt`), and `mdat` payload. No ftyp/moov prefix —
 * these are the units that arrive as separate UMP type-21 chunks for
 * media iTags after the init segment has already been delivered.
 *
 * Layout (no payload):
 *   [moof: size 4 + type 4 + mfhd 16 + traf 24] = 48 bytes
 *   [mdat: size 4 + type 4 + payload] = 8 + payload bytes
 *
 * The first 32 bytes are
 *   `[moof.size][moof.type][mfhd.size][mfhd.type][mfhd.ver+flags]
 *    [mfhd.seq_num][traf.size][traf.type]`
 * — `sequence_number` lies at offset 20..23 inside the fragment and
 * is the byte that distinguishes fragments with the same
 * `tfdt.baseMediaDecodeTime` under the 32-byte prefix-hash dedup.
 */
function buildBareMoofMdatFragment(
  baseMediaDecodeTime: number,
  mdatPayload: Uint8Array,
  sequenceNumber: number = 1,
): Uint8Array {
  return concat(
    buildMoof(buildMfhd(sequenceNumber), buildTraf(buildTfdtV0(baseMediaDecodeTime))),
    buildMdat(mdatPayload),
  );
}

/**
 * Build a moof+mdat fragment whose `traf` does NOT contain a `tfdt`
 * box at all — `readMinTimestamp` walks `moof > traf` and finds no
 * `tfdt` child, so it falls out of the inner walk and returns -1. This
 * is the realistic shape that arrives when YouTube SABR ships a
 * fragment whose tfdt lies past the truncation point of our 1024-byte
 * parse window — design.md root cause #3.
 */
function buildBrokenTfdtFragment(
  mdatPayload: Uint8Array,
  sequenceNumber: number = 1,
): Uint8Array {
  // traf with a single non-tfdt child box (e.g. trun = "trun") so
  // `readMoofBaseDecodeTime` walks past it without ever finding tfdt.
  const dummyTrun = buildBox("trun", new Uint8Array(8));
  const traf = buildBox("traf", dummyTrun);
  const moof = buildBox("moof", concat(buildMfhd(sequenceNumber), traf));
  return concat(moof, buildMdat(mdatPayload));
}

// ─── UMP fixture builders (re-exported pattern from yt-page-bridge.parse) ────

/** Encode a UMP varint using the 1/2/5-byte forms only (sufficient for tests). */
function encodeUmpVarInt(value: number): Uint8Array {
  if (value < 0 || !Number.isInteger(value)) {
    throw new Error(`encodeUmpVarInt: invalid value ${value}`);
  }
  if (value < 0x80) return new Uint8Array([value & 0x7f]);
  if (value < 1 << 14) {
    return new Uint8Array([0x80 | (value & 0x3f), (value >>> 6) & 0xff]);
  }
  // 5-byte form: 11110xxx + 4 little-endian bytes of (value >> 3).
  const big = BigInt(value);
  const lowBits = Number(big & 0x07n);
  const high = big >> 3n;
  return new Uint8Array([
    0xf0 | lowBits,
    Number(high & 0xffn),
    Number((high >> 8n) & 0xffn),
    Number((high >> 16n) & 0xffn),
    Number((high >> 24n) & 0xffn),
  ]);
}

function encodeProtoVarInt(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push(0x80 | (v & 0x7f));
    v = v >>> 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

/** Build a UMP frame `[type-varint][size-varint][payload]`. */
function buildUmpFrame(type: number, payload: Uint8Array): Uint8Array {
  return concat(encodeUmpVarInt(type), encodeUmpVarInt(payload.length), payload);
}

/** Build a UMP type-20 (header) frame with field 3 (iTag) = `itag`. */
function buildPart20FrameWithItag(itag: number): Uint8Array {
  // proto tag for field=3, wireType=0 is (3 << 3) | 0 = 24.
  const body = concat(encodeProtoVarInt(24), encodeProtoVarInt(itag));
  return buildUmpFrame(20, body);
}

/**
 * Build a UMP type-21 (media) frame whose payload is `[headerByte=0x00,
 * ...mediaBytes]`. The bridge skips the header byte.
 */
function buildPart21Frame(mediaBytes: Uint8Array): Uint8Array {
  return buildUmpFrame(21, concat(new Uint8Array([0x00]), mediaBytes));
}

/**
 * Build one UMP "response" body containing a single (itag, mediaBytes)
 * media-only chunk. The bridge's fetch hook treats every URL containing
 * both `googlevideo.com` AND `videoplayback` as a UMP body — so we
 * craft these and hand them to the patched `window.fetch` via a stub
 * that returns a Response wrapping the buffer.
 */
function buildSingleChunkUmpBody(itag: number, mediaBytes: Uint8Array): Uint8Array {
  return concat(buildPart20FrameWithItag(itag), buildPart21Frame(mediaBytes));
}

// ─── jsdom bridge harness ────────────────────────────────────────────────────

/**
 * Install a mock `window.fetch` that, for every URL containing
 * `googlevideo.com` and `videoplayback`, returns a Response whose body
 * is `bytesByUrl[url]` (mapped per call) — falling back to the bytes
 * passed at construction when the URL is not pre-registered.
 *
 * Records every URL the bridge issued so callers can assert flow.
 */
interface BridgeFetchHarness {
  fetched: string[];
  setNextResponse: (bytes: Uint8Array) => void;
  restore: () => void;
}

/**
 * Minimal fake response object that satisfies the bridge's fetch hook
 * contract: `.clone()` returns an object with `.arrayBuffer()`. jsdom
 * 20 (our test env) does not ship a global `Response` constructor, so
 * we hand-roll a structurally-typed fake that the bridge accepts.
 */
function makeFakeResponse(bytes: Uint8Array): unknown {
  const arrayBuffer = (): Promise<ArrayBuffer> => {
    const out = new Uint8Array(bytes.byteLength);
    out.set(bytes);
    return Promise.resolve(out.buffer);
  };
  const fake = {
    status: 200,
    ok: true,
    headers: new Map(),
    clone: () => makeFakeResponse(bytes),
    arrayBuffer,
    text: () => Promise.resolve(""),
    json: () => Promise.resolve({}),
  };
  return fake;
}

function installBridgeFetch(): BridgeFetchHarness {
  const original = window.fetch;
  const fetched: string[] = [];
  let nextBytes: Uint8Array = new Uint8Array(0);
  const fakeFetch = jest.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url?: string }).url ?? "";
    fetched.push(url);
    return makeFakeResponse(nextBytes) as unknown as Response;
  });
  (window as unknown as { fetch: typeof fetch }).fetch =
    fakeFetch as unknown as typeof fetch;
  return {
    fetched,
    setNextResponse: (b) => {
      nextBytes = b;
    },
    restore: () => {
      (window as unknown as { fetch: typeof fetch }).fetch = original;
    },
  };
}

/**
 * Load the bridge IIFE into the current jsdom realm. We require the
 * compiled module after installing our fetch stub so the bridge
 * captures `origFetch = window.fetch.bind(window)` BEFORE we restore
 * it. Subsequent fetches go through the bridge → our stub.
 *
 * The bridge IIFE also registers a `window.addEventListener("message",
 * ...)` handler — to keep iterations isolated we send `CLEAR_BUFFER`
 * between scenarios instead of reloading the IIFE (reloading leaves
 * stale listeners attached because `removeEventListener` requires the
 * exact original handler reference, which the IIFE does not export).
 *
 * Returns a cleanup that resets `jest.resetModules()` so the next test
 * (different `it` block) boots a fresh IIFE.
 */
function loadBridgeIIFE(): { cleanup: () => void } {
  jest.isolateModules(() => {
    require("../../src/yt-content/yt-page-bridge");
  });
  return {
    cleanup: () => {
      jest.resetModules();
    },
  };
}

/**
 * Send `CLEAR_BUFFER` to the bridge so its per-videoId chunk store
 * starts empty for the next scenario. Synchronous (the handler does
 * `audioBuffers.delete(vid); responseChunks.delete(vid)`).
 */
function clearBridgeBuffer(videoId: string): void {
  const evt = new MessageEvent("message", {
    data: {
      source: "ymus-yt-content",
      action: "CLEAR_BUFFER",
      videoId,
    },
    source: window as unknown as MessageEventSource,
    origin: window.location.origin,
  });
  window.dispatchEvent(evt);
}

/**
 * Send a UMP body through the bridge's patched fetch and wait for its
 * async `arrayBuffer().then(...)` to flush. Resolves once the bridge
 * has seen the response and updated its internal `responseChunks`.
 */
async function feedBridgeOneResponse(
  fetchStub: BridgeFetchHarness,
  umpBytes: Uint8Array,
): Promise<void> {
  fetchStub.setNextResponse(umpBytes);
  // Anonymous `googlevideo.com/videoplayback?...` URL — bridge keys off
  // these substrings.
  await window.fetch(
    "https://rr1---sn-test.googlevideo.com/videoplayback?fakefixture=1",
  );
  // The bridge processes the response asynchronously inside
  // `clone.arrayBuffer().then(...)`. Yield the event loop a few times
  // to let that microtask chain resolve.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Send a `GET_MEDIA_BUFFER` request to the bridge and wait for its
 * `MEDIA_BUFFER_RESPONSE` postMessage. Returns the latest response
 * data observed within `WAIT_MS`.
 *
 * jsdom 20 ships a `window.postMessage` whose dispatched event has
 * `event.source = null` (not `window`), which the bridge ignores via
 * `if (event.source !== window) return;`. We dispatch a `MessageEvent`
 * directly so `event.source = window` reaches the listener.
 *
 * Multiple bridge IIFEs may be attached to `window` simultaneously
 * across iterations (the first IIFE's listener cannot be removed
 * because the IIFE never exposed it). All attached IIFEs respond to
 * GET_MEDIA_BUFFER. Older IIFEs hold stale (now-empty) chunk stores
 * and respond with `audioSize: 0, videoSize: 0`. To get the CURRENT
 * IIFE's view we collect EVERY response within a 100ms window and
 * pick the largest (`audioSize + videoSize` max) — that is by
 * construction the IIFE that just received our `feedBridgeOneResponse`
 * fetches.
 */
async function getMediaBufferFromBridge(
  videoId: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const responses: Record<string, unknown>[] = [];
    const WAIT_MS = 100;
    const MAX_WAIT_MS = 2_000;
    let lastSeenAt = 0;
    const listener = (ev: MessageEvent) => {
      const d = ev.data as Record<string, unknown> | null;
      if (
        d &&
        d.source === "ymus-yt-bridge" &&
        d.action === "MEDIA_BUFFER_RESPONSE"
      ) {
        responses.push(d);
        lastSeenAt = Date.now();
      }
    };
    window.addEventListener("message", listener);
    const requestEvent = new MessageEvent("message", {
      data: {
        source: "ymus-yt-content",
        action: "GET_MEDIA_BUFFER",
        videoId,
      },
      source: window as unknown as MessageEventSource,
      origin: window.location.origin,
    });
    window.dispatchEvent(requestEvent);

    const startedAt = Date.now();
    const settle = setInterval(() => {
      const now = Date.now();
      const sinceLast = lastSeenAt > 0 ? now - lastSeenAt : Infinity;
      const elapsed = now - startedAt;
      // Settle once 100ms have passed since the LAST response seen,
      // OR we've waited the maximum 2s.
      if ((responses.length > 0 && sinceLast >= WAIT_MS) || elapsed >= MAX_WAIT_MS) {
        clearInterval(settle);
        window.removeEventListener("message", listener);
        if (responses.length === 0) {
          reject(new Error("MEDIA_BUFFER_RESPONSE timeout"));
          return;
        }
        // Pick the response with the largest (audioSize + videoSize)
        // — that is the IIFE whose chunk store this iteration just
        // populated. Older stale-IIFE responses contribute 0+0.
        let best = responses[0];
        let bestTotal =
          Number(best.audioSize ?? 0) + Number(best.videoSize ?? 0);
        for (let i = 1; i < responses.length; i++) {
          const t =
            Number(responses[i].audioSize ?? 0) +
            Number(responses[i].videoSize ?? 0);
          if (t > bestTotal) {
            best = responses[i];
            bestTotal = t;
          }
        }
        resolve(best);
      }
    }, 20);
  });
}

// ─── helpers used across multiple assertions ────────────────────────────────

/** Make `length` distinct mdat payloads so byte-prefix dedup keeps them apart. */
function distinctMdat(seed: number, length = 64): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (seed * 31 + i * 17) & 0xff;
  }
  return out;
}

/**
 * Pad a UMP body with an extra type-21 frame of innocuous bytes so the
 * total response size exceeds the bridge's 100-byte filter
 * (`if (ab.byteLength < 100) return`). The extra payload is appended
 * AFTER the real (itag, mediaBytes) frame so its iTag is overwritten
 * by a final type-20 frame for an UNCAPTURED iTag — the bridge ignores
 * those bytes for capture purposes.
 */
function padUmpBody(body: Uint8Array, minBytes = 200): Uint8Array {
  if (body.byteLength >= minBytes) return body;
  const padLen = minBytes - body.byteLength;
  // Append a trailing type-20 (header) frame switching to iTag 999
  // (not in AUDIO_ITAGS or VIDEO_ITAGS) followed by a type-21 frame
  // of `padLen` filler bytes — the bridge sees `currentItag = 999`
  // (uncaptured) for the next type-21, so the bytes are dropped.
  const partUncaptured = buildPart20FrameWithItag(999);
  const partFiller = buildPart21Frame(new Uint8Array(padLen));
  return concat(body, partUncaptured, partFiller);
}

// ─── Assertion 1 ────────────────────────────────────────────────────────────
//
// Counterexample 1 (UNFIXED — minTime-keyed dedup):
//   fragA = bareMoofMdat(seq=1, tfdt=0, mdat=distinctMdat(1)), length ≈ 120B
//   fragB = bareMoofMdat(seq=2, tfdt=0, mdat=distinctMdat(2)), length ≈ 120B
//   audioFlat = handleGetMediaBuffer(videoId).audioSize
//   Expected: audioFlat ≈ stripped(fragA) + stripped(fragB) ≈ 240B
//   Actual on UNFIXED: audioFlat ≈ stripped(fragA only) ≈ 120B
//                       (the "if (c.minTime === prevTime) drop" branch
//                       byte-blindly drops fragB because both share
//                       tfdt.baseMediaDecodeTime = 0)
//
// On the FIXED build the 32-byte prefix-hash dedup picks up the
// distinct `mfhd.sequence_number` bytes at fragment offsets 20..23,
// so both fragments are kept and `audioSize` reaches the sum.

describe("Property 1 — Bug Condition: saved MP4 corruption (mux-corruption-fix)", () => {
  // Console noise from the bridge IIFE is not relevant to assertion
  // outcomes — we silence it for clarity in test reports.
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    // Toggle to true when debugging this suite — keep noise off in CI.
    const SILENCE_BRIDGE_LOGS = true;
    if (SILENCE_BRIDGE_LOGS) {
      logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
      warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    } else {
      logSpy = jest.spyOn(console, "log");
      warnSpy = jest.spyOn(console, "warn");
    }
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    jest.resetModules();
  });

  it(
    "1. flattenItagFromResponses preserves both unique fragments " +
      "with shared minTime (FAILS on UNFIXED — one is dropped)",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        await fc.assert(
          fc.asyncProperty(bugConditionInput, async (input) => {
            // Reset bridge state for this iteration so the prior
            // iteration's chunks do not leak in.
            clearBridgeBuffer(PAGE_VIDEO_ID);

            const fragA = buildBareMoofMdatFragment(0, distinctMdat(1), /* seq */ 1);
            const fragB = buildBareMoofMdatFragment(0, distinctMdat(2), /* seq */ 2);
            // The two fragments share `tfdt.baseMediaDecodeTime = 0`
            // and have IDENTICAL mdat header bytes, but DIFFERENT
            // `mfhd.sequence_number` values (1 vs 2) and DIFFERENT
            // mdat payloads. Real YouTube SABR fragments always carry
            // `mfhd` with a unique `sequence_number`, so the FIXED
            // 32-byte prefix-hash dedup distinguishes them through
            // those bytes (offset 20..23 of the fragment). The
            // unfixed `minTime === prevTime` branch was byte-blind
            // and dropped one regardless.
            expect(fragA).not.toEqual(fragB);

            // AAC iTag 140. Send each as its own UMP response so the
            // bridge's per-response chunk store records them with
            // separate `arrivalIdx` values. Pad each body to >100B
            // so the bridge's fetch-hook filter
            // `if (ab.byteLength < 100) return` does not skip them.
            await feedBridgeOneResponse(
              harness,
              padUmpBody(buildSingleChunkUmpBody(140, fragA)),
            );
            await feedBridgeOneResponse(
              harness,
              padUmpBody(buildSingleChunkUmpBody(140, fragB)),
            );

            const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);
            const audioSize = Number(resp.audioSize ?? 0);

            // After `stripIsobmffHeaderToMoofs`, each bare moof+mdat
            // is unchanged (no ftyp prefix to strip). Total bytes
            // ≥ fragA.byteLength + fragB.byteLength would mean BOTH
            // fragments survived.  Allow some room for init bytes.
            const expectedMinBothSurvive = fragA.byteLength + fragB.byteLength - 1;
            const expectedMaxOneDropped = Math.max(fragA.byteLength, fragB.byteLength) + 100;

            if (audioSize < expectedMinBothSurvive) {
              throw new Error(
                `Bug Condition counterexample for videoId="${input.videoId}" ` +
                  `(durationOriginal=${input.durationOriginal}s): ` +
                  `flattenItagFromResponses dropped a unique segment that ` +
                  `shared minTime=0 with another. ` +
                  `fragA.byteLength=${fragA.byteLength}, ` +
                  `fragB.byteLength=${fragB.byteLength}, ` +
                  `expected audioSize ≥ ${expectedMinBothSurvive}, ` +
                  `got ${audioSize} ` +
                  `(≈ stripped(one fragment only): max ${expectedMaxOneDropped})`,
              );
            }
          }),
          { numRuns: 3 },
        );
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    20_000,
  );

  // ─── Assertion 2 ──────────────────────────────────────────────────────────
  //
  // Counterexample 2 (UNFIXED — `-1`-chunks dumped to tail):
  //   10 fragments arrive in order, each with tfdt = i * 1024 except
  //   fragment[5] which has a truncated tfdt → readMinTimestamp = -1.
  //   Expected file-position of fragment[5]: between fragment[4] and
  //   fragment[6] (i.e. 5th in file order, position index 4).
  //   Actual on UNFIXED: fragment[5] is appended to the tail (10th in
  //   file order) — the "untimestamped at the end" branch reorders
  //   ~10% of segments.
  //
  // Marker design: each `mdat` payload starts with a 5-byte sentinel
  // `[0xDE, 0xAD, 0xBE, 0xEF, fragmentIdx]`. The 4-byte signature is
  // outside the value distribution of `distinctMdat()` distractor
  // bytes (which spread across 0..255 individually but produce the
  // exact 4-byte sequence with negligible probability). The walker
  // scans the flattened output for the signature and reads the 5th
  // byte as the fragment index — robust against the deterministic
  // shuffle bytes that fill the rest of the payload.

  it(
    "2. -1-chunks interleave by arrivalIdx, not appended to tail " +
      "(FAILS on UNFIXED — broken-tfdt fragment lands at the end)",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        await fc.assert(
          fc.asyncProperty(bugConditionInput, async (input) => {
            clearBridgeBuffer(PAGE_VIDEO_ID);

            // Build 10 fragments. Each `mdat` payload starts with a
            // 5-byte sentinel `[0xDE, 0xAD, 0xBE, 0xEF, fragmentIdx]`
            // followed by distractor bytes. The walker scans the
            // flattened output for the signature and reads the 5th
            // byte as the fragment index — `distinctMdat` cannot
            // produce the exact 4-byte signature with non-negligible
            // probability, so the walker is immune to its shuffle
            // noise. The 5th fragment (idx=4) gets a broken tfdt —
            // `readMinTimestamp` returns -1.
            const SENTINEL = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
            const fragments: Uint8Array[] = [];
            const fragmentIds: number[] = [];
            for (let i = 0; i < 10; i++) {
              fragmentIds.push(i);
              const mdatPayload = concat(
                SENTINEL,
                new Uint8Array([i & 0xff]),
                distinctMdat(100 + i, 32),
              );
              if (i === 4) {
                fragments.push(
                  buildBrokenTfdtFragment(mdatPayload, /* seq */ i + 1),
                );
              } else {
                fragments.push(
                  buildBareMoofMdatFragment(
                    i * 1024,
                    mdatPayload,
                    /* seq */ i + 1,
                  ),
                );
              }
            }

            for (const frag of fragments) {
              await feedBridgeOneResponse(
                harness,
                padUmpBody(buildSingleChunkUmpBody(140, frag)),
              );
            }

            const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);
            const audioData = resp.audioData as ArrayBuffer | null;
            if (audioData === null) {
              throw new Error(
                `Bug Condition counterexample for videoId="${input.videoId}": ` +
                  `audioData is null — bridge returned empty buffer for ` +
                  `10 valid fragments (one with broken tfdt).`,
              );
            }
            const out = new Uint8Array(audioData);

            // Walk `out` for the 5-byte sentinel
            // `[0xDE, 0xAD, 0xBE, 0xEF, fragmentIdx]` and record the
            // file-order in which each fragmentIdx first appears. The
            // broken-tfdt fragment (fragmentIdx=4) MUST appear at file
            // index 4 (between markers 3 and 5) — not at the very end
            // (file index 9).
            const orderById: number[] = [];
            for (let pos = 0; pos + 4 < out.byteLength; pos++) {
              if (
                out[pos] === 0xde &&
                out[pos + 1] === 0xad &&
                out[pos + 2] === 0xbe &&
                out[pos + 3] === 0xef
              ) {
                const id = out[pos + 4];
                if (
                  fragmentIds.includes(id) &&
                  !orderById.includes(id)
                ) {
                  orderById.push(id);
                  if (orderById.length === fragmentIds.length) break;
                }
                // Skip past the sentinel + id byte to avoid
                // re-matching the same occurrence.
                pos += 4;
              }
            }

            const positionOfBroken = orderById.indexOf(4);
            if (positionOfBroken === -1) {
              throw new Error(
                `Bug Condition counterexample for videoId="${input.videoId}": ` +
                  `broken-tfdt fragment (id=4) lost from output. ` +
                  `orderById=[${orderById.join(",")}]`,
              );
            }
            if (positionOfBroken !== 4) {
              throw new Error(
                `Bug Condition counterexample for videoId="${input.videoId}" ` +
                  `(durationOriginal=${input.durationOriginal}s): ` +
                  `broken-tfdt fragment landed at file-position ` +
                  `${positionOfBroken} (expected 4 — interleaved by arrivalIdx). ` +
                  `Order seen: [${orderById.join(",")}]. ` +
                  `Tail-append reorders ~10% of segments and produces ` +
                  `audio/video from non-adjacent timeline positions.`,
              );
            }
          }),
          { numRuns: 3 },
        );
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    30_000,
  );

  // ─── Assertion 3 ──────────────────────────────────────────────────────────
  //
  // Counterexample 3 (UNFIXED):
  //   Layout: [ftyp][moov: payload contains 0x6d 0x6f 0x6f 0x66 at
  //   inner offset M][moof_real][mdat]
  //   Expected: stripIsobmffHeaderToMoofs returns slice starting at
  //   the byte position of the real moof box header (4 bytes before
  //   `bytes[realOffset+4..realOffset+7] === "moof"`).
  //   Actual on UNFIXED: the brute-force `for i { bytes[i..i+4] ===
  //   "moof" }` returns the FAKE offset inside the moov payload first
  //   (because it appears earlier in the byte stream) — strip returns
  //   `bytes.subarray(fakeOffset - 4)` which is mid-moov garbage.

  it(
    "3. stripIsobmffHeaderToMoofs returns the real moof, not the " +
      'fake "moof" bytes inside moov payload ' +
      "(FAILS on UNFIXED — brute-force scan picks the fake first)",
    () => {
      fc.assert(
        fc.property(bugConditionInput, (input) => {
          // Inject `0x6d 0x6f 0x6f 0x66` ("moof" ASCII) inside the moov
          // payload — for example, as part of a synthetic udta tag's
          // payload bytes. The walker via readBoxHeader will skip past
          // moov as a single 8+payload box; the linear brute-force
          // scan will find the fake bytes first.
          const fakeMoofBytes = fourcc("moof");
          // Pad the fake bytes with some context so they are clearly
          // "inside moov payload" not at moov's box-type offset.
          const moovExtraPayload = concat(
            new Uint8Array([0x00, 0x00, 0x00, 0x10]), // looks like a size:4
            fakeMoofBytes, // ← "moof" bytes here, at moov-payload offset 4
            new Uint8Array(8), // tail padding
          );
          const init = buildFtypMoovInit(moovExtraPayload);
          // Real moof+mdat appended after the moov box.
          const realMoof = buildMoof(buildMfhd(1), buildTraf(buildTfdtV0(0)));
          const realMdat = buildMdat(distinctMdat(7, 16));
          const realMoofOffset = init.byteLength;
          const fixture = concat(init, realMoof, realMdat);

          // Sanity: the fake bytes are at a strictly earlier offset
          // than the real moof box header — otherwise the test does
          // not exercise the bug.
          const fakeOffset = (() => {
            for (let i = 4; i < realMoofOffset; i++) {
              if (
                fixture[i] === 0x6d &&
                fixture[i + 1] === 0x6f &&
                fixture[i + 2] === 0x6f &&
                fixture[i + 3] === 0x66
              ) {
                return i;
              }
            }
            return -1;
          })();
          expect(fakeOffset).toBeGreaterThan(0);
          expect(fakeOffset).toBeLessThan(realMoofOffset);

          const stripped = stripIsobmffHeaderToMoofs(fixture);

          // After a correct strip, `stripped` MUST start with the real
          // moof box header — its first 4 bytes are the box size, then
          // bytes 4..7 spell "moof".
          const startsWithRealMoof =
            stripped[4] === 0x6d &&
            stripped[5] === 0x6f &&
            stripped[6] === 0x6f &&
            stripped[7] === 0x66 &&
            stripped.byteLength === fixture.byteLength - realMoofOffset;

          if (!startsWithRealMoof) {
            // Distinguish the diagnosis: fake-offset hit vs. some
            // other failure.
            const sliceStart = fixture.byteLength - stripped.byteLength;
            throw new Error(
              `Bug Condition counterexample for videoId="${input.videoId}": ` +
                `stripIsobmffHeaderToMoofs returned slice at offset ${sliceStart} ` +
                `(expected ${realMoofOffset} — real moof box header). ` +
                `Fake "moof" bytes lie at offset ${fakeOffset} inside moov ` +
                `payload; brute-force scan returned ${sliceStart} = ` +
                `fakeOffset(${fakeOffset}) - 4. ` +
                `Walking via readBoxHeader would have skipped past ftyp+moov ` +
                `as whole boxes and found the real moof box header first.`,
            );
          }
        }),
        { numRuns: 3 },
      );
    },
  );

  // ─── Assertion 4 ──────────────────────────────────────────────────────────
  //
  // Counterexample 4 (UNFIXED):
  //   `runClickFlow()` body in src/yt-content/yt-content.ts contains
  //   a literal `playbackRate = 16` (line ~620) followed by a
  //   `bufferedEnd = v.buffered.end(v.buffered.length - 1)` check
  //   against `bufferTarget = duration - 0.5` (line ~656). When the
  //   player has buffered ranges [[0,30],[110,116]], `bufferedEnd =
  //   116` satisfies the gate and the click flow proceeds to
  //   chrome.runtime.sendMessage({ type: "YT_DOWNLOAD_VIDEO", ... })
  //   despite the [30,110] hole. Source-text assertion: the buggy
  //   block is still present.

  it(
    "4. runClickFlow does not delegate to forceFullBuffer; uses a " +
      "buggy inline 16x-loop that ignores mid-buffer gaps " +
      "(FAILS on UNFIXED — source still contains playbackRate=16 + " +
      "bufferedEnd-only check)",
    () => {
      fc.assert(
        fc.property(bugConditionInput, (input) => {
          const ytContentSrc = fs.readFileSync(
            path.resolve(__dirname, "../../src/yt-content/yt-content.ts"),
            "utf-8",
          );

          // Locate runClickFlow body. It begins with `async function
          // runClickFlow(videoId: string)` and ends at the next
          // `\n}\n` at the matching outer brace. We walk the brace
          // depth to be robust against nested closures.
          const startMarker = "async function runClickFlow(";
          const startIdx = ytContentSrc.indexOf(startMarker);
          expect(startIdx).toBeGreaterThan(-1);
          const bodyStart = ytContentSrc.indexOf("{", startIdx);
          let depth = 0;
          let bodyEnd = -1;
          for (let i = bodyStart; i < ytContentSrc.length; i++) {
            const c = ytContentSrc[i];
            if (c === "{") depth++;
            else if (c === "}") {
              depth--;
              if (depth === 0) {
                bodyEnd = i;
                break;
              }
            }
          }
          expect(bodyEnd).toBeGreaterThan(bodyStart);
          const runClickFlowBody = ytContentSrc.slice(bodyStart, bodyEnd + 1);

          // Two textual smells of root causes #1 and #5 — both must
          // be ABSENT for the fix to be in place.
          const hasInline16xLoop = /playbackRate\s*=\s*16/.test(runClickFlowBody);
          // The unfixed inline loop ends its `while` on `bufferedEnd
          // >= bufferTarget` where `bufferTarget = duration - 0.5`.
          const hasBufferTargetMinusHalfSecond =
            /bufferTarget\s*=\s*duration\s*-\s*0\.5/.test(runClickFlowBody) ||
            /buffered\.end\s*\(\s*v?\.?buffered\.length\s*-\s*1\s*\)/.test(
              runClickFlowBody,
            );

          // Root cause #1 sentinel: forceFullBuffer is imported but
          // NOT called inside runClickFlow. Find the function call.
          const callsForceFullBuffer = /forceFullBuffer\s*\(/.test(
            runClickFlowBody,
          );

          if (hasInline16xLoop || hasBufferTargetMinusHalfSecond || !callsForceFullBuffer) {
            throw new Error(
              `Bug Condition counterexample for videoId="${input.videoId}" ` +
                `(durationOriginal=${input.durationOriginal}s): ` +
                `runClickFlow uses inline 16x-loop instead of forceFullBuffer(). ` +
                `playbackRate=16 inline loop present: ${hasInline16xLoop}. ` +
                `bufferTarget=duration-0.5 / buffered.end(last) check present: ${hasBufferTargetMinusHalfSecond}. ` +
                `forceFullBuffer call present: ${callsForceFullBuffer}. ` +
                `On a synthetic <video> with buffered ranges [[0,30],[110,${input.durationOriginal}]], ` +
                `the unfixed click flow sees buffered.end(last)=${input.durationOriginal} ` +
                `and proceeds to send YT_DOWNLOAD_VIDEO with a buffer that has ` +
                `an 80-second mid-timeline hole.`,
            );
          }
        }),
        { numRuns: 3 },
      );
    },
  );

  // ─── Assertion 5 ──────────────────────────────────────────────────────────
  //
  // Counterexample 5 (UNFIXED):
  //   Audio iTag 140 chunks reach tfdt = 116000 (≈116s @ timescale=1000).
  //   Video iTag 137 chunks reach tfdt = 110000 (≈110s) — 6s short.
  //   Expected: handleGetMediaBuffer detects the coverage diff > 1.0s
  //   and posts MEDIA_BUFFER_RESPONSE with audioSize:0, videoSize:0.
  //   Actual on UNFIXED: bridge ships both buffers verbatim (audioSize
  //   and videoSize > 0), and ffmpeg's -shortest later truncates the
  //   muxed MP4 to ~110s — content shows the "1:50 instead of 1:56"
  //   symptom from bugfix.md §1.1.

  it(
    "5. handleGetMediaBuffer detects audio/video coverage mismatch " +
      "and rejects the pair " +
      "(FAILS on UNFIXED — both buffers are shipped, ffmpeg -shortest " +
      "truncates the saved MP4)",
    async () => {
      const harness = installBridgeFetch();
      const bridge = loadBridgeIIFE();
      try {
        await fc.assert(
          fc.asyncProperty(bugConditionInput, async (input) => {
            clearBridgeBuffer(PAGE_VIDEO_ID);

            // Audio iTag 140: chunks at tfdt = 0, 1024, …, 116*1024.
            // Use a dense set so coverage looks "complete" up to 116s.
            // Distinct `mfhd.sequence_number` per fragment keeps the
            // 32-byte prefix-hash dedup from collapsing them — real
            // SABR carries unique sequence numbers, and the 32-byte
            // prefix lies before the `tfdt.baseMediaDecodeTime` byte
            // range so without unique seq_num the prefix would be
            // identical across fragments.
            const audioFragments: Uint8Array[] = [];
            let seqA = 1;
            for (let t = 0; t <= 116 * 1024; t += 1024) {
              audioFragments.push(
                buildBareMoofMdatFragment(t, distinctMdat(t, 16), seqA++),
              );
            }
            // Video iTag 137: chunks at tfdt = 0, 1024, …, 110*1024
            // — 6 seconds short.
            const videoFragments: Uint8Array[] = [];
            let seqV = 1;
            for (let t = 0; t <= 110 * 1024; t += 1024) {
              videoFragments.push(
                buildBareMoofMdatFragment(t, distinctMdat(t + 1, 16), seqV++),
              );
            }

            for (const f of audioFragments) {
              await feedBridgeOneResponse(
                harness,
                padUmpBody(buildSingleChunkUmpBody(140, f)),
              );
            }
            for (const f of videoFragments) {
              await feedBridgeOneResponse(
                harness,
                padUmpBody(buildSingleChunkUmpBody(137, f)),
              );
            }

            const resp = await getMediaBufferFromBridge(PAGE_VIDEO_ID);
            const audioSize = Number(resp.audioSize ?? 0);
            const videoSize = Number(resp.videoSize ?? 0);

            // Coverage diff: 116*1024 - 110*1024 = 6144 timescale
            // ticks. At ISOBMFF timescale=1000 fallback, that is 6.144s
            // — well above the 1.0s threshold.
            //
            // Fixed code: audioSize === 0 AND videoSize === 0 (the
            // existing empty-track sentinel from
            // youtube-buffer-capture-revert).
            // Unfixed code: audioSize > 0 AND videoSize > 0 (both
            // buffers shipped verbatim — root cause #4).
            if (audioSize > 0 && videoSize > 0) {
              throw new Error(
                `Bug Condition counterexample for videoId="${input.videoId}" ` +
                  `(durationOriginal=${input.durationOriginal}s): ` +
                  `handleGetMediaBuffer shipped audio=${audioSize}B, video=${videoSize}B ` +
                  `even though video coverage stops at tfdt=${110 * 1024} ` +
                  `while audio reaches tfdt=${116 * 1024} (≈6s short). ` +
                  `ffmpeg -shortest would truncate the muxed MP4 to ~110s — ` +
                  `the user-visible "1:50 instead of 1:56" symptom from ` +
                  `bugfix.md §1.1. Expected sentinel: audioSize=0, videoSize=0.`,
              );
            }
          }),
          { numRuns: 3 },
        );
      } finally {
        bridge.cleanup();
        harness.restore();
      }
    },
    30_000,
  );
});
