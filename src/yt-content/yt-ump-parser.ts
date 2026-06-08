/**
 * Pure UMP / Proto-varint parser primitives used by the YouTube page bridge.
 *
 * Extracted out of `yt-page-bridge.ts` so the parsing logic is reachable from
 * tests without booting the MAIN-world bridge IIFE.  The bridge re-imports
 * these symbols and uses them verbatim — no behavior change.
 *
 * UMP framing reference:
 *   - 1–5 byte length prefix encoded in the high bits of the first byte
 *     (similar to UTF-8). See `readVarInt` for the bit pattern.
 *   - Frame `type` is a UMP varint, `size` is a UMP varint, payload is `size`
 *     bytes.
 *   - Type 20 (header) carries an iTag inside a Protocol Buffers message; the
 *     iTag is field number 3.
 *   - Type 21 (media) carries a single header byte followed by raw media
 *     bytes.  When the current iTag is in `AUDIO_ITAGS`, those bytes are
 *     captured.
 *   - Matroska EBML magic `1A 45 DF A3` at the start of a media payload
 *     signals the WebM/Opus init segment, which is stored separately so the
 *     bridge can prepend it before sending captured audio back to the
 *     content script.
 */

/** Per-iTag accumulator for one videoId. */
export interface AudioStream {
  itag: number;
  initSegment: Uint8Array | null;
  chunks: Uint8Array[];
  totalSize: number;
}

/**
 * Audio iTags handled by the bridge.
 *   AAC (m4a):  140, 141, 256, 258, 327, 328
 *   Opus (webm): 249, 250, 251
 */
export const AUDIO_ITAGS: ReadonlySet<number> = new Set<number>([
  140, // m4a AAC 128kbps
  141, // m4a AAC 256kbps
  249, // opus 50kbps
  250, // opus 70kbps
  251, // opus 160kbps
  256, // m4a AAC 192kbps (surround)
  258, // m4a AAC 384kbps (surround)
  327, // m4a AAC (surround)
  328, // m4a EAC3 (surround)
]);

/**
 * Video iTags handled by the bridge — adaptive video-only streams that the
 * legacy YouTube downloader supported. Codec families:
 *   - H.264 (mp4):  135 (480p), 136 (720p), 137 (1080p)
 *   - VP9   (webm): 244 (480p), 247 (720p), 248 (1080p), 271 (1440p), 313 (2160p)
 *   - AV1   (mp4):  397 (480p), 398 (720p), 399 (1080p), 400 (1440p), 401 (2160p)
 *
 * The same UMP framing logic captures audio AND video — the only difference
 * is the iTag membership check. The init segment for video streams is
 * Matroska EBML (`1A 45 DF A3`) for VP9 and ISO BMFF `ftyp` for H.264/AV1
 * (we only special-case EBML for parity with the audio path; H.264/AV1
 * init segments fall into `chunks` and the muxer reads them from there).
 */
export const VIDEO_ITAGS: ReadonlySet<number> = new Set<number>([
  // H.264 (mp4)
  135, 136, 137,
  // VP9 (webm)
  244, 247, 248, 271, 313,
  // AV1 (mp4)
  397, 398, 399, 400, 401,
]);

/**
 * Combined membership test — UMP frame parser captures bytes whenever the
 * current iTag falls into either set.
 */
export function isCaptureItag(itag: number): boolean {
  return AUDIO_ITAGS.has(itag) || VIDEO_ITAGS.has(itag);
}

/**
 * Read a UMP varint at the given offset. UMP uses a 1–5 byte length prefix
 * encoded in the high bits of the first byte (similar to UTF-8).
 *
 * @returns `[value, bytesConsumed]`. `[0, 0]` when the buffer is truncated
 * mid-varint. `[0, 1]` when the first byte's high bits are illegal — the
 * caller advances 1 byte and keeps walking instead of throwing.
 */
export function readVarInt(buf: Uint8Array, offset: number): [number, number] {
  if (offset >= buf.byteLength) return [0, 0];
  const b = buf[offset];
  let size: number;
  if ((b & 0x80) === 0) size = 1;
  else if ((b & 0xc0) === 0x80) size = 2;
  else if ((b & 0xe0) === 0xc0) size = 3;
  else if ((b & 0xf0) === 0xe0) size = 4;
  else if ((b & 0xf8) === 0xf0) size = 5;
  else return [0, 1];
  if (offset + size > buf.byteLength) return [0, 0];
  switch (size) {
    case 1:
      return [b & 0x7f, 1];
    case 2:
      return [(buf[offset + 1] << 6) | (b & 0x3f), 2];
    case 3:
      return [((buf[offset + 1] | (buf[offset + 2] << 8)) << 5) | (b & 0x1f), 3];
    case 4:
      return [
        ((buf[offset + 1] | (buf[offset + 2] << 8) | (buf[offset + 3] << 16)) << 4) | (b & 0x0f),
        4,
      ];
    case 5: {
      const lo =
        ((buf[offset + 1] |
          (buf[offset + 2] << 8) |
          (buf[offset + 3] << 16) |
          ((buf[offset + 4] << 24) >>> 0)) >>>
          0) *
          8 +
        (b & 0x07);
      return [lo >>> 0, 5];
    }
    default:
      return [0, 1];
  }
}

/**
 * Read a Protocol Buffers varint (7-bit continuation). Capped at 5 bytes
 * (35-bit shift) to match the legacy parser exactly.
 *
 * @returns `[value, newOffset]`.
 */
export function readProtoVarInt(buf: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (offset < buf.byteLength) {
    const b = buf[offset++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) break;
  }
  return [result >>> 0, offset];
}

/**
 * Walk the proto fields inside a UMP type-20 frame and return the value of
 * field number 3 (the iTag). Supports wire types 0 (varint), 1 (8-byte
 * fixed), 2 (length-delimited), and 5 (4-byte fixed). Anything else breaks
 * the walk — the bridge then keeps `currentItag` from the prior frame.
 *
 * @returns The iTag, or 0 if field 3 is not present.
 */
export function extractItagFromPart20(buf: Uint8Array, start: number, end: number): number {
  let offset = start;
  while (offset < end) {
    const [tag, newOff] = readProtoVarInt(buf, offset);
    offset = newOff;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      const [val, off2] = readProtoVarInt(buf, offset);
      if (fieldNum === 3) return val;
      offset = off2;
    } else if (wireType === 2) {
      const [len, off2] = readProtoVarInt(buf, offset);
      offset = off2 + len;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      break;
    }
    if (offset > end) break;
  }
  return 0;
}

/**
 * Walk a `videoplayback` UMP response and accumulate audio AND video media
 * payloads into the supplied stream map.
 *
 * - Type 20 frames carry the iTag (size > 2 required).
 * - Type 21 frames carry media bytes (size > 1 required, AND the current
 *   iTag must be in `AUDIO_ITAGS` OR `VIDEO_ITAGS`). The first byte of a
 *   type-21 payload is a header tag the parser skips, so the actual bytes
 *   start at `offset + 1`.
 * - The Matroska EBML magic (`1A 45 DF A3`) marks the WebM/Opus/VP9 init
 *   segment, which is stored separately and prepended on
 *   `GET_MEDIA_BUFFER`.
 *
 * The same accumulator map holds both audio and video streams keyed by
 * iTag — the consumer (handleGetMediaBuffer) splits them by membership in
 * `AUDIO_ITAGS` vs `VIDEO_ITAGS` when serving.
 */
export function parseUmpResponse(buf: Uint8Array, audioStreams: Map<number, AudioStream>): void {
  let offset = 0;
  let currentItag = 0;
  while (offset < buf.byteLength - 1) {
    const [type, typeBytes] = readVarInt(buf, offset);
    // Defensive: UMP frame types stay below 200; bail on garbage rather
    // than throwing. Same contract as legacy.
    if (type > 200 || typeBytes === 0) break;
    offset += typeBytes;
    if (offset >= buf.byteLength) break;
    const [size, sizeBytes] = readVarInt(buf, offset);
    offset += sizeBytes;
    const remaining = buf.byteLength - offset;
    const actualSize = Math.min(size, remaining);

    if (type === 20 && actualSize > 2) {
      currentItag = extractItagFromPart20(buf, offset, offset + actualSize);
    } else if (type === 21 && actualSize > 1) {
      // Capture both audio and video iTags into the same per-iTag map.
      // The bridge's GET_MEDIA_BUFFER handler picks the best audio + best
      // video stream from this combined accumulator.
      if (isCaptureItag(currentItag)) {
        const dataStart = offset + 1;
        const dataLen = actualSize - 1;
        if (dataLen > 0) {
          let stream = audioStreams.get(currentItag);
          if (!stream) {
            stream = { itag: currentItag, initSegment: null, chunks: [], totalSize: 0 };
            audioStreams.set(currentItag, stream);
          }
          // Copy bytes out of the response buffer so it can be GC'd.
          const mediaData = new Uint8Array(buf.subarray(dataStart, dataStart + dataLen));
          // Detect init segments. YouTube ships two container families:
          //   - WebM (VP9/Opus/AV1-in-webm): init starts with EBML magic
          //     `1A 45 DF A3`.
          //   - ISOBMFF (AAC/H.264/AV1-in-mp4): init starts with `ftyp`
          //     box (`....ftyp` — bytes 4..7 are the type code).
          // Either way the init segment goes into `initSegment` so the
          // muxer / fragment sorter can find it.
          const isEbmlInit =
            mediaData.length > 4 &&
            mediaData[0] === 0x1a &&
            mediaData[1] === 0x45 &&
            mediaData[2] === 0xdf &&
            mediaData[3] === 0xa3;
          const isFtypInit =
            mediaData.length > 8 &&
            mediaData[4] === 0x66 && // 'f'
            mediaData[5] === 0x74 && // 't'
            mediaData[6] === 0x79 && // 'y'
            mediaData[7] === 0x70;   // 'p'
          if (!stream.initSegment && (isEbmlInit || isFtypInit)) {
            stream.initSegment = mediaData;
          } else {
            stream.chunks.push(mediaData);
            stream.totalSize += mediaData.byteLength;
          }
        }
      }
    }
    offset += actualSize;
    // Truncated payload — stop walking rather than reading garbage.
    if (size > remaining) break;
  }
}


/**
 * Parse a single UMP response and return per-iTag byte slices WITHOUT
 * accumulating into a long-lived `AudioStream` map.
 *
 * Used by the bridge to keep each `videoplayback` response as a
 * separate ordered chunk — sorting chunks by their HTTP `range=START`
 * later reconstructs the original byte sequence regardless of which
 * order YouTube actually delivered them.
 *
 * Returns ONE entry per iTag per response. YouTube SABR nests multiple
 * type-21 frames for the same iTag inside a single HTTP response — those
 * are 32 KB slices of ONE Cluster, NOT separate self-contained WebM files.
 * We concatenate all type-21 payloads for the same iTag back into a single
 * buffer so the downstream strip/flatten logic receives a complete Cluster
 * (or a complete self-contained WebM file with EBML header + Segment +
 * Cluster). Without this concatenation, each 32 KB slice would be passed
 * individually to `stripWebmHeaderToClusters` which cannot handle bare
 * partial-Cluster bytes (no EBML header, no Cluster ID at the start).
 */
export function parseUmpResponseSeparated(
  buf: Uint8Array,
): Array<{ itag: number; bytes: Uint8Array; isInit: boolean }> {
  // First pass: collect raw byte slices grouped by iTag.
  const perItag = new Map<number, Uint8Array[]>();
  let offset = 0;
  let currentItag = 0;
  while (offset < buf.byteLength - 1) {
    const [type, typeBytes] = readVarInt(buf, offset);
    if (type > 200 || typeBytes === 0) break;
    offset += typeBytes;
    if (offset >= buf.byteLength) break;
    const [size, sizeBytes] = readVarInt(buf, offset);
    offset += sizeBytes;
    const remaining = buf.byteLength - offset;
    const actualSize = Math.min(size, remaining);
    if (type === 20 && actualSize > 2) {
      currentItag = extractItagFromPart20(buf, offset, offset + actualSize);
    } else if (type === 21 && actualSize > 1) {
      if (isCaptureItag(currentItag)) {
        const dataStart = offset + 1;
        const dataLen = actualSize - 1;
        if (dataLen > 0) {
          const mediaData = new Uint8Array(buf.subarray(dataStart, dataStart + dataLen));
          let arr = perItag.get(currentItag);
          if (!arr) {
            arr = [];
            perItag.set(currentItag, arr);
          }
          arr.push(mediaData);
        }
      }
    }
    offset += actualSize;
    if (size > remaining) break;
  }

  // Second pass: merge slices per iTag into one buffer and classify.
  const result: Array<{ itag: number; bytes: Uint8Array; isInit: boolean }> = [];
  for (const [itag, slices] of perItag) {
    let merged: Uint8Array;
    if (slices.length === 1) {
      merged = slices[0];
    } else {
      let total = 0;
      for (const s of slices) total += s.byteLength;
      merged = new Uint8Array(total);
      let pos = 0;
      for (const s of slices) {
        merged.set(s, pos);
        pos += s.byteLength;
      }
    }
    // Detect init segment via EBML magic OR ftyp box signature.
    const isEbmlInit =
      merged.length > 4 &&
      merged[0] === 0x1a &&
      merged[1] === 0x45 &&
      merged[2] === 0xdf &&
      merged[3] === 0xa3;
    const isFtypInit =
      merged.length > 8 &&
      merged[4] === 0x66 &&
      merged[5] === 0x74 &&
      merged[6] === 0x79 &&
      merged[7] === 0x70;
    result.push({
      itag,
      bytes: merged,
      isInit: isEbmlInit || isFtypInit,
    });
  }
  return result;
}


/**
 * Read the minimum container-level timestamp from a captured fragment.
 *
 *   - WebM (EBML magic at byte 0): walks Segment children, finds the
 *     first Cluster element, reads its Timestamp child (ID 0xE7).
 *   - ISOBMFF (`ftyp` at byte 4): walks top-level boxes, finds the
 *     first `moof`, descends `moof > traf > tfdt`, reads
 *     baseMediaDecodeTime (32-bit or 64-bit per FullBox version).
 *
 * Returns -1 when no timestamp can be determined (init-only chunks,
 * malformed bytes, etc.). The caller treats -1 as "sort first, before
 * any media chunk".
 *
 * Lives in the parser module so the bridge IIFE doesn't need a separate
 * dependency on the offscreen muxer's sorter.
 */
export function readMinTimestamp(bytes: Uint8Array): number {
  if (bytes.byteLength < 8) return -1;
  // ─── WebM ───
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return readWebmFirstClusterTimestamp(bytes);
  }
  // ─── ISOBMFF ───
  if (
    bytes.byteLength > 8 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return readIsobmffFirstMoofTime(bytes);
  }
  // Bare moof (no init prefix in this fragment) — common for media-only
  // chunks coming after the init was delivered separately.
  if (
    bytes.byteLength > 8 &&
    bytes[4] === 0x6d && // 'm'
    bytes[5] === 0x6f && // 'o'
    bytes[6] === 0x6f && // 'o'
    bytes[7] === 0x66    // 'f'
  ) {
    return readIsobmffFirstMoofTime(bytes);
  }
  // Bare Cluster (EBML Cluster ID 1F 43 B6 75) without init prefix.
  if (
    bytes.byteLength > 4 &&
    bytes[0] === 0x1f &&
    bytes[1] === 0x43 &&
    bytes[2] === 0xb6 &&
    bytes[3] === 0x75
  ) {
    return readWebmBareClusterTimestamp(bytes);
  }
  return -1;
}

/**
 * Parse a Matroska EBML stream and find the first Cluster's Timestamp.
 * Returns -1 on parse error.
 */
function readWebmFirstClusterTimestamp(buf: Uint8Array): number {
  const EBML_HEADER = 0x1a45dfa3;
  const SEGMENT = 0x18538067;
  const CLUSTER = 0x1f43b675;
  const TIMESTAMP = 0xe7;

  let pos = 0;
  let segChildrenStart = -1;
  let segEnd = -1;
  while (pos < buf.byteLength) {
    const id = readEbmlId(buf, pos);
    if (!id) return -1;
    pos += id.size;
    const sz = readEbmlSize(buf, pos);
    if (!sz) return -1;
    pos += sz.consumed;
    if (id.id === EBML_HEADER) {
      if (sz.size < 0) return -1;
      pos += sz.size;
    } else if (id.id === SEGMENT) {
      segChildrenStart = pos;
      segEnd = sz.size < 0 ? buf.byteLength : pos + sz.size;
      if (segEnd > buf.byteLength) segEnd = buf.byteLength;
      break;
    } else {
      if (sz.size < 0) return -1;
      pos += sz.size;
    }
  }
  if (segChildrenStart === -1) return -1;
  // Walk Segment children for first Cluster.
  let cursor = segChildrenStart;
  while (cursor < segEnd) {
    const id = readEbmlId(buf, cursor);
    if (!id) return -1;
    cursor += id.size;
    const sz = readEbmlSize(buf, cursor);
    if (!sz) return -1;
    cursor += sz.consumed;
    if (id.id === CLUSTER) {
      const cend = sz.size < 0 ? segEnd : cursor + sz.size;
      return readClusterTimestampField(buf, cursor, cend, TIMESTAMP);
    }
    if (sz.size < 0) return -1;
    cursor += sz.size;
  }
  return -1;
}

function readWebmBareClusterTimestamp(buf: Uint8Array): number {
  // We are positioned at the Cluster ID. Skip 4-byte ID + size varint.
  let pos = 4;
  const sz = readEbmlSize(buf, pos);
  if (!sz) return -1;
  pos += sz.consumed;
  const cend = sz.size < 0 ? buf.byteLength : Math.min(pos + sz.size, buf.byteLength);
  return readClusterTimestampField(buf, pos, cend, 0xe7);
}

function readClusterTimestampField(
  buf: Uint8Array,
  childrenStart: number,
  clusterEnd: number,
  timestampId: number,
): number {
  let pos = childrenStart;
  while (pos < clusterEnd) {
    const id = readEbmlId(buf, pos);
    if (!id) return -1;
    pos += id.size;
    const sz = readEbmlSize(buf, pos);
    if (!sz) return -1;
    pos += sz.consumed;
    if (id.id === timestampId) {
      const len = sz.size;
      if (len < 1 || len > 8 || pos + len > buf.byteLength) return -1;
      let result = 0;
      for (let i = 0; i < len; i++) result = result * 256 + buf[pos + i];
      return result;
    }
    if (sz.size < 0) return -1;
    pos += sz.size;
  }
  return -1;
}

function readEbmlId(buf: Uint8Array, offset: number): { id: number; size: number } | null {
  if (offset >= buf.byteLength) return null;
  const b = buf[offset];
  if (b === 0) return null;
  let size: number;
  if (b & 0x80) size = 1;
  else if (b & 0x40) size = 2;
  else if (b & 0x20) size = 3;
  else if (b & 0x10) size = 4;
  else return null;
  if (offset + size > buf.byteLength) return null;
  let id = 0;
  for (let i = 0; i < size; i++) id = id * 256 + buf[offset + i];
  return { id, size };
}

function readEbmlSize(buf: Uint8Array, offset: number): { size: number; consumed: number } | null {
  if (offset >= buf.byteLength) return null;
  const first = buf[offset];
  if (first === 0) return null;
  let consumed = 0;
  let mask = 0x80;
  while (mask > 0) {
    consumed++;
    if (first & mask) break;
    mask >>= 1;
  }
  if (consumed > 8 || offset + consumed > buf.byteLength) return null;
  let size = first & (mask - 1);
  for (let i = 1; i < consumed; i++) size = size * 256 + buf[offset + i];
  let isUnknown = (first & (mask - 1)) === mask - 1;
  if (isUnknown) {
    for (let i = 1; i < consumed; i++) {
      if (buf[offset + i] !== 0xff) { isUnknown = false; break; }
    }
  }
  return isUnknown ? { size: -1, consumed } : { size, consumed };
}

/**
 * Read first moof's tfdt.baseMediaDecodeTime in ISOBMFF stream.
 */
function readIsobmffFirstMoofTime(buf: Uint8Array): number {
  let pos = 0;
  while (pos < buf.byteLength) {
    const box = readBoxHeader(buf, pos);
    if (!box) return -1;
    if (box.type === "moof") {
      return readMoofBaseDecodeTime(buf, pos, box.size);
    }
    pos += box.size;
  }
  return -1;
}

export function readBoxHeader(buf: Uint8Array, offset: number): { size: number; type: string; headerSize: number } | null {
  if (offset + 8 > buf.byteLength) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let size = view.getUint32(offset, false);
  const type = String.fromCharCode(buf[offset + 4], buf[offset + 5], buf[offset + 6], buf[offset + 7]);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > buf.byteLength) return null;
    const hi = view.getUint32(offset + 8, false);
    const lo = view.getUint32(offset + 12, false);
    size = hi * 0x1_0000_0000 + lo;
    headerSize = 16;
  } else if (size === 0) {
    size = buf.byteLength - offset;
  }
  if (size < headerSize || offset + size > buf.byteLength) return null;
  return { size, type, headerSize };
}

function readMoofBaseDecodeTime(buf: Uint8Array, moofStart: number, moofSize: number): number {
  const moofEnd = moofStart + moofSize;
  let pos = moofStart + 8;
  while (pos < moofEnd) {
    const child = readBoxHeader(buf, pos);
    if (!child) return -1;
    if (child.type === "traf") {
      let trafPos = pos + child.headerSize;
      const trafEnd = pos + child.size;
      while (trafPos < trafEnd) {
        const grand = readBoxHeader(buf, trafPos);
        if (!grand) return -1;
        if (grand.type === "tfdt") {
          const fullPos = trafPos + grand.headerSize;
          if (fullPos + 4 > buf.byteLength) return -1;
          const version = buf[fullPos];
          const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          if (version === 0) {
            if (fullPos + 8 > buf.byteLength) return -1;
            return view.getUint32(fullPos + 4, false);
          } else {
            if (fullPos + 12 > buf.byteLength) return -1;
            const hi = view.getUint32(fullPos + 4, false);
            const lo = view.getUint32(fullPos + 8, false);
            return hi * 0x1_0000_0000 + lo;
          }
        }
        trafPos += grand.size;
      }
    }
    pos += child.size;
  }
  return -1;
}


/**
 * Strip the EBML header + Segment header from a captured WebM chunk,
 * leaving only the Cluster element bytes. The bridge calls this on
 * every media chunk before concatenating — without it, each chunk
 * carries a full WebM init prefix (EBML + Segment header), and
 * concatenating multiple full WebM files into one byte stream produces
 * a stream the muxer can't parse past the first Cluster (it sees a
 * second EBML magic and stops).
 *
 * Implementation: scan the byte stream for the Cluster ID magic
 * `1F 43 B6 75` (4 bytes — vanishingly unlikely to occur by chance in
 * random binary data). The first occurrence is where the Cluster
 * starts; slice from there to the end. This is more robust than
 * walking the EBML element tree because YouTube SABR sometimes ships
 * Cues / Tracks elements with unknown size, on which a strict walker
 * would bail early.
 *
 * Returns the original bytes if:
 *   - The chunk does not start with EBML magic (already a bare Cluster).
 *   - No Cluster ID is found at all.
 */
export function stripWebmHeaderToClusters(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 8) return bytes;
  // Only strip if the chunk starts with EBML magic. Bare-Cluster chunks
  // have no header to strip.
  if (
    bytes[0] !== 0x1a ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0xdf ||
    bytes[3] !== 0xa3
  ) {
    return bytes;
  }
  // Brute-force search for the Cluster ID 0x1F 43 B6 75.
  // The init chunk usually has its first Cluster after ~1 KB of EBML +
  // Segment header + Info + Tracks, and media chunks have it within
  // ~200 bytes. We search the whole buffer to be safe.
  for (let i = 0; i < bytes.byteLength - 4; i++) {
    if (
      bytes[i] === 0x1f &&
      bytes[i + 1] === 0x43 &&
      bytes[i + 2] === 0xb6 &&
      bytes[i + 3] === 0x75
    ) {
      return bytes.subarray(i);
    }
  }
  return bytes;
}

/**
 * Quick check: do the bytes at offset 4..7 spell "ftyp"? Used as the
 * "this chunk starts with an ISOBMFF init prefix" guard before the
 * box-walk strip. Returns false on buffers shorter than 8 bytes.
 */
function startsWithFtyp(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 8 &&
    bytes[4] === 0x66 && // 'f'
    bytes[5] === 0x74 && // 't'
    bytes[6] === 0x79 && // 'y'
    bytes[7] === 0x70    // 'p'
  );
}

/**
 * Strip the ftyp + moov boxes from a captured ISOBMFF chunk, leaving
 * only the moof (and following mdat) bytes. Mirror of
 * `stripWebmHeaderToClusters` for the fragmented-MP4 codec families.
 *
 * Implementation: walk the top-level box list via `readBoxHeader`
 * starting at offset 0; the first box whose `type === "moof"` is the
 * cut point. This is robust against `0x6d 0x6f 0x6f 0x66` byte
 * sequences that happen to appear inside `mdat` payloads (common with
 * H.264 NALU), which a brute-force pattern scan would mistake for a
 * real moof box header.
 *
 * Returns the original bytes when:
 *   - The chunk does not start with `ftyp` (already bare moof+mdat).
 *   - The walk hits a parse error (truncated header, malformed size).
 *   - No `moof` box is found before end of buffer.
 *
 * Defensive bail on parse error keeps the existing strip-or-passthrough
 * contract — callers always get back a valid concatenable buffer.
 */
export function stripIsobmffHeaderToMoofs(bytes: Uint8Array): Uint8Array {
  if (!startsWithFtyp(bytes)) return bytes;
  let pos = 0;
  while (pos < bytes.byteLength) {
    const box = readBoxHeader(bytes, pos);
    if (!box) return bytes; // parse error — defensive: do not strip
    if (box.type === "moof") return bytes.subarray(pos);
    // Guard: malformed box.size (0 or > remaining bytes) → bail.
    if (box.size <= 0 || pos + box.size > bytes.byteLength) return bytes;
    pos += box.size;
  }
  return bytes;
}


/**
 * Rewrite a captured WebM init chunk so its top-level Segment element
 * has unknown size (`0x01 FF FF FF FF FF FF FF`). After we strip
 * subsequent media chunks down to bare Clusters and concatenate, the
 * resulting byte stream has more Cluster bytes than the original
 * Segment.size promised — mediabunny would stop reading at the
 * promised end. Switching the Segment to unknown size makes mediabunny
 * read until end of stream.
 *
 * Returns the original bytes if the init does not start with EBML
 * magic OR no Segment header is found.
 */
export function rewriteWebmSegmentToUnknownSize(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 16) return bytes;
  if (
    bytes[0] !== 0x1a ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0xdf ||
    bytes[3] !== 0xa3
  ) {
    return bytes;
  }
  const SEGMENT = 0x18538067;
  let pos = 0;
  while (pos < bytes.byteLength) {
    const id = readEbmlId(bytes, pos);
    if (!id) return bytes;
    if (id.id === SEGMENT) {
      // Replace the size VINT with an 8-byte unknown size marker.
      const sizeStart = pos + id.size;
      const sz = readEbmlSize(bytes, sizeStart);
      if (!sz) return bytes;
      const out = new Uint8Array(
        bytes.byteLength + (8 - sz.consumed),
      );
      // Copy bytes up to the size VINT.
      out.set(bytes.subarray(0, sizeStart), 0);
      // Write 8-byte unknown size marker (length-marker bit on first
      // byte + all 1s in body).
      out[sizeStart] = 0x01;
      out[sizeStart + 1] = 0xff;
      out[sizeStart + 2] = 0xff;
      out[sizeStart + 3] = 0xff;
      out[sizeStart + 4] = 0xff;
      out[sizeStart + 5] = 0xff;
      out[sizeStart + 6] = 0xff;
      out[sizeStart + 7] = 0xff;
      // Copy bytes after the original size VINT.
      out.set(bytes.subarray(sizeStart + sz.consumed), sizeStart + 8);
      return out;
    }
    pos += id.size;
    const sz = readEbmlSize(bytes, pos);
    if (!sz) return bytes;
    pos += sz.consumed;
    if (sz.size < 0) return bytes;
    pos += sz.size;
  }
  return bytes;
}
