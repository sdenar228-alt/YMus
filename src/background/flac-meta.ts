// FLAC metadata writer — embeds Vorbis Comments and optional PICTURE block
// into a FLAC file stream.
//
// FLAC structure:
//   "fLaC" (4 bytes magic)
//   METADATA_BLOCK* (each: 4-byte header + body)
//   AUDIO_FRAMES
//
// Metadata block header (4 bytes):
//   bit 0:     last-metadata-block flag
//   bits 1-7:  block type (0=STREAMINFO, 4=VORBIS_COMMENT, 6=PICTURE)
//   bits 8-31: body length in bytes (24-bit big-endian)
//
// We insert VORBIS_COMMENT and PICTURE blocks after STREAMINFO,
// removing any existing VORBIS_COMMENT or PICTURE blocks.

export interface FlacMeta {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  trackNumber?: string;
  cover?: { bytes: Uint8Array; mime: "image/jpeg" | "image/png" };
}

const FLAC_MAGIC = 0x664c6143; // "fLaC"
const BLOCK_TYPE_STREAMINFO = 0;
const BLOCK_TYPE_VORBIS_COMMENT = 4;
const BLOCK_TYPE_PICTURE = 6;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readUint32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function encodeUtf8(s: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(s);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ─── Vorbis Comment block builder ─────────────────────────────────────────────

/**
 * Build a VORBIS_COMMENT metadata block body.
 * Format:
 *   [4 bytes LE] vendor string length
 *   [N bytes]    vendor string (UTF-8)
 *   [4 bytes LE] number of comments
 *   For each comment:
 *     [4 bytes LE] comment length
 *     [N bytes]    comment string "FIELD=value" (UTF-8)
 */
function buildVorbisCommentBody(meta: FlacMeta): Uint8Array {
  const vendor = encodeUtf8("YMus");
  const comments: Uint8Array[] = [];

  const fields: Array<[string, string | undefined]> = [
    ["TITLE", meta.title],
    ["ARTIST", meta.artist],
    ["ALBUM", meta.album],
    ["DATE", meta.year],
    ["TRACKNUMBER", meta.trackNumber],
  ];

  for (const [key, value] of fields) {
    if (value !== undefined && value.length > 0) {
      comments.push(encodeUtf8(`${key}=${value}`));
    }
  }

  // Calculate total size
  let size = 4 + vendor.length + 4; // vendor length + vendor + comment count
  for (const c of comments) {
    size += 4 + c.length; // length prefix + comment bytes
  }

  const body = new Uint8Array(size);
  let offset = 0;

  // Vendor string length (LE)
  writeUint32LE(body, offset, vendor.length);
  offset += 4;

  // Vendor string
  body.set(vendor, offset);
  offset += vendor.length;

  // Number of comments (LE)
  writeUint32LE(body, offset, comments.length);
  offset += 4;

  // Each comment
  for (const c of comments) {
    writeUint32LE(body, offset, c.length);
    offset += 4;
    body.set(c, offset);
    offset += c.length;
  }

  return body;
}

// ─── PICTURE block builder ────────────────────────────────────────────────────

/**
 * Build a PICTURE metadata block body (type 6).
 * Format:
 *   [4 bytes BE] picture type (3 = front cover)
 *   [4 bytes BE] MIME string length
 *   [N bytes]    MIME string (ASCII)
 *   [4 bytes BE] description length
 *   [N bytes]    description (UTF-8, empty)
 *   [4 bytes BE] width (0 = unknown)
 *   [4 bytes BE] height (0 = unknown)
 *   [4 bytes BE] color depth (0 = unknown)
 *   [4 bytes BE] number of colors for indexed (0)
 *   [4 bytes BE] picture data length
 *   [N bytes]    picture data
 */
function buildPictureBody(
  imageBytes: Uint8Array,
  mime: "image/jpeg" | "image/png",
): Uint8Array {
  const mimeBytes = encodeUtf8(mime);
  const size =
    4 + // picture type
    4 +
    mimeBytes.length + // MIME
    4 + // description length (0)
    4 + // width
    4 + // height
    4 + // color depth
    4 + // number of colors
    4 +
    imageBytes.length; // picture data

  const body = new Uint8Array(size);
  let offset = 0;

  // Picture type: 3 = front cover
  writeUint32BE(body, offset, 3);
  offset += 4;

  // MIME type
  writeUint32BE(body, offset, mimeBytes.length);
  offset += 4;
  body.set(mimeBytes, offset);
  offset += mimeBytes.length;

  // Description (empty)
  writeUint32BE(body, offset, 0);
  offset += 4;

  // Width, height, color depth, number of colors (all 0 = unknown)
  writeUint32BE(body, offset, 0);
  offset += 4;
  writeUint32BE(body, offset, 0);
  offset += 4;
  writeUint32BE(body, offset, 0);
  offset += 4;
  writeUint32BE(body, offset, 0);
  offset += 4;

  // Picture data
  writeUint32BE(body, offset, imageBytes.length);
  offset += 4;
  body.set(imageBytes, offset);

  return body;
}

// ─── Metadata block header builder ────────────────────────────────────────────

/**
 * Build a 4-byte metadata block header.
 * Bit 0 of first byte: last-metadata-block flag
 * Bits 1-7 of first byte: block type
 * Bytes 1-3: body length (24-bit big-endian)
 */
function buildBlockHeader(
  type: number,
  bodyLength: number,
  isLast: boolean,
): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = (isLast ? 0x80 : 0x00) | (type & 0x7f);
  header[1] = (bodyLength >>> 16) & 0xff;
  header[2] = (bodyLength >>> 8) & 0xff;
  header[3] = bodyLength & 0xff;
  return header;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Embed Vorbis Comments and optional PICTURE block into a FLAC file.
 * Returns a new Uint8Array with metadata inserted after STREAMINFO.
 *
 * Strategy:
 * 1. Verify "fLaC" magic.
 * 2. Parse all existing metadata blocks.
 * 3. Keep STREAMINFO and any blocks that are NOT VORBIS_COMMENT or PICTURE.
 * 4. Insert our new VORBIS_COMMENT and PICTURE blocks after STREAMINFO.
 * 5. Reassemble: magic + blocks + audio frames.
 */
export function embedFlacMetadata(
  flacBytes: Uint8Array,
  meta: FlacMeta,
): Uint8Array {
  if (flacBytes.length < 8) {
    throw new Error("Invalid FLAC file: too short");
  }

  // Verify magic
  const magic = readUint32BE(flacBytes, 0);
  if (magic !== FLAC_MAGIC) {
    throw new Error("Invalid FLAC file: missing fLaC magic");
  }

  // Parse existing metadata blocks
  interface MetadataBlock {
    type: number;
    body: Uint8Array;
  }

  const blocks: MetadataBlock[] = [];
  let offset = 4; // skip magic

  while (offset < flacBytes.length) {
    if (offset + 4 > flacBytes.length) {
      throw new Error("Invalid FLAC file: truncated metadata block header");
    }

    const headerByte = flacBytes[offset];
    const isLast = (headerByte & 0x80) !== 0;
    const blockType = headerByte & 0x7f;
    const bodyLength =
      (flacBytes[offset + 1] << 16) |
      (flacBytes[offset + 2] << 8) |
      flacBytes[offset + 3];

    offset += 4; // skip header

    if (offset + bodyLength > flacBytes.length) {
      throw new Error("Invalid FLAC file: truncated metadata block body");
    }

    const body = flacBytes.slice(offset, offset + bodyLength);
    blocks.push({ type: blockType, body });
    offset += bodyLength;

    if (isLast) break;
  }

  // Audio frames start at current offset
  const audioFrames = flacBytes.slice(offset);

  // Separate STREAMINFO from other blocks, removing old VORBIS_COMMENT and PICTURE
  const streamInfoBlock = blocks.find(
    (b) => b.type === BLOCK_TYPE_STREAMINFO,
  );
  if (!streamInfoBlock) {
    throw new Error("Invalid FLAC file: no STREAMINFO block found");
  }

  // Keep blocks that are not STREAMINFO, VORBIS_COMMENT, or PICTURE
  const preservedBlocks = blocks.filter(
    (b) =>
      b.type !== BLOCK_TYPE_STREAMINFO &&
      b.type !== BLOCK_TYPE_VORBIS_COMMENT &&
      b.type !== BLOCK_TYPE_PICTURE,
  );

  // Build new metadata blocks
  const newBlocks: MetadataBlock[] = [];

  // VORBIS_COMMENT is always inserted (even if all fields are empty, it's valid)
  const vorbisBody = buildVorbisCommentBody(meta);
  newBlocks.push({ type: BLOCK_TYPE_VORBIS_COMMENT, body: vorbisBody });

  // PICTURE block only if cover art is provided
  if (meta.cover) {
    const pictureBody = buildPictureBody(meta.cover.bytes, meta.cover.mime);
    newBlocks.push({ type: BLOCK_TYPE_PICTURE, body: pictureBody });
  }

  // Assemble final block list: STREAMINFO + new blocks + preserved blocks
  const allBlocks: MetadataBlock[] = [
    streamInfoBlock,
    ...newBlocks,
    ...preservedBlocks,
  ];

  // Build output
  const parts: Uint8Array[] = [];

  // Magic
  parts.push(new Uint8Array([0x66, 0x4c, 0x61, 0x43])); // "fLaC"

  // Metadata blocks with proper last-block flags
  for (let i = 0; i < allBlocks.length; i++) {
    const block = allBlocks[i];
    const isLast = i === allBlocks.length - 1;
    const header = buildBlockHeader(block.type, block.body.length, isLast);
    parts.push(header);
    parts.push(block.body);
  }

  // Audio frames
  parts.push(audioFrames);

  return concatBytes(parts);
}
