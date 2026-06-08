/**
 * Shared test helpers for YouTube page-bridge tests.
 *
 * These helpers were extracted from
 * `tests/yt-content/mux-corruption.bug-condition.test.ts` so multiple
 * unit-test files can drive the bridge IIFE under jsdom without
 * duplicating the byte-level fixture builders, the patched-fetch
 * harness, and the MEDIA_BUFFER_RESPONSE collector.
 *
 * NOT a test file — has no `describe`/`it`. Importable from any
 * `*.test.ts` file under `tests/yt-content/`.
 *
 * The helpers are split into three groups:
 *
 *   1. ISOBMFF byte-level fixture builders (`buildBox`, `buildTfdtV0`,
 *      `buildMfhd`, `buildMoof`, `buildMdat`, `buildFtypMoovInit`,
 *      `buildBareMoofMdatFragment`, `buildBrokenTfdtFragment`).
 *      Pure, dependency-free.
 *
 *   2. UMP wire-frame builders (`buildPart20FrameWithItag`,
 *      `buildPart21Frame`, `buildSingleChunkUmpBody`, `padUmpBody`).
 *      Pure, dependency-free.
 *
 *   3. jsdom bridge harness (`installBridgeFetch`, `loadBridgeIIFE`,
 *      `clearBridgeBuffer`, `feedBridgeOneResponse`,
 *      `getMediaBufferFromBridge`). Require a jsdom environment
 *      (`@jest-environment jsdom`). The harness installs a patched
 *      `window.fetch` that intercepts `googlevideo.com/videoplayback`
 *      URLs and feeds caller-supplied UMP bytes through the bridge's
 *      response handler.
 */

// ─── ISOBMFF byte-level fixture builders ────────────────────────────────────

/** Concatenate Uint8Arrays into one buffer. */
export function concat(...parts: ArrayLike<number>[]): Uint8Array {
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
export function u32be(value: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value >>> 0, false);
  return b;
}

/** ASCII 4cc → 4-byte sequence. */
export function fourcc(s: string): Uint8Array {
  if (s.length !== 4) throw new Error(`fourcc must be length 4, got "${s}"`);
  return new Uint8Array([
    s.charCodeAt(0),
    s.charCodeAt(1),
    s.charCodeAt(2),
    s.charCodeAt(3),
  ]);
}

/**
 * Build a generic ISOBMFF box `[size:4 BE][type:4cc][payload]`.
 * `size` is the total box size (header + payload). Empty-payload
 * boxes have size 8.
 */
export function buildBox(type: string, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const totalSize = 8 + payload.byteLength;
  return concat(u32be(totalSize), fourcc(type), payload);
}

/**
 * Build a `tfdt` box (FullBox version=0) carrying `baseMediaDecodeTime`.
 * Layout: [size:4][type:'tfdt'][version:1=0][flags:3=0][baseMediaDecodeTime:4 (v0)]
 */
export function buildTfdtV0(baseMediaDecodeTime: number): Uint8Array {
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
 * dedup in `flattenItagFromResponses` distinguishes fragments through
 * these bytes (offset 20..23 of the fragment) when their
 * `tfdt.baseMediaDecodeTime` happens to collide.
 */
export function buildMfhd(sequenceNumber: number): Uint8Array {
  const payload = concat(
    new Uint8Array([0x00, 0x00, 0x00, 0x00]), // version=0, flags=0
    u32be(sequenceNumber),
  );
  return buildBox("mfhd", payload);
}

/** Build a `traf` box wrapping a single `tfdt`. */
export function buildTraf(tfdt: Uint8Array): Uint8Array {
  return buildBox("traf", tfdt);
}

/**
 * Build a `moof` box with `mfhd` followed by one `traf`. Real SABR
 * `moof` boxes always carry `mfhd` first, so we mirror that layout.
 */
export function buildMoof(mfhd: Uint8Array, traf: Uint8Array): Uint8Array {
  return buildBox("moof", concat(mfhd, traf));
}

/** Build an `mdat` box with arbitrary payload bytes. */
export function buildMdat(payload: Uint8Array): Uint8Array {
  return buildBox("mdat", payload);
}

/**
 * Build a fragmented-MP4 init prefix: `[ftyp][moov]`. Both are
 * minimally-shaped. `moovExtra` lets a caller inject bytes at the
 * tail of the `moov` payload (used by `stripIsobmffHeaderToMoofs`
 * tests to insert false `"moof"` bytes inside `moov`).
 */
export function buildFtypMoovInit(moovExtra: Uint8Array = new Uint8Array(0)): Uint8Array {
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
 * `sequenceNumber` (in `mfhd`), `baseMediaDecodeTime` (in `tfdt`),
 * and `mdat` payload. No ftyp/moov prefix — these are the units
 * that arrive as separate UMP type-21 chunks for media iTags after
 * the init segment has been delivered.
 */
export function buildBareMoofMdatFragment(
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
 * `tfdt` child, so it falls out of the inner walk and returns -1.
 * Mirrors what the bridge sees when YouTube SABR ships a fragment
 * whose tfdt lies past the truncation point of our parse window.
 */
export function buildBrokenTfdtFragment(
  mdatPayload: Uint8Array,
  sequenceNumber: number = 1,
): Uint8Array {
  // traf with a single non-tfdt child box (e.g. trun) so
  // `readMoofBaseDecodeTime` walks past it without ever finding tfdt.
  const dummyTrun = buildBox("trun", new Uint8Array(8));
  const traf = buildBox("traf", dummyTrun);
  const moof = buildBox("moof", concat(buildMfhd(sequenceNumber), traf));
  return concat(moof, buildMdat(mdatPayload));
}

/** Make `length` distinct mdat payloads so byte-prefix dedup keeps them apart. */
export function distinctMdat(seed: number, length = 64): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (seed * 31 + i * 17) & 0xff;
  }
  return out;
}

// ─── UMP fixture builders ────────────────────────────────────────────────────

/** Encode a UMP varint using the 1/2/5-byte forms only (sufficient for tests). */
export function encodeUmpVarInt(value: number): Uint8Array {
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

export function encodeProtoVarInt(value: number): Uint8Array {
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
export function buildUmpFrame(type: number, payload: Uint8Array): Uint8Array {
  return concat(encodeUmpVarInt(type), encodeUmpVarInt(payload.length), payload);
}

/** Build a UMP type-20 (header) frame with field 3 (iTag) = `itag`. */
export function buildPart20FrameWithItag(itag: number): Uint8Array {
  // proto tag for field=3, wireType=0 is (3 << 3) | 0 = 24.
  const body = concat(encodeProtoVarInt(24), encodeProtoVarInt(itag));
  return buildUmpFrame(20, body);
}

/**
 * Build a UMP type-21 (media) frame whose payload is `[headerByte=0x00,
 * ...mediaBytes]`. The bridge skips the header byte.
 */
export function buildPart21Frame(mediaBytes: Uint8Array): Uint8Array {
  return buildUmpFrame(21, concat(new Uint8Array([0x00]), mediaBytes));
}

/**
 * Build one UMP "response" body containing a single (itag, mediaBytes)
 * media-only chunk.
 */
export function buildSingleChunkUmpBody(itag: number, mediaBytes: Uint8Array): Uint8Array {
  return concat(buildPart20FrameWithItag(itag), buildPart21Frame(mediaBytes));
}

/**
 * Pad a UMP body so the total response size exceeds the bridge's
 * 100-byte filter (`if (ab.byteLength < 100) return`). The extra
 * payload is appended AFTER the real (itag, mediaBytes) frame so its
 * iTag is overwritten by a final type-20 frame for an UNCAPTURED iTag
 * (999) — the bridge ignores those bytes for capture purposes.
 */
export function padUmpBody(body: Uint8Array, minBytes = 200): Uint8Array {
  if (body.byteLength >= minBytes) return body;
  const padLen = minBytes - body.byteLength;
  const partUncaptured = buildPart20FrameWithItag(999);
  const partFiller = buildPart21Frame(new Uint8Array(padLen));
  return concat(body, partUncaptured, partFiller);
}

// ─── jsdom bridge harness ────────────────────────────────────────────────────

export interface BridgeFetchHarness {
  fetched: string[];
  setNextResponse: (bytes: Uint8Array) => void;
  restore: () => void;
}

/**
 * Minimal fake response object that satisfies the bridge's fetch hook
 * contract: `.clone()` returns an object with `.arrayBuffer()`.
 * jsdom 20 does not ship a global `Response` constructor, so we
 * hand-roll a structurally-typed fake the bridge accepts.
 */
export function makeFakeResponse(bytes: Uint8Array): unknown {
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

/**
 * Install a mock `window.fetch` that returns a Response whose body
 * is `nextBytes` (set per-call via `setNextResponse`). Records every
 * URL the bridge issued so callers can assert flow.
 */
export function installBridgeFetch(): BridgeFetchHarness {
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
 * Returns a cleanup that resets `jest.resetModules()` so the next
 * test boots a fresh IIFE.
 */
export function loadBridgeIIFE(): { cleanup: () => void } {
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
 * starts empty for the next scenario. Synchronous — the handler does
 * `audioBuffers.delete(vid); responseChunks.delete(vid)`.
 */
export function clearBridgeBuffer(videoId: string): void {
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
 * Send a UMP body through the bridge's patched fetch and wait for
 * its async `arrayBuffer().then(...)` to flush. Resolves once the
 * bridge has seen the response and updated its internal
 * `responseChunks`.
 */
export async function feedBridgeOneResponse(
  fetchStub: BridgeFetchHarness,
  umpBytes: Uint8Array,
): Promise<void> {
  fetchStub.setNextResponse(umpBytes);
  // Anonymous googlevideo.com/videoplayback URL — bridge keys off
  // these substrings.
  await window.fetch(
    "https://rr1---sn-test.googlevideo.com/videoplayback?fakefixture=1",
  );
  // The bridge processes the response asynchronously inside
  // `clone.arrayBuffer().then(...)`. Yield the event loop a few
  // times to let that microtask chain resolve.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Send `GET_MEDIA_BUFFER` to the bridge and wait for its
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
 * because the IIFE never exposed it). All attached IIFEs respond.
 * Older IIFEs hold stale (now-empty) chunk stores and respond with
 * `audioSize: 0, videoSize: 0`. We collect EVERY response within
 * a settle window and pick the largest (`audioSize + videoSize` max)
 * — that is by construction the IIFE that just received our
 * `feedBridgeOneResponse` fetches.
 */
export async function getMediaBufferFromBridge(
  videoId: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const responses: Record<string, unknown>[] = [];
    const WAIT_MS = 100;
    const MAX_WAIT_MS = 2_000;
    let lastSeenAt = 0;
    const listener = (ev: MessageEvent): void => {
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
      // OR we have waited the maximum 2s.
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


/**
 * Build a `mdhd` box (FullBox version=0) carrying the supplied
 * `timescale`. Layout (32 bytes total):
 *   [size:4 = 0x20][type:'mdhd']
 *   [version:1=0][flags:3=0]
 *   [creation_time:4][modification_time:4]
 *   [timescale:4]
 *   [duration:4]
 *   [language:2][pre_defined:2]
 *
 * `timescale` lives at fullbox offset +12 in version 0. Real ISOBMFF
 * `mdhd` has 24 bytes of payload after the version+flags header,
 * which the function below produces.
 */
export function buildMdhdV0(timescale: number, duration: number = 0): Uint8Array {
  const payload = concat(
    new Uint8Array([0x00, 0x00, 0x00, 0x00]), // version=0, flags=0
    u32be(0), // creation_time
    u32be(0), // modification_time
    u32be(timescale), // timescale  ← what the gate cares about
    u32be(duration), // duration
    new Uint8Array([0x00, 0x00, 0x00, 0x00]), // language(2) + pre_defined(2)
  );
  return buildBox("mdhd", payload);
}

/**
 * Build a complete ISOBMFF init segment `[ftyp][moov]` with a single
 * `trak > mdia > mdhd(timescale)`. The bridge's `parseTrackTimescale`
 * walks `moov > trak > mdia > mdhd` exactly through this nesting,
 * reads the `timescale` field, and returns it for use as the divisor
 * in `computeLastTimestampSec`.
 *
 * `bytes[4..7]` of the result spell `ftyp`, which is what
 * `parseUmpResponseSeparated` keys off to set `isInit = true` on the
 * resulting chunk in the bridge's per-iTag chunk store.
 */
export function buildIsobmffInitSegment(timescale: number): Uint8Array {
  // ftyp: major_brand='isom', minor_version=512, compat brand='isom'.
  const ftypPayload = concat(fourcc("isom"), u32be(512), fourcc("isom"));
  const ftyp = buildBox("ftyp", ftypPayload);
  // mdhd → mdia → trak → moov.
  const mdhd = buildMdhdV0(timescale);
  const mdia = buildBox("mdia", mdhd);
  const trak = buildBox("trak", mdia);
  const moov = buildBox("moov", trak);
  return concat(ftyp, moov);
}

/**
 * Build an ISOBMFF init segment whose `moov` payload contains NO
 * `trak` box at all — `parseTrackTimescale` walks `moov > trak`,
 * fails to find `trak`, and returns 0. The bridge then falls back
 * to a timescale of 1000 in `computeLastTimestampSec`.
 */
export function buildIsobmffInitSegmentNoTrak(): Uint8Array {
  const ftypPayload = concat(fourcc("isom"), u32be(512), fourcc("isom"));
  const ftyp = buildBox("ftyp", ftypPayload);
  // moov with a non-trak child only → walker returns 0.
  const fillerChild = buildBox("free", new Uint8Array(8));
  const moov = buildBox("moov", fillerChild);
  return concat(ftyp, moov);
}
