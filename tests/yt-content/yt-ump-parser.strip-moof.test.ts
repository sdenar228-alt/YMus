/**
 * Unit tests for `stripIsobmffHeaderToMoofs` from
 * `src/yt-content/yt-ump-parser.ts`.
 *
 * The function strips the `[ftyp][moov]` init prefix off captured
 * ISOBMFF chunks so the bridge can concatenate `init + bare-moof+mdat
 * + bare-moof+mdat + ...` into one valid fragmented-MP4 byte stream.
 *
 * The fixed implementation walks top-level boxes via `readBoxHeader`
 * and returns the slice starting at the first box whose `type ===
 * "moof"` — robust against `0x6d 0x6f 0x6f 0x66` byte sequences that
 * happen to occur inside `mdat` payloads (or anywhere outside a real
 * box header). The previous brute-force `for i { bytes[i..i+4] ===
 * "moof" }` scan would mistake those false hits for the real moof
 * box header.
 *
 * These tests lock in the box-walker behaviour as a Task 4.1
 * supporting unit suite for spec
 * `youtube-download-mux-corruption-fix`.
 */

import { stripIsobmffHeaderToMoofs } from "../../src/yt-content/yt-ump-parser";
import {
  buildBareMoofMdatFragment,
  buildBox,
  buildFtypMoovInit,
  buildMdat,
  buildMfhd,
  buildMoof,
  buildTfdtV0,
  buildTraf,
  concat,
  distinctMdat,
  fourcc,
  u32be,
} from "./yt-page-bridge.test-helpers";

describe("stripIsobmffHeaderToMoofs (Task 4.1 — box-header walk)", () => {
  it("happy path: [ftyp][moov][moof][mdat] returns slice starting at moof", () => {
    const init = buildFtypMoovInit();
    const moof = buildMoof(buildMfhd(1), buildTraf(buildTfdtV0(0)));
    const mdat = buildMdat(distinctMdat(1, 32));
    const moofOffset = init.byteLength;
    const fixture = concat(init, moof, mdat);

    const stripped = stripIsobmffHeaderToMoofs(fixture);

    // Stripped buffer length equals fixture length minus the init prefix.
    expect(stripped.byteLength).toBe(fixture.byteLength - moofOffset);
    // First 8 bytes of stripped = `[size:4][type='moof']`.
    expect(stripped[4]).toBe(0x6d);
    expect(stripped[5]).toBe(0x6f);
    expect(stripped[6]).toBe(0x6f);
    expect(stripped[7]).toBe(0x66);
    // Byte-equality with the original moof+mdat tail of the fixture.
    expect(Array.from(stripped)).toEqual(
      Array.from(fixture.subarray(moofOffset)),
    );
  });

  it("multi-fragment: [ftyp][moov][moof_A][mdat_A][moof_B][mdat_B] returns slice starting at moof_A", () => {
    const init = buildFtypMoovInit();
    const fragA = buildBareMoofMdatFragment(0, distinctMdat(1, 32), 1);
    const fragB = buildBareMoofMdatFragment(1024, distinctMdat(2, 32), 2);
    const moofAOffset = init.byteLength;
    const fixture = concat(init, fragA, fragB);

    const stripped = stripIsobmffHeaderToMoofs(fixture);

    // Slice starts at first moof — byte-identical with the
    // concatenation of both fragments.
    expect(stripped.byteLength).toBe(fragA.byteLength + fragB.byteLength);
    expect(Array.from(stripped)).toEqual(
      Array.from(fixture.subarray(moofAOffset)),
    );
    // Sanity: the SECOND moof box still appears at the expected
    // offset inside the returned slice (right after fragA).
    expect(stripped[fragA.byteLength + 4]).toBe(0x6d);
    expect(stripped[fragA.byteLength + 5]).toBe(0x6f);
    expect(stripped[fragA.byteLength + 6]).toBe(0x6f);
    expect(stripped[fragA.byteLength + 7]).toBe(0x66);
  });

  it("no moof: [ftyp][moov] returns input unchanged", () => {
    const fixture = buildFtypMoovInit();

    const stripped = stripIsobmffHeaderToMoofs(fixture);

    // Reference equality is sufficient for the "unchanged" contract.
    expect(stripped).toBe(fixture);
  });

  it("not ISOBMFF (no ftyp magic): returns input unchanged", () => {
    // Bytes that look nothing like a fragmented-MP4 file.
    const fixture = new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, // EBML magic — distinctly NOT ftyp
      0x00, 0x00, 0x00, 0x10,
      0x6d, 0x6f, 0x6f, 0x66, // "moof" bytes inside the body
      0xde, 0xad, 0xbe, 0xef,
    ]);

    const stripped = stripIsobmffHeaderToMoofs(fixture);

    expect(stripped).toBe(fixture);
  });

  it('"moof" inside mdat payload, real moof first: returns slice at the real moof header', () => {
    // Build [ftyp][moov][moof_real][mdat_with_inline_moof_bytes].
    // The mdat payload carries the byte sequence `0x6d 0x6f 0x6f 0x66`
    // somewhere inside it. A brute-force scan from offset 4 would
    // find the real moof first (because it precedes mdat) — but if
    // the box-walker were wrong and misaligned to the mdat-internal
    // bytes, the slice would start at a non-moof offset. This case
    // mirrors the realistic SABR shape after the init has been seen.
    const init = buildFtypMoovInit();
    const moof = buildMoof(buildMfhd(1), buildTraf(buildTfdtV0(0)));
    // mdat payload contains the literal "moof" 4cc somewhere in the
    // middle. The walker must NOT split the mdat box at that offset
    // — `mdat.size` covers the entire payload as one box.
    const inlineMoofBytes = fourcc("moof");
    const mdatPayload = concat(
      new Uint8Array(16), // leading filler
      inlineMoofBytes, // ← false "moof" bytes inside the mdat payload
      new Uint8Array(16), // trailing filler
    );
    const mdat = buildMdat(mdatPayload);
    const moofOffset = init.byteLength;
    const fixture = concat(init, moof, mdat);

    const stripped = stripIsobmffHeaderToMoofs(fixture);

    // Slice MUST start at the real moof box header (byte position
    // `init.byteLength`), with the exact `moof + mdat` tail.
    expect(stripped.byteLength).toBe(fixture.byteLength - moofOffset);
    expect(stripped[4]).toBe(0x6d);
    expect(stripped[5]).toBe(0x6f);
    expect(stripped[6]).toBe(0x6f);
    expect(stripped[7]).toBe(0x66);
    // Bytes 4..7 of the slice are at fixture offset moofOffset+4..+7.
    // Conversely, the inline "moof" bytes inside mdat are at a
    // strictly later offset; the slice MUST NOT begin there.
    const inlineFakeOffset = (() => {
      // Search inside the original fixture for the first inline-mdat
      // "moof" occurrence (it lies after the real moof).
      for (let i = moofOffset + 8; i < fixture.byteLength - 4; i++) {
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
    expect(inlineFakeOffset).toBeGreaterThan(moofOffset);
    // The slice length corresponds to a slice starting at moofOffset,
    // not at (inlineFakeOffset - 4).
    expect(stripped.byteLength).not.toBe(
      fixture.byteLength - (inlineFakeOffset - 4),
    );
  });

  it('truncated box.size = 0 mid-walk: returns input unchanged (defensive)', () => {
    // Build [ftyp][bad-box where the SIZE field reads 0x00000000].
    // ISO/IEC 14496-12 says box.size=0 means "extends to end of file".
    // Our `readBoxHeader` translates that to `size = bytes.byteLength
    // - offset` (treats it as "rest of file") — but in the wild a
    // truncated-size box is more often a sign of a malformed buffer.
    //
    // The fix's defensive guard `if (box.size <= 0 || pos + box.size
    // > bytes.byteLength) return bytes` short-circuits when the
    // "rest of file" interpretation would consume the entire
    // remainder without reaching a real `moof`. Callers receive the
    // input unchanged rather than a wrong slice.
    //
    // We construct: [ftyp][garbage box with size=0] followed by NO
    // moof at all — the walker reads ftyp normally, then `readBoxHeader`
    // sees size=0 and returns `{ size: bytes.byteLength - pos, type:
    // 'XXXX', headerSize: 8 }`. The walker advances `pos += box.size`,
    // which jumps to bytes.byteLength, and the loop exits. There is
    // no moof anywhere — function returns the input unchanged.
    const ftypPayload = concat(fourcc("isom"), u32be(512), fourcc("isom"));
    const ftyp = buildBox("ftyp", ftypPayload);
    // Hand-craft a box whose 4-byte size field is exactly zero.
    const badBox = concat(
      new Uint8Array([0x00, 0x00, 0x00, 0x00]), // size = 0 — "to end of file"
      fourcc("XXXX"), // type = arbitrary 4cc, definitely not 'moof'
      new Uint8Array(16), // body bytes
    );
    const fixture = concat(ftyp, badBox);

    const stripped = stripIsobmffHeaderToMoofs(fixture);

    // No moof found → input returned unchanged.
    expect(stripped).toBe(fixture);
  });
});
