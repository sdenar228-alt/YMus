import { embedFlacMetadata, FlacMeta } from "../../src/background/flac-meta";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal valid FLAC file with only a STREAMINFO block and some fake audio frames. */
function buildMinimalFlac(audioFrameBytes?: Uint8Array): Uint8Array {
  // "fLaC" magic
  const magic = new Uint8Array([0x66, 0x4c, 0x61, 0x43]);

  // STREAMINFO block: type=0, last-block=true (0x80), body length=34
  const streamInfoHeader = new Uint8Array([0x80, 0x00, 0x00, 0x22]); // 0x22 = 34
  const streamInfoBody = new Uint8Array(34); // all zeros is fine for testing
  // Set some minimal sample rate info (44100 Hz, 2 channels, 16 bits)
  // Bytes 10-13 contain sample rate (20 bits), channels (3 bits), bps (5 bits), total samples (36 bits)
  // 44100 = 0xAC44, shifted left by 12 bits for the 20-bit field
  streamInfoBody[10] = 0x0a; // sample rate high bits
  streamInfoBody[11] = 0xc4; // sample rate mid bits
  streamInfoBody[12] = 0x42; // sample rate low 4 bits + channels (2-1=1, 3 bits) + bps high 1 bit
  streamInfoBody[13] = 0xf0; // bps low 4 bits (16-1=15) + total samples high 4 bits

  const audio = audioFrameBytes ?? new Uint8Array([0xff, 0xf8, 0x01, 0x02, 0x03, 0x04]);

  const result = new Uint8Array(
    magic.length + streamInfoHeader.length + streamInfoBody.length + audio.length,
  );
  let offset = 0;
  result.set(magic, offset); offset += magic.length;
  result.set(streamInfoHeader, offset); offset += streamInfoHeader.length;
  result.set(streamInfoBody, offset); offset += streamInfoBody.length;
  result.set(audio, offset);

  return result;
}

/** Build a FLAC file with STREAMINFO (not last) + another block (last) + audio */
function buildFlacWithExistingBlocks(): Uint8Array {
  const magic = new Uint8Array([0x66, 0x4c, 0x61, 0x43]);

  // STREAMINFO: type=0, not last (0x00), body=34
  const streamInfoHeader = new Uint8Array([0x00, 0x00, 0x00, 0x22]);
  const streamInfoBody = new Uint8Array(34);

  // Existing VORBIS_COMMENT: type=4, not last (0x04), body=16
  const oldVorbisHeader = new Uint8Array([0x04, 0x00, 0x00, 0x10]); // 16 bytes
  const oldVorbisBody = new Uint8Array(16); // dummy

  // PADDING block: type=1, last (0x81), body=8
  const paddingHeader = new Uint8Array([0x81, 0x00, 0x00, 0x08]);
  const paddingBody = new Uint8Array(8);

  const audio = new Uint8Array([0xff, 0xf8, 0xaa, 0xbb]);

  const parts = [
    magic, streamInfoHeader, streamInfoBody,
    oldVorbisHeader, oldVorbisBody,
    paddingHeader, paddingBody,
    audio,
  ];

  let total = 0;
  for (const p of parts) total += p.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

function readUint32LE(data: Uint8Array, offset: number): number {
  return (
    data[offset] |
    (data[offset + 1] << 8) |
    (data[offset + 2] << 16) |
    ((data[offset + 3] << 24) >>> 0)
  ) >>> 0;
}

function readUint32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>> 0
  );
}

/** Parse Vorbis Comment fields from a VORBIS_COMMENT block body */
function parseVorbisComments(body: Uint8Array): { vendor: string; comments: string[] } {
  let offset = 0;
  const vendorLen = readUint32LE(body, offset);
  offset += 4;
  const vendor = new TextDecoder().decode(body.slice(offset, offset + vendorLen));
  offset += vendorLen;

  const commentCount = readUint32LE(body, offset);
  offset += 4;

  const comments: string[] = [];
  for (let i = 0; i < commentCount; i++) {
    const len = readUint32LE(body, offset);
    offset += 4;
    const comment = new TextDecoder().decode(body.slice(offset, offset + len));
    comments.push(comment);
    offset += len;
  }

  return { vendor, comments };
}

/** Parse metadata blocks from a FLAC file */
function parseFlacBlocks(data: Uint8Array): Array<{ type: number; body: Uint8Array; isLast: boolean }> {
  const blocks: Array<{ type: number; body: Uint8Array; isLast: boolean }> = [];
  let offset = 4; // skip magic

  while (offset < data.length) {
    const headerByte = data[offset];
    const isLast = (headerByte & 0x80) !== 0;
    const blockType = headerByte & 0x7f;
    const bodyLength = (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
    offset += 4;
    const body = data.slice(offset, offset + bodyLength);
    blocks.push({ type: blockType, body, isLast });
    offset += bodyLength;
    if (isLast) break;
  }

  return blocks;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("embedFlacMetadata", () => {
  it("should throw on invalid input (too short)", () => {
    expect(() => embedFlacMetadata(new Uint8Array(4), {})).toThrow("too short");
  });

  it("should throw on missing fLaC magic", () => {
    const bad = new Uint8Array(100);
    bad[0] = 0x49; // "I" instead of "f"
    expect(() => embedFlacMetadata(bad, {})).toThrow("missing fLaC magic");
  });

  it("should embed text metadata fields into a minimal FLAC file", () => {
    const flac = buildMinimalFlac();
    const meta: FlacMeta = {
      title: "Test Song",
      artist: "Test Artist",
      album: "Test Album",
      year: "2024",
      trackNumber: "5",
    };

    const result = embedFlacMetadata(flac, meta);

    // Verify magic
    expect(result[0]).toBe(0x66); // 'f'
    expect(result[1]).toBe(0x4c); // 'L'
    expect(result[2]).toBe(0x61); // 'a'
    expect(result[3]).toBe(0x43); // 'C'

    // Parse blocks
    const blocks = parseFlacBlocks(result);

    // First block should be STREAMINFO
    expect(blocks[0].type).toBe(0);
    expect(blocks[0].body.length).toBe(34);

    // Second block should be VORBIS_COMMENT
    expect(blocks[1].type).toBe(4);

    // Parse vorbis comments
    const { vendor, comments } = parseVorbisComments(blocks[1].body);
    expect(vendor).toBe("YMus");
    expect(comments).toContain("TITLE=Test Song");
    expect(comments).toContain("ARTIST=Test Artist");
    expect(comments).toContain("ALBUM=Test Album");
    expect(comments).toContain("DATE=2024");
    expect(comments).toContain("TRACKNUMBER=5");

    // Last block should have last-block flag set
    expect(blocks[blocks.length - 1].isLast).toBe(true);
  });

  it("should embed cover art as PICTURE block", () => {
    const flac = buildMinimalFlac();
    const coverData = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03]);
    const meta: FlacMeta = {
      title: "Song",
      cover: { bytes: coverData, mime: "image/jpeg" },
    };

    const result = embedFlacMetadata(flac, meta);
    const blocks = parseFlacBlocks(result);

    // Should have STREAMINFO, VORBIS_COMMENT, PICTURE
    expect(blocks[0].type).toBe(0); // STREAMINFO
    expect(blocks[1].type).toBe(4); // VORBIS_COMMENT
    expect(blocks[2].type).toBe(6); // PICTURE

    // Verify PICTURE block content
    const pictureBody = blocks[2].body;
    // Picture type = 3 (front cover)
    expect(readUint32BE(pictureBody, 0)).toBe(3);
    // MIME type
    const mimeLen = readUint32BE(pictureBody, 4);
    expect(mimeLen).toBe(10); // "image/jpeg".length
    const mimeStr = new TextDecoder().decode(pictureBody.slice(8, 8 + mimeLen));
    expect(mimeStr).toBe("image/jpeg");

    // Picture data at the end
    const dataOffset = 8 + mimeLen + 4 + 4 + 4 + 4 + 4 + 4; // after mime + desc(0) + w + h + depth + colors + dataLen
    const dataLen = readUint32BE(pictureBody, dataOffset - 4);
    expect(dataLen).toBe(coverData.length);
    const extractedCover = pictureBody.slice(dataOffset, dataOffset + dataLen);
    expect(extractedCover).toEqual(coverData);
  });

  it("should handle empty metadata gracefully", () => {
    const flac = buildMinimalFlac();
    const meta: FlacMeta = {};

    const result = embedFlacMetadata(flac, meta);
    const blocks = parseFlacBlocks(result);

    // Should still have STREAMINFO + VORBIS_COMMENT (with 0 comments)
    expect(blocks[0].type).toBe(0);
    expect(blocks[1].type).toBe(4);

    const { comments } = parseVorbisComments(blocks[1].body);
    expect(comments.length).toBe(0);
  });

  it("should handle undefined and empty string fields", () => {
    const flac = buildMinimalFlac();
    const meta: FlacMeta = {
      title: "",
      artist: undefined,
      album: "Album",
      year: "",
      trackNumber: undefined,
    };

    const result = embedFlacMetadata(flac, meta);
    const blocks = parseFlacBlocks(result);
    const { comments } = parseVorbisComments(blocks[1].body);

    // Only non-empty fields should be included
    expect(comments.length).toBe(1);
    expect(comments).toContain("ALBUM=Album");
  });

  it("should replace existing VORBIS_COMMENT and PICTURE blocks", () => {
    const flac = buildFlacWithExistingBlocks();
    const meta: FlacMeta = {
      title: "New Title",
      artist: "New Artist",
    };

    const result = embedFlacMetadata(flac, meta);
    const blocks = parseFlacBlocks(result);

    // Should have: STREAMINFO, VORBIS_COMMENT, PADDING (preserved)
    const types = blocks.map((b) => b.type);
    expect(types[0]).toBe(0); // STREAMINFO
    expect(types[1]).toBe(4); // VORBIS_COMMENT (new)
    expect(types[2]).toBe(1); // PADDING (preserved)

    // No old VORBIS_COMMENT should remain (only one type=4 block)
    const vorbisBlocks = blocks.filter((b) => b.type === 4);
    expect(vorbisBlocks.length).toBe(1);

    const { comments } = parseVorbisComments(vorbisBlocks[0].body);
    expect(comments).toContain("TITLE=New Title");
    expect(comments).toContain("ARTIST=New Artist");
  });

  it("should preserve audio frames unchanged", () => {
    const audioData = new Uint8Array([0xff, 0xf8, 0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);
    const flac = buildMinimalFlac(audioData);
    const meta: FlacMeta = { title: "Test" };

    const result = embedFlacMetadata(flac, meta);

    // Audio frames should be at the end of the file
    const audioInResult = result.slice(result.length - audioData.length);
    expect(audioInResult).toEqual(audioData);
  });

  it("should handle PNG cover art", () => {
    const flac = buildMinimalFlac();
    const pngData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const meta: FlacMeta = {
      cover: { bytes: pngData, mime: "image/png" },
    };

    const result = embedFlacMetadata(flac, meta);
    const blocks = parseFlacBlocks(result);

    const pictureBlock = blocks.find((b) => b.type === 6);
    expect(pictureBlock).toBeDefined();

    // Verify MIME is "image/png"
    const mimeLen = readUint32BE(pictureBlock!.body, 4);
    const mimeStr = new TextDecoder().decode(pictureBlock!.body.slice(8, 8 + mimeLen));
    expect(mimeStr).toBe("image/png");
  });

  it("should produce a valid FLAC structure with correct last-block flags", () => {
    const flac = buildMinimalFlac();
    const meta: FlacMeta = {
      title: "Song",
      cover: { bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" },
    };

    const result = embedFlacMetadata(flac, meta);
    const blocks = parseFlacBlocks(result);

    // Only the last block should have isLast=true
    for (let i = 0; i < blocks.length - 1; i++) {
      expect(blocks[i].isLast).toBe(false);
    }
    expect(blocks[blocks.length - 1].isLast).toBe(true);
  });
});
