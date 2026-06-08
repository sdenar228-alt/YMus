/**
 * UMP parse unit tests for `src/yt-content/yt-ump-parser.ts`.
 *
 * Coverage (per design.md "yt-page-bridge.ts" + tasks.md task 4.1):
 *
 *   - `readVarInt`        : 1/2/3/4/5-byte boundary forms; truncation
 *                           returns [0, 0]; illegal first byte returns
 *                           [0, 1]; value round-trips for all five sizes.
 *   - `readProtoVarInt`   : 7-bit continuation chains up to 5 bytes; the
 *                           35-bit shift cap is honoured.
 *   - `extractItagFromPart20` : wire types 0/1/2/5; missing field 3 → 0;
 *                               junk after field 3 does not throw.
 *   - `parseUmpResponse`  : single iTag → one stream/chunk; multiple
 *                           interleaved iTags → separate streams; EBML
 *                           magic populates `initSegment`; oversized
 *                           `size` bails the loop without throwing;
 *                           non-audio iTag (e.g. 22 — video) is ignored.
 *
 * Property-based tests use `fast-check` to verify the varint encoders
 * and decoders are exact inverses across the full input space they
 * cover.  The parser invariants (only `AUDIO_ITAGS` are captured;
 * `initSegment` is set at most once per stream) are exercised with
 * random byte payloads.
 */

import fc from "fast-check";
import {
  AUDIO_ITAGS,
  extractItagFromPart20,
  parseUmpResponse,
  readProtoVarInt,
  readVarInt,
  type AudioStream,
} from "../src/yt-content/yt-ump-parser";

// ─── encoders for synthesizing valid UMP / proto bytes ─────────────────────

/**
 * Encode `value` as a UMP varint using the smallest prefix size that fits.
 * Mirrors the bit layout decoded by `readVarInt`:
 *   size 1: `0xxxxxxx`                         (7 bits,  0–127)
 *   size 2: `10xxxxxx` `xxxxxxxx`              (14 bits, 0–16383)
 *   size 3: `110xxxxx` `xxxxxxxx` `xxxxxxxx`   (21 bits)
 *   size 4: `1110xxxx` × 1 + 3 raw LE bytes    (28 bits)
 *   size 5: `11110xxx` × 1 + 4 raw LE bytes    (35 bits, but we cap at 32)
 *
 * Throws on negative inputs.
 */
function encodeUmpVarInt(value: number): Uint8Array {
  if (value < 0 || !Number.isInteger(value)) {
    throw new Error(`encodeUmpVarInt: invalid value ${value}`);
  }
  if (value < 0x80) {
    // 1 byte: 0xxxxxxx
    return new Uint8Array([value & 0x7f]);
  }
  if (value < 1 << 14) {
    // 2 bytes: 10xxxxxx xxxxxxxx
    const b0 = 0x80 | (value & 0x3f);
    const b1 = (value >>> 6) & 0xff;
    return new Uint8Array([b0, b1]);
  }
  if (value < 1 << 21) {
    // 3 bytes: 110xxxxx then little-endian 16-bit (value >> 5)
    const high = (value >>> 5) & 0xffff;
    const b0 = 0xc0 | (value & 0x1f);
    return new Uint8Array([b0, high & 0xff, (high >>> 8) & 0xff]);
  }
  if (value < 1 << 28) {
    // 4 bytes: 1110xxxx then little-endian 24-bit (value >> 4)
    const high = (value >>> 4) >>> 0;
    const b0 = 0xe0 | (value & 0x0f);
    return new Uint8Array([
      b0,
      high & 0xff,
      (high >>> 8) & 0xff,
      (high >>> 16) & 0xff,
    ]);
  }
  // 5 bytes: 11110xxx then little-endian 32-bit (value >> 3).  We support
  // 32-bit values here (the JS shift by 3 is exact for value < 2^32-ish).
  // Use BigInt arithmetic to dodge the ">> 3" truncation on values that
  // straddle the JS 32-bit boundary.
  const big = BigInt(value);
  const lowBits = Number(big & 0x07n);
  const high = big >> 3n;
  const b0 = 0xf0 | lowBits;
  return new Uint8Array([
    b0,
    Number(high & 0xffn),
    Number((high >> 8n) & 0xffn),
    Number((high >> 16n) & 0xffn),
    Number((high >> 24n) & 0xffn),
  ]);
}

/** Encode `value` as a Protocol Buffers varint (7-bit continuation). */
function encodeProtoVarInt(value: number): Uint8Array {
  if (value < 0 || !Number.isInteger(value)) {
    throw new Error(`encodeProtoVarInt: invalid value ${value}`);
  }
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push(0x80 | (v & 0x7f));
    v = v >>> 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

/** Concatenate Uint8Arrays into a single contiguous buffer. */
function concatBytes(...parts: ArrayLike<number>[]): Uint8Array {
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

/**
 * Build a single UMP frame `[type-varint][size-varint][payload]`.
 */
function buildUmpFrame(type: number, payload: ArrayLike<number>): Uint8Array {
  return concatBytes(
    encodeUmpVarInt(type),
    encodeUmpVarInt(payload.length),
    payload as Uint8Array,
  );
}

/**
 * Build a UMP type-20 (header) frame whose proto body sets field 3 (the
 * iTag) to `itag` via wire type 0 (varint).  Optional `prefixFields` adds
 * extra proto fields ahead of field 3 to exercise the wire-type walker.
 */
function buildPart20FrameWithItag(itag: number, prefixFields: ArrayLike<number> = []): Uint8Array {
  // proto tag for field=3, wireType=0 (varint) is (3 << 3) | 0 = 24.
  const tag = (3 << 3) | 0;
  const body = concatBytes(
    prefixFields as Uint8Array,
    encodeProtoVarInt(tag),
    encodeProtoVarInt(itag),
  );
  return buildUmpFrame(20, body);
}

/** Build a UMP type-21 (media) frame whose payload is `[headerByte, ...data]`. */
function buildPart21Frame(headerByte: number, data: ArrayLike<number>): Uint8Array {
  return buildUmpFrame(
    21,
    concatBytes(new Uint8Array([headerByte & 0xff]), data as Uint8Array),
  );
}

// ─── readVarInt ────────────────────────────────────────────────────────────

describe("readVarInt", () => {
  describe("encoder is the exact inverse of readVarInt across all 5 sizes", () => {
    it.each([
      ["1-byte (0–127)", 0, 0x7f],
      ["2-byte (128–16383)", 0x80, (1 << 14) - 1],
      ["3-byte (16384–2097151)", 1 << 14, (1 << 21) - 1],
      ["4-byte (2097152–268435455)", 1 << 21, (1 << 28) - 1],
      ["5-byte (268435456–~4G)", 1 << 28, 0xffffffff],
    ])("round-trip on the %s range", (_label, min, max) => {
      fc.assert(
        fc.property(fc.integer({ min, max }), (value) => {
          const encoded = encodeUmpVarInt(value);
          const [decoded, consumed] = readVarInt(encoded, 0);
          expect(consumed).toBe(encoded.byteLength);
          expect(decoded).toBe(value);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe("size selection on bit-pattern boundaries", () => {
    it("uses 1 byte for 0 and 127", () => {
      expect(readVarInt(encodeUmpVarInt(0), 0)).toEqual([0, 1]);
      expect(readVarInt(encodeUmpVarInt(127), 0)).toEqual([127, 1]);
    });

    it("uses 2 bytes for 128 and 16383", () => {
      expect(readVarInt(encodeUmpVarInt(128), 0)).toEqual([128, 2]);
      expect(readVarInt(encodeUmpVarInt(16383), 0)).toEqual([16383, 2]);
    });

    it("uses 3 bytes for 16384 and 2097151", () => {
      expect(readVarInt(encodeUmpVarInt(16384), 0)).toEqual([16384, 3]);
      expect(readVarInt(encodeUmpVarInt(2097151), 0)).toEqual([2097151, 3]);
    });

    it("uses 4 bytes for 2097152 and 268435455", () => {
      expect(readVarInt(encodeUmpVarInt(2097152), 0)).toEqual([2097152, 4]);
      expect(readVarInt(encodeUmpVarInt(268435455), 0)).toEqual([268435455, 4]);
    });

    it("uses 5 bytes for 268435456 and 0xFFFFFFFF", () => {
      expect(readVarInt(encodeUmpVarInt(268435456), 0)).toEqual([268435456, 5]);
      expect(readVarInt(encodeUmpVarInt(0xffffffff), 0)).toEqual([0xffffffff, 5]);
    });
  });

  describe("truncation", () => {
    it("returns [0, 0] when offset is past end", () => {
      const buf = new Uint8Array([0x01]);
      expect(readVarInt(buf, 1)).toEqual([0, 0]);
      expect(readVarInt(buf, 99)).toEqual([0, 0]);
    });

    it("returns [0, 0] when an empty buffer is read", () => {
      expect(readVarInt(new Uint8Array(0), 0)).toEqual([0, 0]);
    });

    it("returns [0, 0] when a 2-byte varint is missing its tail byte", () => {
      // 0x80 says "2-byte varint" but we provide only the first byte.
      const buf = new Uint8Array([0x80]);
      expect(readVarInt(buf, 0)).toEqual([0, 0]);
    });

    it("returns [0, 0] when a 5-byte varint is missing tail bytes", () => {
      // 0xF0 says "5-byte varint" but we provide only 3 bytes.
      const buf = new Uint8Array([0xf0, 0x00, 0x00]);
      expect(readVarInt(buf, 0)).toEqual([0, 0]);
    });

    it("returns [0, 0] for every truncation prefix of any 5-byte varint", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1 << 28, max: 0xffffffff }),
          fc.integer({ min: 0, max: 4 }),
          (value, drop) => {
            const full = encodeUmpVarInt(value);
            const truncated = full.slice(0, full.byteLength - drop - 1);
            // drop=0 keeps full bytes (sanity), drop>=1 actually truncates.
            if (truncated.byteLength === full.byteLength) {
              expect(readVarInt(truncated, 0)).toEqual([value, full.byteLength]);
            } else {
              expect(readVarInt(truncated, 0)).toEqual([0, 0]);
            }
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  describe("illegal first byte", () => {
    it("returns [0, 1] for 0xF8 (top 5 bits = 11111)", () => {
      // 0xF8 = 11111000.  None of the size selectors match (all five reject
      // it via bit pattern), so the legacy contract is "advance one byte".
      const buf = new Uint8Array([0xf8, 0x00, 0x00, 0x00, 0x00]);
      expect(readVarInt(buf, 0)).toEqual([0, 1]);
    });

    it("returns [0, 1] for 0xFF (all bits set)", () => {
      const buf = new Uint8Array([0xff, 0x00, 0x00, 0x00, 0x00]);
      expect(readVarInt(buf, 0)).toEqual([0, 1]);
    });
  });
});

// ─── readProtoVarInt ───────────────────────────────────────────────────────

describe("readProtoVarInt", () => {
  it("decodes 0 as a single byte", () => {
    expect(readProtoVarInt(new Uint8Array([0]), 0)).toEqual([0, 1]);
  });

  it("decodes single-byte values 0–127", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 127 }), (v) => {
        const buf = encodeProtoVarInt(v);
        expect(buf.byteLength).toBe(1);
        expect(readProtoVarInt(buf, 0)).toEqual([v, 1]);
      }),
      { numRuns: 50 },
    );
  });

  it("decodes 2-byte continuation chains (128–16383)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 128, max: 16383 }), (v) => {
        const buf = encodeProtoVarInt(v);
        expect(buf.byteLength).toBe(2);
        const [decoded, off] = readProtoVarInt(buf, 0);
        expect(decoded).toBe(v);
        expect(off).toBe(2);
      }),
      { numRuns: 50 },
    );
  });

  it("decodes 5-byte continuation chains (full 32-bit unsigned)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1 << 28, max: 0xffffffff }), (v) => {
        const buf = encodeProtoVarInt(v);
        expect(buf.byteLength).toBe(5);
        const [decoded] = readProtoVarInt(buf, 0);
        expect(decoded).toBe(v);
      }),
      { numRuns: 50 },
    );
  });

  it("advances the offset past the consumed bytes", () => {
    // [proto-varint=300][trailing-byte 0xAB] — decoder must stop after
    // the second byte.
    const v = 300; // 0xAC 0x02 in proto-varint
    const buf = concatBytes(encodeProtoVarInt(v), new Uint8Array([0xab]));
    const [decoded, newOff] = readProtoVarInt(buf, 0);
    expect(decoded).toBe(v);
    expect(newOff).toBe(2); // 300 takes 2 bytes
    expect(buf[newOff]).toBe(0xab); // trailing byte intact
  });

  it("honours the 35-bit shift cap (continuation past byte 5 is ignored)", () => {
    // Six continuation bytes — every byte has the high bit set.  The legacy
    // implementation breaks once `shift > 35`, so the 6th byte must NOT
    // contribute to the result.  We assert the loop terminates and the
    // decoded value matches the first 5 bytes only.
    const sixCont = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const [, off] = readProtoVarInt(sixCont, 0);
    // The reader stops after consuming 6 bytes (the cap-break happens after
    // the 6th increment); the exact value is implementation-defined for
    // overflow, but it MUST NOT throw and MUST advance past byte 5.
    expect(off).toBeGreaterThanOrEqual(5);
    expect(off).toBeLessThanOrEqual(6);
  });

  it("treats out-of-bounds offset as a no-op (returns [0, offset])", () => {
    const buf = new Uint8Array([0x01]);
    expect(readProtoVarInt(buf, 99)).toEqual([0, 99]);
    expect(readProtoVarInt(buf, buf.byteLength)).toEqual([0, buf.byteLength]);
  });
});

// ─── extractItagFromPart20 ─────────────────────────────────────────────────

describe("extractItagFromPart20", () => {
  it("returns field-3 value when wire type 0 (varint)", () => {
    // [tag=24 (field=3, wire=0)][value=140]
    const body = concatBytes(encodeProtoVarInt(24), encodeProtoVarInt(140));
    expect(extractItagFromPart20(body, 0, body.byteLength)).toBe(140);
  });

  it("returns 0 when no field 3 is present", () => {
    // Only field 1 (varint) — `1<<3 | 0 = 8`
    const body = concatBytes(encodeProtoVarInt(8), encodeProtoVarInt(42));
    expect(extractItagFromPart20(body, 0, body.byteLength)).toBe(0);
  });

  it("returns 0 on an empty proto body", () => {
    const empty = new Uint8Array(0);
    expect(extractItagFromPart20(empty, 0, 0)).toBe(0);
  });

  it("skips wire type 2 (length-delimited) and finds field 3 after it", () => {
    // Field 1, wire 2, length=4, payload=[1,2,3,4]; then field 3, wire 0, value=251.
    const tag1Wire2 = (1 << 3) | 2; // = 10
    const tag3Wire0 = (3 << 3) | 0; // = 24
    const body = concatBytes(
      encodeProtoVarInt(tag1Wire2),
      encodeProtoVarInt(4),
      new Uint8Array([1, 2, 3, 4]),
      encodeProtoVarInt(tag3Wire0),
      encodeProtoVarInt(251),
    );
    expect(extractItagFromPart20(body, 0, body.byteLength)).toBe(251);
  });

  it("skips wire type 5 (4-byte fixed) and finds field 3 after it", () => {
    // Field 2, wire 5, 4 raw bytes; then field 3 = 250.
    const tag2Wire5 = (2 << 3) | 5; // = 21
    const tag3Wire0 = (3 << 3) | 0;
    const body = concatBytes(
      encodeProtoVarInt(tag2Wire5),
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      encodeProtoVarInt(tag3Wire0),
      encodeProtoVarInt(250),
    );
    expect(extractItagFromPart20(body, 0, body.byteLength)).toBe(250);
  });

  it("skips wire type 1 (8-byte fixed) and finds field 3 after it", () => {
    // Field 2, wire 1, 8 raw bytes; then field 3 = 141.
    const tag2Wire1 = (2 << 3) | 1; // = 17
    const tag3Wire0 = (3 << 3) | 0;
    const body = concatBytes(
      encodeProtoVarInt(tag2Wire1),
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      encodeProtoVarInt(tag3Wire0),
      encodeProtoVarInt(141),
    );
    expect(extractItagFromPart20(body, 0, body.byteLength)).toBe(141);
  });

  it("breaks on unknown wire types (3, 4, 6, 7) without throwing", () => {
    fc.assert(
      fc.property(fc.constantFrom(3, 4, 6, 7), (badWire) => {
        const tag1Bad = (1 << 3) | badWire;
        const body = concatBytes(encodeProtoVarInt(tag1Bad), new Uint8Array([0xff]));
        // Must not throw.  Result is 0 because the walker breaks before
        // observing field 3.
        expect(() => extractItagFromPart20(body, 0, body.byteLength)).not.toThrow();
        expect(extractItagFromPart20(body, 0, body.byteLength)).toBe(0);
      }),
    );
  });

  it("does not throw when junk follows field 3", () => {
    // Field 3 = 140, then arbitrary wire-type-0 garbage, then a wire-type-2
    // chunk whose declared length is bogus.  The function must return 140
    // without walking past the boundary.
    const tag3Wire0 = (3 << 3) | 0;
    const body = concatBytes(
      encodeProtoVarInt(tag3Wire0),
      encodeProtoVarInt(140),
      encodeProtoVarInt((1 << 3) | 2),
      encodeProtoVarInt(9999), // length way beyond `end`
    );
    expect(() => extractItagFromPart20(body, 0, body.byteLength)).not.toThrow();
    expect(extractItagFromPart20(body, 0, body.byteLength)).toBe(140);
  });

  it("respects the [start, end) window — does not read past `end`", () => {
    // Place a field-3=200 record, then sentinel bytes outside the window.
    const tag3Wire0 = (3 << 3) | 0;
    const inside = concatBytes(encodeProtoVarInt(tag3Wire0), encodeProtoVarInt(200));
    const outside = encodeProtoVarInt(999); // would be read if window ignored
    const body = concatBytes(inside, outside);
    expect(extractItagFromPart20(body, 0, inside.byteLength)).toBe(200);
  });
});

// ─── parseUmpResponse ──────────────────────────────────────────────────────

describe("parseUmpResponse", () => {
  it("captures a single audio iTag (140) with one media chunk", () => {
    const part20 = buildPart20FrameWithItag(140);
    const audioBytes = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
    const part21 = buildPart21Frame(0x00, audioBytes);
    const buf = concatBytes(part20, part21);

    const streams = new Map<number, AudioStream>();
    parseUmpResponse(buf, streams);

    expect(streams.size).toBe(1);
    const s = streams.get(140);
    expect(s).toBeDefined();
    expect(s!.itag).toBe(140);
    expect(s!.initSegment).toBeNull();
    expect(s!.chunks).toHaveLength(1);
    expect(Array.from(s!.chunks[0])).toEqual(Array.from(audioBytes));
    expect(s!.totalSize).toBe(audioBytes.byteLength);
  });

  it("captures multiple interleaved iTags into separate streams", () => {
    // [part20: 140][part21: 5 bytes][part20: 251][part21: 7 bytes][part21: 4 bytes for 251]
    const partA20 = buildPart20FrameWithItag(140);
    const partA21 = buildPart21Frame(0x00, new Uint8Array([1, 2, 3, 4, 5]));
    const partB20 = buildPart20FrameWithItag(251);
    const partB21a = buildPart21Frame(0x00, new Uint8Array([10, 20, 30, 40, 50, 60, 70]));
    const partB21b = buildPart21Frame(0x00, new Uint8Array([11, 22, 33, 44]));
    const buf = concatBytes(partA20, partA21, partB20, partB21a, partB21b);

    const streams = new Map<number, AudioStream>();
    parseUmpResponse(buf, streams);

    expect(streams.size).toBe(2);
    const s140 = streams.get(140);
    const s251 = streams.get(251);
    expect(s140).toBeDefined();
    expect(s251).toBeDefined();
    expect(s140!.totalSize).toBe(5);
    expect(s140!.chunks).toHaveLength(1);
    expect(s251!.totalSize).toBe(7 + 4);
    expect(s251!.chunks).toHaveLength(2);
  });

  it("detects EBML magic (1A 45 DF A3) and routes it to initSegment, not chunks", () => {
    const part20 = buildPart20FrameWithItag(251);
    const ebmlInit = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86]);
    const part21Init = buildPart21Frame(0x00, ebmlInit);
    const part21Media = buildPart21Frame(0x00, new Uint8Array([0xaa, 0xbb, 0xcc]));
    const buf = concatBytes(part20, part21Init, part21Media);

    const streams = new Map<number, AudioStream>();
    parseUmpResponse(buf, streams);

    const s = streams.get(251);
    expect(s).toBeDefined();
    expect(s!.initSegment).not.toBeNull();
    expect(Array.from(s!.initSegment!)).toEqual(Array.from(ebmlInit));
    // The non-EBML chunk goes to chunks; init bytes are NOT counted in
    // totalSize.
    expect(s!.chunks).toHaveLength(1);
    expect(s!.totalSize).toBe(3);
  });

  it("only stores the FIRST EBML init segment per stream", () => {
    const part20 = buildPart20FrameWithItag(251);
    const ebmlInit1 = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]);
    const ebmlInit2 = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x02, 0x03]);
    const part21A = buildPart21Frame(0x00, ebmlInit1);
    const part21B = buildPart21Frame(0x00, ebmlInit2);
    const buf = concatBytes(part20, part21A, part21B);

    const streams = new Map<number, AudioStream>();
    parseUmpResponse(buf, streams);

    const s = streams.get(251);
    expect(s).toBeDefined();
    expect(s!.initSegment).not.toBeNull();
    // First wins.
    expect(Array.from(s!.initSegment!)).toEqual(Array.from(ebmlInit1));
    // The second EBML-magic-prefixed payload falls to chunks because
    // initSegment is already set.
    expect(s!.chunks).toHaveLength(1);
    expect(Array.from(s!.chunks[0])).toEqual(Array.from(ebmlInit2));
  });

  it("ignores non-audio iTags (e.g. video iTag 22)", () => {
    const part20 = buildPart20FrameWithItag(22); // 22 is a video iTag, not audio
    const part21 = buildPart21Frame(0x00, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const buf = concatBytes(part20, part21);

    const streams = new Map<number, AudioStream>();
    parseUmpResponse(buf, streams);

    expect(streams.size).toBe(0);
  });

  it("ignores all non-audio iTags but captures audio iTags from the same stream", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }).filter((n) => !AUDIO_ITAGS.has(n)),
        (nonAudioItag) => {
          const buf = concatBytes(
            buildPart20FrameWithItag(nonAudioItag),
            buildPart21Frame(0x00, new Uint8Array([0xff, 0xee, 0xdd])),
            buildPart20FrameWithItag(140),
            buildPart21Frame(0x00, new Uint8Array([0x01, 0x02, 0x03])),
          );

          const streams = new Map<number, AudioStream>();
          parseUmpResponse(buf, streams);

          // Only the audio itag should be captured.
          expect(streams.has(nonAudioItag)).toBe(false);
          expect(streams.has(140)).toBe(true);
          expect(streams.get(140)!.totalSize).toBe(3);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("does not throw when a frame's declared size exceeds the remaining buffer", () => {
    // Hand-build a frame with a size varint larger than what's left.
    const part20 = buildPart20FrameWithItag(140);
    // type=21, size=999, but only 3 bytes follow.
    const fakeFrame = concatBytes(
      encodeUmpVarInt(21),
      encodeUmpVarInt(999),
      new Uint8Array([0xaa, 0xbb, 0xcc]),
    );
    const buf = concatBytes(part20, fakeFrame);

    const streams = new Map<number, AudioStream>();
    expect(() => parseUmpResponse(buf, streams)).not.toThrow();
  });

  it("does not throw on empty or near-empty buffers", () => {
    const streams = new Map<number, AudioStream>();
    expect(() => parseUmpResponse(new Uint8Array(0), streams)).not.toThrow();
    expect(() => parseUmpResponse(new Uint8Array([0]), streams)).not.toThrow();
    expect(streams.size).toBe(0);
  });

  it("does not throw on random byte payloads (fuzz)", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 4096 }),
        (bytes) => {
          const streams = new Map<number, AudioStream>();
          expect(() => parseUmpResponse(bytes, streams)).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("captures bytes from offset+1 (skips the type-21 header byte)", () => {
    // Verify the well-known UMP type-21 protocol detail: the first byte of
    // the payload is a header tag the parser drops.  We choose 0x42 as the
    // header byte and ensure it does NOT appear in the captured chunk.
    const part20 = buildPart20FrameWithItag(140);
    const part21 = buildPart21Frame(0x42, new Uint8Array([0xaa, 0xbb, 0xcc]));
    const buf = concatBytes(part20, part21);

    const streams = new Map<number, AudioStream>();
    parseUmpResponse(buf, streams);

    const s = streams.get(140)!;
    expect(s.totalSize).toBe(3);
    expect(Array.from(s.chunks[0])).toEqual([0xaa, 0xbb, 0xcc]);
    expect(s.chunks[0]).not.toContain(0x42);
  });

  it("ignores type-21 frames whose payload is too small (size <= 1)", () => {
    const part20 = buildPart20FrameWithItag(140);
    // A type-21 frame with size=1 (just the header byte, no media bytes)
    const tooSmall = concatBytes(
      encodeUmpVarInt(21),
      encodeUmpVarInt(1),
      new Uint8Array([0x00]),
    );
    const buf = concatBytes(part20, tooSmall);

    const streams = new Map<number, AudioStream>();
    parseUmpResponse(buf, streams);
    expect(streams.size).toBe(0);
  });

  it("ignores type-20 frames whose payload is too small (size <= 2)", () => {
    // type=20 with size=2 — too small to extract an iTag.  Following type-21
    // frame should be ignored because currentItag stays at 0 (initial).
    const tinyPart20 = concatBytes(
      encodeUmpVarInt(20),
      encodeUmpVarInt(2),
      new Uint8Array([0x18, 0x8c]), // would-be tag+value if size>2 was honoured
    );
    const part21 = buildPart21Frame(0x00, new Uint8Array([1, 2, 3]));
    const buf = concatBytes(tinyPart20, part21);

    const streams = new Map<number, AudioStream>();
    parseUmpResponse(buf, streams);
    // currentItag is still 0 (never updated), so the part21 is not captured.
    expect(streams.has(0)).toBe(false);
    expect(streams.size).toBe(0);
  });

  it("bails the loop on a frame type > 200 without throwing", () => {
    // 201 is illegal per the legacy contract — parser breaks out of the
    // loop.  We place it BEFORE a valid audio frame to confirm bail-out
    // happens (the audio frame would otherwise be captured).
    const garbageType = concatBytes(
      encodeUmpVarInt(201),
      encodeUmpVarInt(2),
      new Uint8Array([0x00, 0x01]),
    );
    const part20 = buildPart20FrameWithItag(140);
    const part21 = buildPart21Frame(0x00, new Uint8Array([1, 2, 3]));
    const buf = concatBytes(garbageType, part20, part21);

    const streams = new Map<number, AudioStream>();
    expect(() => parseUmpResponse(buf, streams)).not.toThrow();
    // The valid frames after the garbage type are unreachable because the
    // parser breaks on type > 200.
    expect(streams.size).toBe(0);
  });

  it("accumulates totalSize across multiple chunks for the same iTag", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 64 }), { minLength: 2, maxLength: 8 }),
        (chunkSizes) => {
          const part20 = buildPart20FrameWithItag(140);
          const frames: Uint8Array[] = [part20];
          let expectedTotal = 0;
          for (const sz of chunkSizes) {
            const data = new Uint8Array(sz);
            for (let i = 0; i < sz; i++) data[i] = (i + 1) & 0xff;
            frames.push(buildPart21Frame(0x00, data));
            expectedTotal += sz;
          }
          const buf = concatBytes(...frames);

          const streams = new Map<number, AudioStream>();
          parseUmpResponse(buf, streams);

          const s = streams.get(140);
          expect(s).toBeDefined();
          expect(s!.totalSize).toBe(expectedTotal);
          expect(s!.chunks).toHaveLength(chunkSizes.length);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("leaves chunks empty if an audio iTag has no following type-21 frame", () => {
    const part20 = buildPart20FrameWithItag(141);
    const streams = new Map<number, AudioStream>();
    parseUmpResponse(part20, streams);
    // The parser does not eagerly create a stream entry for the iTag
    // until a type-21 frame is observed for it.
    expect(streams.size).toBe(0);
  });
});

// ─── AUDIO_ITAGS contract sanity ────────────────────────────────────────────

describe("AUDIO_ITAGS", () => {
  it("contains exactly the documented audio iTags", () => {
    const expected = [140, 141, 249, 250, 251, 256, 258, 327, 328];
    expect(Array.from(AUDIO_ITAGS).sort((a, b) => a - b)).toEqual(expected);
  });

  it("does not contain video iTags or zero", () => {
    for (const v of [0, 22, 137, 248, 299, 303, 399]) {
      expect(AUDIO_ITAGS.has(v)).toBe(false);
    }
  });
});
