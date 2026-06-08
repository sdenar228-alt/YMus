/**
 * YouTube fragmented-stream sorter.
 *
 * The MAIN-world UMP fetch hook captures `videoplayback` responses in
 * whatever order YouTube sends them. With `forceFullBuffer` doing
 * `playbackRate = 16` plus stall-driven seeks, fragments arrive
 * out of order — moof[5] then moof[2] then moof[8] etc. mediabunny's
 * fragmented-MP4 / fragmented-WebM demuxers read the byte stream
 * linearly: as soon as a fragment's timestamp is non-monotonic, the
 * iterator gives up early and the muxed file is truncated.
 *
 * This module reads the captured byte buffer, splits it into
 * (init-segment, fragment[0..N]) pairs, reads each fragment's
 * presentation timestamp directly from the container metadata, sorts
 * the fragments by ascending timestamp, and returns a clean
 * monotonically-ordered byte buffer that mediabunny can read end to end.
 *
 * Two formats are handled because YouTube ships H.264 / AAC in
 * fragmented MP4 and VP9 / AV1 / Opus in fragmented WebM:
 *
 *   1. **ISOBMFF (fragmented MP4)** — the captured stream is a sequence
 *      of top-level boxes: `ftyp`, `moov` (init), then `(moof, mdat)+`.
 *      Each `moof` contains a `traf > tfdt` whose `baseMediaDecodeTime`
 *      is the fragment's start time on that track's timescale. We walk
 *      box-by-box, group consecutive `moof` + `mdat` into one
 *      "fragment", and sort by the tfdt time.
 *
 *   2. **Matroska / WebM** — the stream is a sequence of EBML elements:
 *      `EBML`, `Segment` header, then `(Cluster)+`. Each `Cluster`
 *      starts with a `Timestamp` element giving the cluster's start
 *      time on the segment's timescale. We walk element-by-element,
 *      treat the EBML header + Segment header (everything up to the
 *      first Cluster) as the init segment, and sort the Cluster blobs
 *      by Timestamp.
 *
 * On any parse error we return the input unchanged — mediabunny will
 * then surface a normal error rather than us silently corrupting bytes.
 */

const TAG = "[ymd][sorter]";

// ─── Magic bytes ────────────────────────────────────────────────────────────

/** EBML magic — first four bytes of any Matroska/WebM file. */
const EBML_MAGIC_0 = 0x1a;
const EBML_MAGIC_1 = 0x45;
const EBML_MAGIC_2 = 0xdf;
const EBML_MAGIC_3 = 0xa3;

// ─── ISOBMFF (fragmented MP4) ───────────────────────────────────────────────

/** Convert a 4-byte ASCII type code into a string for diagnostics. */
function fourCC(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(
    buf[offset],
    buf[offset + 1],
    buf[offset + 2],
    buf[offset + 3],
  );
}

/**
 * Read one ISOBMFF box header at `offset`. Returns null on EOF or a box
 * with a header smaller than 8 bytes (malformed). Supports the 64-bit
 * `largesize` extension where `size === 1`.
 */
function readBoxHeader(
  buf: Uint8Array,
  offset: number,
): { size: number; type: string; headerSize: number } | null {
  if (offset + 8 > buf.byteLength) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let size = view.getUint32(offset, false);
  const type = fourCC(buf, offset + 4);
  let headerSize = 8;
  if (size === 1) {
    // 64-bit extended size in next 8 bytes.
    if (offset + 16 > buf.byteLength) return null;
    const hi = view.getUint32(offset + 8, false);
    const lo = view.getUint32(offset + 12, false);
    size = hi * 0x1_0000_0000 + lo;
    headerSize = 16;
  } else if (size === 0) {
    // Box extends to end of file.
    size = buf.byteLength - offset;
  }
  if (size < headerSize || offset + size > buf.byteLength) return null;
  return { size, type, headerSize };
}

/**
 * Walk a `moof` box and find the first `tfdt`'s `baseMediaDecodeTime`.
 * Returns 0 if the box does not contain a tfdt — the caller will then
 * use the byte offset as a stable tiebreaker so fragments at the same
 * time keep their original order.
 *
 * The path is `moof > traf > tfdt`. tfdt is a FullBox with version 0
 * (32-bit time) or version 1 (64-bit time).
 */
function readMoofBaseDecodeTime(
  buf: Uint8Array,
  moofStart: number,
  moofSize: number,
): number {
  const moofEnd = moofStart + moofSize;
  // Skip moof header (8 bytes); walk children.
  let pos = moofStart + 8;
  while (pos < moofEnd) {
    const child = readBoxHeader(buf, pos);
    if (!child) return 0;
    if (child.type === "traf") {
      // Walk traf children looking for tfdt.
      let trafPos = pos + child.headerSize;
      const trafEnd = pos + child.size;
      while (trafPos < trafEnd) {
        const grand = readBoxHeader(buf, trafPos);
        if (!grand) return 0;
        if (grand.type === "tfdt") {
          // FullBox: 1 byte version + 3 bytes flags, then time.
          const fullPos = trafPos + grand.headerSize;
          if (fullPos + 4 > buf.byteLength) return 0;
          const version = buf[fullPos];
          const view = new DataView(
            buf.buffer,
            buf.byteOffset,
            buf.byteLength,
          );
          if (version === 0) {
            if (fullPos + 8 > buf.byteLength) return 0;
            return view.getUint32(fullPos + 4, false);
          } else {
            if (fullPos + 12 > buf.byteLength) return 0;
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
  return 0;
}

/**
 * Detect whether the stream looks like ISOBMFF — first box is `ftyp`,
 * `styp`, `moov`, `moof`, or `sidx`. We check `ftyp` / `moov` as the
 * common YouTube init-segment leaders, plus `moof` for streams where
 * the init was lost (defensive — would fail muxing later anyway).
 */
function looksLikeIsobmff(buf: Uint8Array): boolean {
  if (buf.byteLength < 8) return false;
  const first = readBoxHeader(buf, 0);
  if (!first) return false;
  switch (first.type) {
    case "ftyp":
    case "styp":
    case "moov":
    case "moof":
    case "sidx":
      return true;
    default:
      return false;
  }
}

interface IsobmffSplit {
  /** Concatenated ftyp+moov (plus any other init boxes before first moof). */
  init: Uint8Array;
  /** One entry per (moof, mdat?) fragment, with its tfdt time. */
  fragments: Array<{ time: number; bytes: Uint8Array; index: number }>;
}

/**
 * Split a captured ISOBMFF buffer into init + fragments.
 *
 * Init segment = everything from byte 0 up to (but not including) the
 * first `moof` box. Fragments = each `moof` + the IMMEDIATELY following
 * `mdat` (if any). Boxes between fragments that are not `moof`/`mdat`
 * (e.g. a stray `free` box) are appended to the previous fragment so
 * we don't lose bytes.
 */
function splitIsobmff(buf: Uint8Array): IsobmffSplit | null {
  let pos = 0;
  let firstMoofOffset = -1;
  while (pos < buf.byteLength) {
    const box = readBoxHeader(buf, pos);
    if (!box) return null;
    if (box.type === "moof") {
      firstMoofOffset = pos;
      break;
    }
    pos += box.size;
  }
  if (firstMoofOffset === -1) {
    // No moof at all — nothing to sort. Return single "fragment" so we
    // hand the bytes back unchanged.
    return {
      init: buf,
      fragments: [],
    };
  }
  const init = buf.subarray(0, firstMoofOffset);
  const fragments: IsobmffSplit["fragments"] = [];
  let fragIndex = 0;
  pos = firstMoofOffset;
  while (pos < buf.byteLength) {
    const box = readBoxHeader(buf, pos);
    if (!box) break;
    if (box.type === "moof") {
      const moofStart = pos;
      const time = readMoofBaseDecodeTime(buf, moofStart, box.size);
      let endPos = pos + box.size;
      // Pull a following mdat into the same fragment.
      if (endPos < buf.byteLength) {
        const next = readBoxHeader(buf, endPos);
        if (next && next.type === "mdat") {
          endPos += next.size;
        }
      }
      fragments.push({
        time,
        bytes: buf.subarray(moofStart, endPos),
        index: fragIndex++,
      });
      pos = endPos;
    } else {
      // Unexpected top-level box between fragments — attach to the
      // previous fragment so the overall byte sequence is not broken.
      if (fragments.length > 0) {
        const last = fragments[fragments.length - 1];
        const merged = new Uint8Array(last.bytes.byteLength + box.size);
        merged.set(last.bytes, 0);
        merged.set(buf.subarray(pos, pos + box.size), last.bytes.byteLength);
        fragments[fragments.length - 1] = { ...last, bytes: merged };
      }
      pos += box.size;
    }
  }
  return { init, fragments };
}

// ─── Matroska / WebM (EBML) ─────────────────────────────────────────────────

/**
 * Read an EBML variable-length ID at `offset`. Returns the raw ID
 * (with length-marker bit kept — IDs are matched verbatim) and the
 * number of bytes consumed.
 */
function readEbmlId(
  buf: Uint8Array,
  offset: number,
): { id: number; size: number } | null {
  if (offset >= buf.byteLength) return null;
  const b = buf[offset];
  if (b === 0) return null;
  let size: number;
  if (b & 0x80) size = 1;
  else if (b & 0x40) size = 2;
  else if (b & 0x20) size = 3;
  else if (b & 0x10) size = 4;
  else return null; // Invalid ID prefix.
  if (offset + size > buf.byteLength) return null;
  let id = 0;
  for (let i = 0; i < size; i++) {
    id = id * 256 + buf[offset + i];
  }
  return { id, size };
}

/**
 * Read an EBML variable-length size value at `offset`. Returns the
 * decoded size with the length-marker bit cleared (unlike IDs, sizes
 * have the marker bit removed by spec). Length 0 means "unknown size",
 * which we encode as -1 to disambiguate from a real zero.
 */
function readEbmlSize(
  buf: Uint8Array,
  offset: number,
): { size: number; consumed: number } | null {
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
  if (consumed > 8) return null;
  if (offset + consumed > buf.byteLength) return null;
  // First byte has size bits past the marker.
  let size = first & (mask - 1);
  for (let i = 1; i < consumed; i++) {
    size = size * 256 + buf[offset + i];
  }
  // All-1 size (e.g. 0xFF for length 1) means "unknown" → return -1.
  // Detect: every bit past the marker is 1.
  let isUnknown = (first & (mask - 1)) === mask - 1;
  if (isUnknown) {
    for (let i = 1; i < consumed; i++) {
      if (buf[offset + i] !== 0xff) {
        isUnknown = false;
        break;
      }
    }
  }
  if (isUnknown) return { size: -1, consumed };
  return { size, consumed };
}

/** Read a big-endian unsigned integer of `len` bytes (1..8). */
function readEbmlUint(
  buf: Uint8Array,
  offset: number,
  len: number,
): number {
  let result = 0;
  for (let i = 0; i < len; i++) {
    result = result * 256 + buf[offset + i];
  }
  return result;
}

// EBML element IDs we care about (encoded with their marker bits, so the
// raw uint matches what readEbmlId returns).
const EBML_ID_HEADER = 0x1a45dfa3; // "EBML" header element
const EBML_ID_SEGMENT = 0x18538067; // Segment
const EBML_ID_CLUSTER = 0x1f43b675; // Cluster
const EBML_ID_TIMESTAMP = 0xe7; // Cluster.Timestamp (was Timecode in older spec)

interface WebmSplit {
  /** Concatenated EBML header + everything in Segment up to first Cluster. */
  init: Uint8Array;
  /** One entry per Cluster, with its decoded Timestamp. */
  fragments: Array<{ time: number; bytes: Uint8Array; index: number }>;
}

/**
 * Read the Cluster's Timestamp (first child element with ID 0xE7) from
 * a Cluster blob. If not found returns 0 and the caller falls back to
 * stable-by-index ordering.
 */
function readClusterTimestamp(
  buf: Uint8Array,
  clusterStart: number,
  clusterEnd: number,
  childrenStart: number,
): number {
  let pos = childrenStart;
  while (pos < clusterEnd) {
    const id = readEbmlId(buf, pos);
    if (!id) return 0;
    pos += id.size;
    const sz = readEbmlSize(buf, pos);
    if (!sz) return 0;
    pos += sz.consumed;
    if (id.id === EBML_ID_TIMESTAMP) {
      // Timestamp is an unsigned int.
      const len = sz.size;
      if (len < 1 || len > 8 || pos + len > buf.byteLength) return 0;
      return readEbmlUint(buf, pos, len);
    }
    if (sz.size < 0) return 0; // Unknown size — bail.
    pos += sz.size;
  }
  return 0;
}

/**
 * Detect WebM / Matroska — first 4 bytes are the EBML magic.
 */
function looksLikeWebm(buf: Uint8Array): boolean {
  return (
    buf.byteLength > 4 &&
    buf[0] === EBML_MAGIC_0 &&
    buf[1] === EBML_MAGIC_1 &&
    buf[2] === EBML_MAGIC_2 &&
    buf[3] === EBML_MAGIC_3
  );
}

/**
 * Split a captured Matroska/WebM buffer into init + Cluster fragments.
 *
 * Init segment = EBML header element + the Segment header bytes up to
 * (but NOT including) the first Cluster. Note the Segment element
 * itself is "open" — its size may be unknown — so we just emit its
 * header bytes and rely on the muxer to read it as a streaming Segment.
 *
 * Each Cluster blob keeps its full bytes (header + children).
 */
function splitWebm(buf: Uint8Array): WebmSplit | null {
  let pos = 0;
  // Walk top-level elements: EBML header, then Segment.
  let segmentChildrenStart = -1;
  let segmentEnd = -1;
  while (pos < buf.byteLength) {
    const id = readEbmlId(buf, pos);
    if (!id) return null;
    const idStart = pos;
    pos += id.size;
    const sz = readEbmlSize(buf, pos);
    if (!sz) return null;
    pos += sz.consumed;
    if (id.id === EBML_ID_HEADER) {
      // EBML header — skip its body.
      if (sz.size < 0) return null;
      pos += sz.size;
    } else if (id.id === EBML_ID_SEGMENT) {
      // Segment: descend into children. Size may be unknown (-1).
      segmentChildrenStart = pos;
      segmentEnd = sz.size < 0 ? buf.byteLength : pos + sz.size;
      // Cap segmentEnd at buffer end.
      if (segmentEnd > buf.byteLength) segmentEnd = buf.byteLength;
      break;
    } else {
      // Unknown top-level element — skip.
      if (sz.size < 0) return null;
      pos += sz.size;
    }
    void idStart;
  }

  if (segmentChildrenStart === -1) {
    return null;
  }

  // Walk Segment children looking for Clusters. Everything before the
  // first Cluster is part of the init.
  let firstClusterStart = -1;
  let cursor = segmentChildrenStart;
  while (cursor < segmentEnd) {
    const id = readEbmlId(buf, cursor);
    if (!id) break;
    const elemStart = cursor;
    cursor += id.size;
    const sz = readEbmlSize(buf, cursor);
    if (!sz) break;
    cursor += sz.consumed;
    if (id.id === EBML_ID_CLUSTER) {
      firstClusterStart = elemStart;
      break;
    }
    if (sz.size < 0) {
      // Unknown size on a non-Cluster top-level segment child — bail.
      break;
    }
    cursor += sz.size;
  }

  if (firstClusterStart === -1) {
    return { init: buf.subarray(0, segmentChildrenStart), fragments: [] };
  }

  const init = buf.subarray(0, firstClusterStart);
  const fragments: WebmSplit["fragments"] = [];
  let clusterIdx = 0;
  cursor = firstClusterStart;
  while (cursor < segmentEnd) {
    const id = readEbmlId(buf, cursor);
    if (!id) break;
    const elemStart = cursor;
    cursor += id.size;
    const sz = readEbmlSize(buf, cursor);
    if (!sz) break;
    cursor += sz.consumed;
    if (id.id === EBML_ID_CLUSTER) {
      // If the cluster has unknown size, look for the next top-level
      // element with a known ID prefix to find its end. Practical
      // YouTube WebM streams emit known sizes so we keep it simple.
      let clusterEnd: number;
      if (sz.size < 0) {
        // Scan forward for next Cluster ID by reading 4-byte windows.
        let p = cursor;
        let found = -1;
        while (p + 4 <= segmentEnd) {
          if (
            buf[p] === 0x1f &&
            buf[p + 1] === 0x43 &&
            buf[p + 2] === 0xb6 &&
            buf[p + 3] === 0x75
          ) {
            found = p;
            break;
          }
          p++;
        }
        clusterEnd = found === -1 ? segmentEnd : found;
      } else {
        clusterEnd = cursor + sz.size;
        if (clusterEnd > segmentEnd) clusterEnd = segmentEnd;
      }
      const time = readClusterTimestamp(buf, elemStart, clusterEnd, cursor);
      fragments.push({
        time,
        bytes: buf.subarray(elemStart, clusterEnd),
        index: clusterIdx++,
      });
      cursor = clusterEnd;
    } else {
      if (sz.size < 0) break;
      cursor += sz.size;
    }
  }

  return { init, fragments };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Sort a captured fragmented stream so its fragments are in monotonic
 * timestamp order.
 *
 *   - If the buffer is fragmented MP4, sort `(moof, mdat)` pairs by
 *     `tfdt.baseMediaDecodeTime`.
 *   - If the buffer is Matroska/WebM, sort Clusters by their Timestamp.
 *   - Otherwise (or on parse error) return the input verbatim.
 *
 * Stable sort: fragments with identical timestamps keep their original
 * arrival order.
 */
export function sortCapturedStream(
  bytes: Uint8Array,
  label: string,
): Uint8Array {
  if (bytes.byteLength === 0) return bytes;
  try {
    if (looksLikeIsobmff(bytes)) {
      const split = splitIsobmff(bytes);
      if (!split || split.fragments.length === 0) return bytes;
      const before = split.fragments.map((f) => f.time);
      // Stable sort by time, falling back to original index.
      split.fragments.sort((a, b) => a.time - b.time || a.index - b.index);
      const after = split.fragments.map((f) => f.time);
      console.info(
        `${TAG} ${label}: ISOBMFF, ${split.fragments.length} fragments`,
        sortChangedSummary(before, after),
      );
      return concatFragments(split.init, split.fragments);
    }
    if (looksLikeWebm(bytes)) {
      const split = splitWebm(bytes);
      if (!split || split.fragments.length === 0) return bytes;
      // Diagnostic: show first 5 cluster boundaries so we can verify
      // the parser found correct cluster splits, not just one giant
      // cluster that ate the entire byte stream.
      const sample = split.fragments
        .slice(0, 5)
        .map(
          (f) =>
            `(t=${f.time} sz=${f.bytes.byteLength}@${f.bytes.byteOffset - bytes.byteOffset})`,
        )
        .join(" ");
      console.info(
        `${TAG} ${label}: WebM split init=${split.init.byteLength}B clusters=${split.fragments.length} first5=${sample}`,
      );
      const before = split.fragments.map((f) => f.time);
      split.fragments.sort((a, b) => a.time - b.time || a.index - b.index);
      const after = split.fragments.map((f) => f.time);
      console.info(
        `${TAG} ${label}: WebM, ${split.fragments.length} clusters`,
        sortChangedSummary(before, after),
      );
      return concatFragments(split.init, split.fragments);
    }
    console.warn(`${TAG} ${label}: unknown container, skipping sort`);
    return bytes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${TAG} ${label}: sort failed (${msg}), returning original`);
    return bytes;
  }
}

function sortChangedSummary(before: number[], after: number[]): string {
  let outOfOrder = 0;
  for (let i = 1; i < before.length; i++) {
    if (before[i] < before[i - 1]) outOfOrder++;
  }
  let monotonic = true;
  for (let i = 1; i < after.length; i++) {
    if (after[i] < after[i - 1]) {
      monotonic = false;
      break;
    }
  }
  return `[outOfOrderBefore=${outOfOrder} → monotonicAfter=${monotonic} firstTime=${after[0] ?? 0} lastTime=${after[after.length - 1] ?? 0}]`;
}

function concatFragments(
  init: Uint8Array,
  fragments: Array<{ bytes: Uint8Array }>,
): Uint8Array {
  let total = init.byteLength;
  for (const f of fragments) total += f.bytes.byteLength;
  const out = new Uint8Array(total);
  out.set(init, 0);
  let offset = init.byteLength;
  for (const f of fragments) {
    out.set(f.bytes, offset);
    offset += f.bytes.byteLength;
  }
  return out;
}
