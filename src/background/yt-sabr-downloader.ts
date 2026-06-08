// SABR replay downloader.
//
// Replays the YouTube player's `videoplayback` POSTs from the SW so we
// receive clean UMP responses (no MSE buffer scraping). For each captured
// SABR body we re-issue `fetch(url + "&rn=N&alr=yes", { method: "POST",
// body })`, parse the UMP framing, and accumulate (init segment + per-block
// media bytes) per stream. After the captured replay we run a "direct
// gap-fill" pass: for every missing 5 s video / 10 s audio time slot, we
// build a synthetic SABR body via `buildVideoSabrBody`/`buildAudioSabrBody`
// and replay it against the same URL.
//
// The final muxing is performed by `yt-mediabunny-mux.muxToMp4`. SABR
// downloader returns the muxed MP4 bytes directly so the caller only has
// to save them.
//
// Ported from the legacy 22 May build's `src/background/yt-sabr-downloader.ts`.

import { parseUmpParts, readProtoVarInt, readUmpVarInt } from "./yt-ump-parser";
import type { Stream } from "./yt-stream-selector";
import { muxToMp4 } from "./yt-mediabunny-mux";

const TAG = "[YMus YT SABR DL]";

/** AAC iTags ordered by descending preference (used as fallback only). */
const AUDIO_ITAG_PREFERENCE: readonly number[] = [140, 251, 250, 249];

// ─── Result types ────────────────────────────────────────────────────────────

export interface SabrDownloadSuccess {
  success: true;
  /** Muxed MP4 bytes. */
  data: Uint8Array;
  /** Convenience copy of `data.byteLength`. */
  totalSize: number;
}

export interface SabrDownloadError {
  success: false;
  error: string;
}

export type SabrDownloadResult = SabrDownloadSuccess | SabrDownloadError;

/** Progress update emitted by the downloader. */
export interface SabrProgress {
  stream: "video" | "audio";
  bytesDownloaded: number;
  hasInit: boolean;
  pct?: number;
  videoBlocks?: number;
  expectedVideoBlocks?: number;
}

export type SabrProgressCallback = (progress: SabrProgress) => void;

/** Internal per-iTag stream accumulator. */
interface StreamState {
  itag: number;
  initSegment: Uint8Array | null;
  segmentBlocks: Map<string, Map<number, Uint8Array>>;
  blockTimeMs: Map<string, number>;
  blockTotalLen: Map<string, number>;
  blockSealedInResponse: Map<string, number>;
  totalContentLength: number;
}

// ─── Proto encoding helpers (for buildVideoSabrBody / buildAudioSabrBody) ────

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  while (v > 127) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

function encodeTag(fieldNum: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNum << 3) | wireType);
}

function encodeVarintField(fieldNum: number, value: number): Uint8Array {
  const tag = encodeTag(fieldNum, 0);
  const val = encodeVarint(value);
  const result = new Uint8Array(tag.length + val.length);
  result.set(tag, 0);
  result.set(val, tag.length);
  return result;
}

function encodeLenDelim(fieldNum: number, data: Uint8Array): Uint8Array {
  const tag = encodeTag(fieldNum, 2);
  const len = encodeVarint(data.length);
  const result = new Uint8Array(tag.length + len.length + data.length);
  result.set(tag, 0);
  result.set(len, tag.length);
  result.set(data, tag.length + len.length);
  return result;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ─── SABR body builders ──────────────────────────────────────────────────────

/**
 * Build a SABR POST body that asks the server for a single audio segment
 * starting at `timeMs` for the given audio iTag.
 *
 * Strips field 3 (data request) and field 17 (video formats) from the
 * captured template, then appends a fresh field-3 message containing
 * `{ streamId(1)=audio_itag/lmt, byteOffset(2)=0, timeMs(3), seq(4)=1,
 *   sequence(5) }`.
 */
export function buildAudioSabrBody(
  templateBody: Uint8Array,
  audioStream: Stream,
  sequence: number,
  timeMs: number,
): Uint8Array {
  const stripped = stripField(stripField(templateBody, 3), 17);
  const streamId = concat(
    encodeVarintField(1, audioStream.itag),
    encodeVarintField(2, audioStream.lmt),
  );
  const field3Inner = concat(
    encodeLenDelim(1, streamId),
    encodeVarintField(2, 0),
    encodeVarintField(3, timeMs),
    encodeVarintField(4, 1),
    encodeVarintField(5, sequence),
  );
  return concat(stripped, encodeLenDelim(3, field3Inner));
}

/** Same as `buildAudioSabrBody` but for the video iTag (strips field 16). */
export function buildVideoSabrBody(
  templateBody: Uint8Array,
  videoStream: Stream,
  sequence: number,
  timeMs: number,
): Uint8Array {
  const stripped = stripField(stripField(templateBody, 3), 16);
  const streamId = concat(
    encodeVarintField(1, videoStream.itag),
    encodeVarintField(2, videoStream.lmt),
  );
  const field3Inner = concat(
    encodeLenDelim(1, streamId),
    encodeVarintField(2, 0),
    encodeVarintField(3, timeMs),
    encodeVarintField(4, 1),
    encodeVarintField(5, sequence),
  );
  return concat(stripped, encodeLenDelim(3, field3Inner));
}

/** Whether the given proto body declares a field 3 (data request). */
export function bodyHasField3(buf: Uint8Array): boolean {
  let offset = 0;
  while (offset < buf.length) {
    let tag = 0,
      shift = 0;
    while (offset < buf.length) {
      const b = buf[offset++];
      tag |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) return false;
    }
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (fieldNum === 3) return true;
    if (wireType === 0) {
      while (offset < buf.length && (buf[offset] & 0x80) !== 0) offset++;
      offset++;
    } else if (wireType === 2) {
      let len = 0,
        lenShift = 0;
      while (offset < buf.length) {
        const b = buf[offset++];
        len |= (b & 0x7f) << lenShift;
        if ((b & 0x80) === 0) break;
        lenShift += 7;
      }
      offset += len;
    } else if (wireType === 5) offset += 4;
    else if (wireType === 1) offset += 8;
    else return false;
  }
  return false;
}

/** Strip every occurrence of a top-level proto field. */
function stripField(buf: Uint8Array, targetField: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const startOffset = offset;
    let tag = 0,
      shift = 0;
    while (offset < buf.length) {
      const b = buf[offset++];
      tag |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    let fieldEnd = offset;
    if (wireType === 0) {
      while (fieldEnd < buf.length && (buf[fieldEnd] & 0x80) !== 0) fieldEnd++;
      fieldEnd++;
    } else if (wireType === 2) {
      let len = 0;
      let lenShift = 0;
      while (fieldEnd < buf.length) {
        const b = buf[fieldEnd++];
        len |= (b & 0x7f) << lenShift;
        if ((b & 0x80) === 0) break;
        lenShift += 7;
      }
      fieldEnd += len;
    } else if (wireType === 5) {
      fieldEnd += 4;
    } else if (wireType === 1) {
      fieldEnd += 8;
    } else {
      break;
    }
    if (fieldNum !== targetField) {
      parts.push(buf.subarray(startOffset, fieldEnd));
    }
    offset = fieldEnd;
  }
  return concat(...parts);
}

// ─── Init segment detection ──────────────────────────────────────────────────

export interface InitDetection {
  isInit: boolean;
  format: "mp4" | "webm" | null;
}

/**
 * Look at the first few bytes of a SABR media payload and decide whether
 * it is an init segment (MP4 `ftyp` box or Matroska `EBML` magic) or a
 * media fragment.
 */
export function detectInitSegment(mediaData: Uint8Array): InitDetection {
  if (mediaData.byteLength < 8) {
    return { isInit: false, format: null };
  }
  // ISOBMFF: bytes 4..7 spell "ftyp".
  if (
    mediaData[4] === 0x66 &&
    mediaData[5] === 0x74 &&
    mediaData[6] === 0x79 &&
    mediaData[7] === 0x70
  ) {
    return { isInit: true, format: "mp4" };
  }
  // WebM (EBML magic): bytes 0..3 = 1A 45 DF A3.
  if (
    mediaData[0] === 0x1a &&
    mediaData[1] === 0x45 &&
    mediaData[2] === 0xdf &&
    mediaData[3] === 0xa3
  ) {
    return { isInit: true, format: "webm" };
  }
  return { isInit: false, format: null };
}

// ─── Audio iTag finder ───────────────────────────────────────────────────────

/**
 * Walk captured SABR bodies for the audio iTag table (field 16) and return
 * the best match per `AUDIO_ITAG_PREFERENCE`. Used by callers that don't
 * yet have a `parseAvailableStreams` result.
 */
export function findAudioStreamFromBodies(
  bodies: ArrayBuffer[] | Uint8Array[],
): Stream | null {
  for (const body of bodies) {
    const buf = body instanceof Uint8Array ? body : new Uint8Array(body);
    const found: Stream[] = [];
    let offset = 0;
    while (offset < buf.length) {
      let tag = 0,
        shift = 0;
      while (offset < buf.length) {
        const b = buf[offset++];
        tag |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (shift > 35) break;
      }
      const fieldNum = tag >>> 3;
      const wireType = tag & 0x07;
      if (wireType === 0) {
        while (offset < buf.length && (buf[offset] & 0x80) !== 0) offset++;
        if (offset < buf.length) offset++;
      } else if (wireType === 2) {
        let len = 0,
          lenShift = 0;
        while (offset < buf.length) {
          const b = buf[offset++];
          len |= (b & 0x7f) << lenShift;
          if ((b & 0x80) === 0) break;
          lenShift += 7;
        }
        if (fieldNum === 16 && len > 2 && len < 30) {
          const entryStart = offset;
          const entryEnd = offset + len;
          let itag = 0,
            lmt = 0;
          let pos = entryStart;
          while (pos < entryEnd) {
            let entryTag = 0,
              eShift = 0;
            while (pos < entryEnd) {
              const b = buf[pos++];
              entryTag |= (b & 0x7f) << eShift;
              if ((b & 0x80) === 0) break;
              eShift += 7;
            }
            const fn = entryTag >>> 3;
            const wt = entryTag & 0x07;
            if (wt === 0) {
              let val = 0,
                vShift = 0;
              while (pos < entryEnd) {
                const b = buf[pos++];
                val |= (b & 0x7f) << vShift;
                if ((b & 0x80) === 0) break;
                vShift += 7;
              }
              if (fn === 1) itag = val >>> 0;
              if (fn === 2) lmt = val >>> 0;
            } else {
              break;
            }
          }
          if (itag > 0 && lmt > 0) {
            found.push({ itag, lmt });
          }
        }
        offset += len;
      } else if (wireType === 5) {
        offset += 4;
      } else if (wireType === 1) {
        offset += 8;
      } else {
        break;
      }
    }
    if (found.length > 0) {
      for (const pref of AUDIO_ITAG_PREFERENCE) {
        const match = found.find((s) => s.itag === pref);
        if (match) {
          console.log(
            `${TAG} Found audio: itag=${match.itag}, lmt=${match.lmt} (from ${found.length} entries)`,
          );
          return match;
        }
      }
      console.log(
        `${TAG} No preferred itag, using first: itag=${found[0].itag}, lmt=${found[0].lmt}`,
      );
      return found[0];
    }
  }
  console.log(`${TAG} No audio stream found in ${bodies.length} bodies`);
  return null;
}

// ─── Stream assembly ─────────────────────────────────────────────────────────

function assembleStreamFromSegments(stream: StreamState): Uint8Array {
  const init = stream.initSegment;
  if (stream.segmentBlocks.size === 0) {
    return init || new Uint8Array(0);
  }
  const blockIds = Array.from(stream.segmentBlocks.keys()).sort((a, b) => {
    const tA = stream.blockTimeMs.get(a) || 0;
    const tB = stream.blockTimeMs.get(b) || 0;
    return tA - tB;
  });
  const blockChunks: { timeMs: number; data: Uint8Array }[] = [];
  for (const blockId of blockIds) {
    const block = stream.segmentBlocks.get(blockId);
    if (!block) continue;
    const timeMs = stream.blockTimeMs.get(blockId) || 0;
    const sorted = Array.from(block.entries()).sort((a, b) => a[0] - b[0]);
    if (sorted.length === 0) continue;
    let maxEnd = 0;
    for (const [off, data] of sorted) {
      const end = off + data.byteLength;
      if (end > maxEnd) maxEnd = end;
    }
    const buf = new Uint8Array(maxEnd);
    for (const [off, data] of sorted) {
      if (off + data.byteLength <= buf.byteLength) {
        buf.set(data, off);
      }
    }
    blockChunks.push({ timeMs, data: buf });
  }
  const totalSize = blockChunks.reduce((acc, b) => acc + b.data.byteLength, 0);
  const initSize = init ? init.byteLength : 0;
  const result = new Uint8Array(initSize + totalSize);
  let offset = 0;
  if (init) {
    result.set(init, offset);
    offset += init.byteLength;
  }
  console.log(
    `${TAG}   itag=${stream.itag}: ${blockChunks.length} blocks, total ${totalSize} bytes (init: ${initSize}b)`,
  );
  const GAP_WARN_MS = 11_000;
  let gapCount = 0;
  const gapDetails: { fromMs: number; toMs: number; gapMs: number }[] = [];
  for (let i = 1; i < blockChunks.length; i++) {
    const prev = blockChunks[i - 1];
    const cur = blockChunks[i];
    const timeJump = cur.timeMs - prev.timeMs;
    if (timeJump > GAP_WARN_MS) {
      gapCount++;
      gapDetails.push({
        fromMs: prev.timeMs,
        toMs: cur.timeMs,
        gapMs: timeJump,
      });
      console.warn(
        `${TAG}     ⚠ time gap: ${prev.timeMs}ms → ${cur.timeMs}ms (${timeJump}ms missing)`,
      );
    }
  }
  if (gapCount > 0) {
    const summary = gapDetails
      .map((g) => `${(g.fromMs / 1000).toFixed(1)}s→${(g.toMs / 1000).toFixed(1)}s`)
      .join(", ");
    console.warn(
      `${TAG}   itag=${stream.itag}: ${gapCount} gaps detected — output may be glitchy. Gaps at: ${summary}`,
    );
  }
  for (const block of blockChunks) {
    result.set(block.data, offset);
    offset += block.data.byteLength;
  }
  return result;
}

// ─── Coverage stats helpers ──────────────────────────────────────────────────

interface CoverageStats {
  blockCount: number;
  maxTimeMs: number;
  largestGapMs: number;
  contiguousMs: number;
  totalBytes: number;
}

function streamFormat(s: StreamState): "mp4" | "webm" | null {
  if (!s.initSegment) return null;
  return detectInitSegment(s.initSegment).format;
}

function coverageStats(s: StreamState): CoverageStats {
  const times = Array.from(s.segmentBlocks.keys())
    .map((id) => s.blockTimeMs.get(id) || 0)
    .sort((a, b) => a - b);
  if (times.length === 0) {
    return {
      blockCount: 0,
      maxTimeMs: 0,
      largestGapMs: 0,
      contiguousMs: 0,
      totalBytes: 0,
    };
  }
  let largestGap = 0;
  let contiguousEnd = times[0];
  let firstGapHit = false;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > largestGap) largestGap = gap;
    if (!firstGapHit) {
      if (gap > 11_000) {
        firstGapHit = true;
      } else {
        contiguousEnd = times[i];
      }
    }
  }
  let totalBytes = 0;
  for (const block of s.segmentBlocks.values()) {
    for (const data of block.values()) totalBytes += data.byteLength;
  }
  return {
    blockCount: times.length,
    maxTimeMs: times[times.length - 1],
    largestGapMs: largestGap,
    contiguousMs: contiguousEnd,
    totalBytes,
  };
}

// ─── Main downloader ─────────────────────────────────────────────────────────

/** Globals used for parameter-passing — see the legacy build. */
declare global {
  // eslint-disable-next-line no-var
  var __ytSabrAllBodies: ArrayBuffer[] | Uint8Array[] | undefined;
  // eslint-disable-next-line no-var
  var __ytVideoDurationSec: number | undefined;
}

/**
 * Replay every captured SABR body, parse the responses, optionally fill
 * gaps via direct replay, then mux the best video + audio streams into an
 * MP4 via mediabunny. Returns the muxed bytes ready to be saved.
 *
 * Call sites pass `templateBody` (one of the captured bodies — usually
 * `bodies[0]`) and rely on `globalThis.__ytSabrAllBodies` to enumerate the
 * full set of bodies to replay. `globalThis.__ytVideoDurationSec` drives
 * the gap-fill pass.
 */
export async function downloadVideoViaSabr(
  sabrUrl: string,
  templateBody: ArrayBuffer | Uint8Array,
  videoStream: Stream,
  audioStream: Stream,
  onProgress?: SabrProgressCallback,
): Promise<SabrDownloadResult> {
  const template =
    templateBody instanceof Uint8Array ? templateBody : new Uint8Array(templateBody);

  const allBodies = globalThis.__ytSabrAllBodies;
  let bodiesToReplay: (ArrayBuffer | Uint8Array)[] =
    allBodies && allBodies.length > 3
      ? ((allBodies as unknown as (ArrayBuffer | Uint8Array)[]).slice())
      : [template];

  // Dedup bodies by (size, prefix, suffix) signature.
  const seen = new Set<string>();
  const unique: (ArrayBuffer | Uint8Array)[] = [];
  for (const b of bodiesToReplay) {
    const view = b instanceof Uint8Array ? b : new Uint8Array(b);
    const sig = `${view.byteLength}:${Array.from(view.slice(0, 100)).join(",")}:${Array.from(view.slice(-100)).join(",")}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      unique.push(b);
    }
  }
  bodiesToReplay = unique;

  console.log(
    `${TAG} Starting video download: video itag=${videoStream.itag}, audio itag=${audioStream.itag}`,
  );
  console.log(`${TAG} Replaying ${bodiesToReplay.length} captured bodies`);

  const abortController = new AbortController();
  const streams = new Map<number, StreamState>();

  function getStream(itag: number): StreamState {
    let s = streams.get(itag);
    if (!s) {
      s = {
        itag,
        initSegment: null,
        segmentBlocks: new Map(),
        blockTimeMs: new Map(),
        blockTotalLen: new Map(),
        blockSealedInResponse: new Map(),
        totalContentLength: 0,
      };
      streams.set(itag, s);
    }
    return s;
  }

  function emitProgress(): void {
    if (!onProgress) return;
    try {
      const v = streams.get(videoStream.itag);
      const a = streams.get(audioStream.itag);
      const sumBytes = (s: StreamState | undefined): number => {
        if (!s) return 0;
        let total = 0;
        for (const block of s.segmentBlocks.values()) {
          for (const data of block.values()) total += data.byteLength;
        }
        return total;
      };
      const durSec = globalThis.__ytVideoDurationSec;
      const videoBlocks = v?.segmentBlocks.size ?? 0;
      let expectedVideoBlocks = 0;
      let pct: number | undefined;
      if (typeof durSec === "number" && durSec > 0) {
        expectedVideoBlocks = Math.max(1, Math.ceil(durSec / 5.5));
        pct = Math.min(99, Math.round((videoBlocks / expectedVideoBlocks) * 100));
      }
      onProgress({
        stream: "video",
        bytesDownloaded: sumBytes(v),
        hasInit: !!v?.initSegment,
        pct,
        videoBlocks,
        expectedVideoBlocks,
      });
      onProgress({
        stream: "audio",
        bytesDownloaded: sumBytes(a),
        hasInit: !!a?.initSegment,
        pct,
        videoBlocks,
        expectedVideoBlocks,
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * Walk one UMP response and merge its media into `streams`. Used by
   * both the captured-body replay and the direct gap-fill replay.
   */
  function ingestUmpResponse(rawBuf: Uint8Array, responseIdx: number): void {
    const streamIdMap = new Map<
      number,
      { itag: number; segmentId: string; timeMs: number; totalLen: number }
    >();
    const streamRunningOffset = new Map<number, number>();
    const parts = parseUmpParts(rawBuf);
    for (const part of parts) {
      if (part.type === 20 && part.data.byteLength > 2) {
        let streamId = -1,
          itag = 0,
          totalLen = 0,
          startTimeMs = 0;
        let off = 0;
        while (off < part.data.byteLength) {
          const [tag, off1] = readProtoVarInt(part.data, off);
          if (off1 === off) break;
          off = off1;
          const fieldNum = tag >>> 3;
          const wireType = tag & 0x07;
          if (wireType === 0) {
            const [val, off2] = readProtoVarInt(part.data, off);
            if (off2 === off) break;
            if (fieldNum === 1) streamId = val;
            else if (fieldNum === 3) itag = val;
            else if (fieldNum === 11) startTimeMs = val;
            else if (fieldNum === 14) totalLen = val;
            off = off2;
          } else if (wireType === 2) {
            const [len, off2] = readProtoVarInt(part.data, off);
            if (off2 === off || off2 + len > part.data.byteLength) break;
            off = off2 + len;
          } else if (wireType === 5) {
            if (off + 4 > part.data.byteLength) break;
            off += 4;
          } else if (wireType === 1) {
            if (off + 8 > part.data.byteLength) break;
            off += 8;
          } else {
            break;
          }
        }
        if (streamId >= 0 && itag > 0) {
          const segmentId = `${itag}:${startTimeMs}`;
          streamIdMap.set(streamId, {
            itag,
            segmentId,
            timeMs: startTimeMs,
            totalLen,
          });
          streamRunningOffset.set(streamId, 0);
          const stream = getStream(itag);
          stream.blockTimeMs.set(segmentId, startTimeMs);
          if (totalLen > 0 && totalLen > stream.totalContentLength) {
            stream.totalContentLength = totalLen;
          }
        }
      } else if (part.type === 21 && part.data.byteLength > 1) {
        const [sid, headerSize] = readUmpVarInt(part.data, 0);
        const mediaData = part.data.subarray(headerSize);
        if (mediaData.byteLength === 0) continue;
        const info = streamIdMap.get(sid);
        if (!info) continue;
        const stream = getStream(info.itag);
        const detection = detectInitSegment(mediaData);
        if (detection.isInit) {
          if (!stream.initSegment) {
            stream.initSegment = new Uint8Array(mediaData);
            console.log(
              `${TAG} [itag=${info.itag}] Init segment: ${mediaData.byteLength} bytes (format=${detection.format})`,
            );
          }
        } else {
          if (!stream.segmentBlocks.has(info.segmentId)) {
            stream.segmentBlocks.set(info.segmentId, new Map());
            stream.blockTotalLen.set(info.segmentId, info.totalLen);
            stream.blockSealedInResponse.set(info.segmentId, responseIdx);
          } else if (info.totalLen > 0) {
            const existing = stream.blockTotalLen.get(info.segmentId) || 0;
            if (existing === 0 || info.totalLen > existing) {
              stream.blockTotalLen.set(info.segmentId, info.totalLen);
            }
          }
          const openedAt = stream.blockSealedInResponse.get(info.segmentId);
          if (openedAt !== undefined && openedAt !== responseIdx) {
            streamRunningOffset.set(
              sid,
              (streamRunningOffset.get(sid) || 0) + mediaData.byteLength,
            );
            continue;
          }
          const block = stream.segmentBlocks.get(info.segmentId);
          if (!block) continue;
          const blockLen = stream.blockTotalLen.get(info.segmentId) || 0;
          let bytesHave = 0;
          for (const data of block.values()) bytesHave += data.byteLength;
          if (blockLen > 0 && bytesHave >= blockLen) {
            streamRunningOffset.set(
              sid,
              (streamRunningOffset.get(sid) || 0) + mediaData.byteLength,
            );
            continue;
          }
          const currentOffset = streamRunningOffset.get(sid) || 0;
          if (!block.has(currentOffset)) {
            block.set(currentOffset, new Uint8Array(mediaData));
          }
          streamRunningOffset.set(sid, currentOffset + mediaData.byteLength);
        }
      }
    }
  }

  try {
    // Phase 1 — replay every captured body verbatim.
    for (let i = 0; i < bodiesToReplay.length; i++) {
      if (abortController.signal.aborted) {
        throw new Error("NETWORK_TIMEOUT");
      }
      try {
        const urlWithRn = sabrUrl + `&rn=${i + 1}&alr=yes`;
        const resp = await fetch(urlWithRn, {
          method: "POST",
          body: bodiesToReplay[i] as BodyInit,
          signal: abortController.signal,
        });
        if (!resp.ok) {
          console.log(`${TAG} Request ${i + 1}: HTTP ${resp.status}`);
          continue;
        }
        const rawBuf = new Uint8Array(await resp.arrayBuffer());
        if (rawBuf.byteLength < 50) continue;
        ingestUmpResponse(rawBuf, i);
        emitProgress();
      } catch (err) {
        const e = err as Error;
        if (e.name === "AbortError" || e.message === "NETWORK_TIMEOUT") {
          throw new Error("NETWORK_TIMEOUT");
        }
        console.error(`${TAG} Request ${i + 1} error:`, err);
      }
    }

    // Phase 2 — direct gap-fill replay for missing time slots.
    const durationSec = globalThis.__ytVideoDurationSec;
    const durationMs =
      typeof durationSec === "number" && durationSec > 0
        ? Math.ceil(durationSec * 1000)
        : 0;
    if (durationMs > 0 && bodiesToReplay.length > 0) {
      const haveBlockCovering = (itag: number, targetMs: number): boolean => {
        const s = streams.get(itag);
        if (!s) return false;
        for (const id of s.segmentBlocks.keys()) {
          const t = s.blockTimeMs.get(id) || 0;
          if (t >= targetMs - 9000 && t <= targetMs + 1000) return true;
        }
        return false;
      };

      const VIDEO_STEP_MS = 5000;
      const AUDIO_STEP_MS = 10000;
      const dataTemplate =
        bodiesToReplay.find((b) =>
          bodyHasField3(b instanceof Uint8Array ? b : new Uint8Array(b)),
        ) || bodiesToReplay[0];
      const dataTemplateBytes =
        dataTemplate instanceof Uint8Array
          ? dataTemplate
          : new Uint8Array(dataTemplate);

      const directBodies: Uint8Array[] = [];
      let seq = bodiesToReplay.length + 1;
      for (let t = 0; t < durationMs; t += VIDEO_STEP_MS) {
        if (haveBlockCovering(videoStream.itag, t)) continue;
        directBodies.push(
          buildVideoSabrBody(
            dataTemplateBytes,
            { itag: videoStream.itag, lmt: videoStream.lmt },
            seq++,
            t,
          ),
        );
      }
      for (let t = 0; t < durationMs; t += AUDIO_STEP_MS) {
        if (haveBlockCovering(audioStream.itag, t)) continue;
        directBodies.push(
          buildAudioSabrBody(
            dataTemplateBytes,
            { itag: audioStream.itag, lmt: audioStream.lmt },
            seq++,
            t,
          ),
        );
      }

      if (directBodies.length > 0) {
        console.log(
          `${TAG} Direct replay: ${directBodies.length} requests for missing time ranges (durationMs=${durationMs})`,
        );
        const baseIndex = bodiesToReplay.length;
        bodiesToReplay = [...bodiesToReplay, ...directBodies];
        for (let i = baseIndex; i < bodiesToReplay.length; i++) {
          if (abortController.signal.aborted) throw new Error("NETWORK_TIMEOUT");
          try {
            const urlWithRn = sabrUrl + `&rn=${i + 1}&alr=yes`;
            const resp = await fetch(urlWithRn, {
              method: "POST",
              body: bodiesToReplay[i] as BodyInit,
              signal: abortController.signal,
            });
            if (!resp.ok) {
              console.log(`${TAG} Direct rn=${i + 1}: HTTP ${resp.status}`);
              continue;
            }
            const rawBuf = new Uint8Array(await resp.arrayBuffer());
            if (rawBuf.byteLength < 50) continue;
            ingestUmpResponse(rawBuf, i);
            emitProgress();
          } catch (err) {
            const e = err as Error;
            if (e.name === "AbortError" || e.message === "NETWORK_TIMEOUT") {
              throw e;
            }
            console.error(`${TAG} Direct rn=${i + 1} error:`, e?.message || err);
          }
        }
        console.log(`${TAG} Direct replay complete`);
      }
    }

    // ─── Selection ──────────────────────────────────────────────────────────
    console.log(`${TAG} Collected streams:`);
    for (const [itag, s] of streams) {
      let totalBytes = 0;
      let segCount = 0;
      let blocksWithoutTotalLen = 0;
      let blocksOverflowing = 0;
      for (const [segId, block] of s.segmentBlocks) {
        let blockBytes = 0;
        for (const data of block.values()) {
          blockBytes += data.byteLength;
          segCount++;
        }
        totalBytes += blockBytes;
        const expected = s.blockTotalLen.get(segId) || 0;
        if (expected === 0) blocksWithoutTotalLen++;
        else if (blockBytes > expected * 1.05) blocksOverflowing++;
      }
      console.log(
        `  itag=${itag}: ${segCount} chunks in ${s.segmentBlocks.size} blocks, ${(totalBytes / 1024 / 1024).toFixed(2)}MB, init=${!!s.initSegment}, totalContentLength=${s.totalContentLength}, blocks-without-totalLen=${blocksWithoutTotalLen}, overflowing-blocks=${blocksOverflowing}`,
      );
    }

    const KNOWN_AUDIO = new Set([140, 249, 250, 251]);

    // Audio selection — prefer iTag preference, then largest maxTime.
    let bestAudioStream: StreamState | null = null;
    {
      const audioCandidates: {
        stream: StreamState;
        itag: number;
        coverage: CoverageStats;
      }[] = [];
      for (const [itag, s] of streams) {
        if (!s.initSegment || !KNOWN_AUDIO.has(itag)) continue;
        audioCandidates.push({ stream: s, itag, coverage: coverageStats(s) });
      }
      audioCandidates.sort((a, b) => {
        const prefA = AUDIO_ITAG_PREFERENCE.indexOf(a.itag);
        const prefB = AUDIO_ITAG_PREFERENCE.indexOf(b.itag);
        const pA = prefA === -1 ? 999 : prefA;
        const pB = prefB === -1 ? 999 : prefB;
        if (pA !== pB) return pA - pB;
        return b.coverage.maxTimeMs - a.coverage.maxTimeMs;
      });
      if (audioCandidates.length > 0) bestAudioStream = audioCandidates[0].stream;
    }

    // Video selection — prefer "complete" (≥90% coverage, no big gaps),
    // then fall back to "best contiguous" (mp4 wins ties).
    let bestVideoStream: StreamState | null = null;
    {
      const videoCandidates: {
        stream: StreamState;
        itag: number;
        format: "mp4" | "webm" | null;
        coverage: CoverageStats;
      }[] = [];
      for (const [itag, s] of streams) {
        if (!s.initSegment || KNOWN_AUDIO.has(itag)) continue;
        videoCandidates.push({
          stream: s,
          itag,
          format: streamFormat(s),
          coverage: coverageStats(s),
        });
      }
      console.log(`${TAG} Video candidates:`);
      for (const c of videoCandidates) {
        console.log(
          `  itag=${c.itag} format=${c.format} blocks=${c.coverage.blockCount} maxTime=${(c.coverage.maxTimeMs / 1000).toFixed(1)}s largestGap=${(c.coverage.largestGapMs / 1000).toFixed(1)}s contiguous=${(c.coverage.contiguousMs / 1000).toFixed(1)}s ${(c.coverage.totalBytes / 1024 / 1024).toFixed(1)}MB`,
        );
      }
      const globalMaxTimeMs = videoCandidates.reduce(
        (m, c) => Math.max(m, c.coverage.maxTimeMs),
        0,
      );
      const COVERAGE_THRESHOLD_FRACTION = 0.9;
      const isComplete = (c: { coverage: CoverageStats }): boolean => {
        if (c.coverage.blockCount === 0) return false;
        if (c.coverage.largestGapMs > 11_000) return false;
        if (
          globalMaxTimeMs > 0 &&
          c.coverage.maxTimeMs < globalMaxTimeMs * COVERAGE_THRESHOLD_FRACTION
        ) {
          return false;
        }
        return true;
      };
      const completeCands = videoCandidates.filter(isComplete);
      const incompleteCands = videoCandidates.filter((c) => !isComplete(c));
      const pickByQuality = (
        cands: typeof videoCandidates,
      ): (typeof videoCandidates)[number] | null => {
        if (cands.length === 0) return null;
        const mp4s = cands.filter((c) => c.format === "mp4");
        const pool = mp4s.length > 0 ? mp4s : cands;
        return pool
          .slice()
          .sort((a, b) => {
            if (b.coverage.blockCount !== a.coverage.blockCount) {
              return b.coverage.blockCount - a.coverage.blockCount;
            }
            return b.coverage.totalBytes - a.coverage.totalBytes;
          })[0];
      };
      const pickByCoverage = (
        cands: typeof videoCandidates,
      ): (typeof videoCandidates)[number] | null => {
        if (cands.length === 0) return null;
        const mp4s = cands.filter((c) => c.format === "mp4");
        const webms = cands.filter((c) => c.format === "webm");
        const bestMp4 = mp4s
          .slice()
          .sort((a, b) => b.coverage.contiguousMs - a.coverage.contiguousMs)[0];
        const bestWebm = webms
          .slice()
          .sort((a, b) => b.coverage.contiguousMs - a.coverage.contiguousMs)[0];
        if (bestMp4 && bestWebm) {
          if (bestMp4.coverage.contiguousMs >= bestWebm.coverage.contiguousMs * 0.8)
            return bestMp4;
          return bestWebm;
        }
        return bestMp4 || bestWebm || null;
      };
      const chosen = pickByQuality(completeCands) || pickByCoverage(incompleteCands);
      if (chosen) bestVideoStream = chosen.stream;
    }

    if (!bestVideoStream) {
      return {
        success: false,
        error: `No video stream with init segment received. Captured itags: ${Array.from(streams.keys()).join(",")}`,
      };
    }
    if (!bestAudioStream) {
      return {
        success: false,
        error: `No audio stream with init segment received. Captured itags: ${Array.from(streams.keys()).join(",")}`,
      };
    }

    const videoData = assembleStreamFromSegments(bestVideoStream);
    const audioData = assembleStreamFromSegments(bestAudioStream);
    const videoFormat = bestVideoStream.initSegment
      ? detectInitSegment(bestVideoStream.initSegment).format
      : null;
    const audioFormat = bestAudioStream.initSegment
      ? detectInitSegment(bestAudioStream.initSegment).format
      : null;
    console.log(
      `${TAG} Assembled: video itag=${bestVideoStream.itag} format=${videoFormat} ${(videoData.byteLength / 1024 / 1024).toFixed(2)}MB, audio itag=${bestAudioStream.itag} format=${audioFormat} ${(audioData.byteLength / 1024 / 1024).toFixed(2)}MB`,
    );

    try {
      const result = await muxToMp4(videoData, audioData);
      if (result.success) {
        console.log(
          `${TAG} mediabunny mux ok: ${(result.data.byteLength / 1024 / 1024).toFixed(2)} MB`,
        );
        return {
          success: true,
          data: result.data,
          totalSize: result.data.byteLength,
        };
      }
      console.error(`${TAG} mediabunny mux failed: ${result.error}`);
      return { success: false, error: `Не удалось собрать MP4: ${result.error}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${TAG} mediabunny mux threw: ${msg}`, err);
      return { success: false, error: `Не удалось собрать MP4: ${msg}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Video download failed: ${msg}` };
  }
}
