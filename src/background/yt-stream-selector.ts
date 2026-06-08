// Stream selector for SABR replay.
//
// Parses available audio/video streams from captured SABR request bodies
// (`chrome.webRequest.onBeforeRequest` saves the player's POST bodies)
// and picks the best video iTag for the user's preferred quality plus the
// best audio iTag from the AAC ladder.
//
// Ported verbatim from the legacy 22 May build's
// `src/background/yt-stream-selector.ts`.

/** Single stream descriptor — itag + last-modified timestamp. */
export interface Stream {
  itag: number;
  lmt: number;
}

/** Result of `parseAvailableStreams`. */
export interface AvailableStreams {
  audio: Stream[];
  video: Stream[];
}

/** AAC iTags ordered by descending preference. */
export const AUDIO_ITAG_PREFERENCE: readonly number[] = [140, 251, 250, 249];

/**
 * Per-tier video iTag preference. Each tier lists codecs in descending
 * compatibility order (H.264 → VP9 → AV1) so MP4 muxing has the best
 * chance of getting an `avc` track.
 */
export const VIDEO_ITAG_PREFERENCE: Readonly<Record<number, readonly number[]>> = {
  2160: [313, 401], // 4K: VP9, AV1 (no H.264 at 4K)
  1440: [271, 400], // 2K: VP9, AV1 (no H.264 at 1440p)
  1080: [137, 248, 399], // 1080p: H.264, VP9, AV1
  720: [136, 247, 398], // 720p:  H.264, VP9, AV1
  480: [135, 244, 397], // 480p:  H.264, VP9, AV1
};

/** Flat list of all known video iTags from highest to lowest tier. */
const ALL_VIDEO_ITAGS_DESCENDING: readonly number[] = [
  313, 401,           // 4K
  271, 400,           // 2K
  137, 248, 399,      // 1080p
  136, 247, 398,      // 720p
  135, 244, 397,      // 480p
];

/** Quality tiers in pixels, descending. */
const QUALITY_TIERS_DESCENDING: readonly number[] = [2160, 1440, 1080, 720, 480];

/** iTags treated as audio when the field-tag heuristic is ambiguous. */
const KNOWN_AUDIO_ITAGS: ReadonlySet<number> = new Set([140, 249, 250, 251]);

/**
 * Walk one or more captured SABR POST bodies and extract the available
 * `(itag, lmt)` tuples for both audio and video streams.
 *
 * The SABR proto (player → googlevideo) lists streams in repeated
 * length-delimited fields. Field numbers 16/17 enumerate audio and video
 * formats respectively; field 2/3 carry similar lists in older bodies.
 * Audio entries inline `{itag, lmt}`; video entries nest them inside a
 * sub-message at field 1.
 *
 * The classifier defers to KNOWN_AUDIO_ITAGS for fields 2/3 (where the
 * proto doesn't disambiguate) and trusts field 16/17 directly.
 */
export function parseAvailableStreams(
  bodies: ArrayBuffer[] | Uint8Array[],
): AvailableStreams {
  const audioMap = new Map<number, Stream>();
  const videoMap = new Map<number, Stream>();

  for (const body of bodies) {
    const buf = body instanceof Uint8Array ? body : new Uint8Array(body);
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
        if (
          (fieldNum === 2 || fieldNum === 3 || fieldNum === 16 || fieldNum === 17) &&
          len > 2 &&
          len < 100
        ) {
          const entryEnd = offset + len;
          let itag = 0,
            lmt = 0;
          let pos = offset;
          if (fieldNum === 3) {
            // Video: nested {itag, lmt} at field 1.
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
              if (fn === 1 && wt === 2) {
                let subLen = 0,
                  slShift = 0;
                while (pos < entryEnd) {
                  const b = buf[pos++];
                  subLen |= (b & 0x7f) << slShift;
                  if ((b & 0x80) === 0) break;
                  slShift += 7;
                }
                const subEnd = pos + subLen;
                while (pos < subEnd) {
                  let st = 0,
                    ss = 0;
                  while (pos < subEnd) {
                    const b = buf[pos++];
                    st |= (b & 0x7f) << ss;
                    if ((b & 0x80) === 0) break;
                    ss += 7;
                  }
                  const sfn = st >>> 3;
                  const swt = st & 0x07;
                  if (swt === 0) {
                    let val = 0,
                      vs = 0;
                    while (pos < subEnd) {
                      const b = buf[pos++];
                      val |= (b & 0x7f) << vs;
                      if ((b & 0x80) === 0) break;
                      vs += 7;
                    }
                    if (sfn === 1) itag = val >>> 0;
                    if (sfn === 2) lmt = val >>> 0;
                  } else break;
                }
                break;
              } else if (wt === 0) {
                while (pos < entryEnd && (buf[pos] & 0x80) !== 0) pos++;
                if (pos < entryEnd) pos++;
              } else if (wt === 2) {
                let skipLen = 0,
                  slShift2 = 0;
                while (pos < entryEnd) {
                  const b = buf[pos++];
                  skipLen |= (b & 0x7f) << slShift2;
                  if ((b & 0x80) === 0) break;
                  slShift2 += 7;
                }
                pos += skipLen;
              } else break;
            }
          } else {
            // Inline {itag, lmt} pair.
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
          }
          if (itag > 0 && lmt > 0) {
            const info: Stream = { itag, lmt };
            if (fieldNum === 16 || (fieldNum !== 17 && KNOWN_AUDIO_ITAGS.has(itag))) {
              audioMap.set(itag, info);
            } else if (fieldNum === 17 || !KNOWN_AUDIO_ITAGS.has(itag)) {
              videoMap.set(itag, info);
            }
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
  }

  return {
    audio: Array.from(audioMap.values()),
    video: Array.from(videoMap.values()),
  };
}

/** Pick the best audio stream from the AAC preference ladder. */
export function selectAudioStream(available: Stream[]): Stream | null {
  for (const preferredItag of AUDIO_ITAG_PREFERENCE) {
    const match = available.find((s) => s.itag === preferredItag);
    if (match) return match;
  }
  return null;
}

/**
 * Pick the best video stream for the user's preferred height. Walks the
 * preferred tier first (1080 → 720 → 480 → …), then climbs up if nothing
 * was found at or below. Final fallback is any known iTag, then any
 * stream that exists.
 */
export function selectVideoStream(
  available: Stream[],
  preferredHeight: number | undefined,
): Stream | null {
  const targetQuality = preferredHeight ?? 1080;
  const downIdx = QUALITY_TIERS_DESCENDING.findIndex((q) => q <= targetQuality);
  const startIdx =
    downIdx === -1 ? QUALITY_TIERS_DESCENDING.length - 1 : downIdx;
  // Walk down from the closest tier ≤ target.
  for (let i = startIdx; i < QUALITY_TIERS_DESCENDING.length; i++) {
    const result = selectFromTier(available, QUALITY_TIERS_DESCENDING[i]);
    if (result) return result;
  }
  // Then climb up through higher tiers.
  for (let i = startIdx - 1; i >= 0; i--) {
    const result = selectFromTier(available, QUALITY_TIERS_DESCENDING[i]);
    if (result) return result;
  }
  return selectAnyKnown(available);
}

function selectFromTier(available: Stream[], tier: number): Stream | null {
  const itags = VIDEO_ITAG_PREFERENCE[tier];
  if (!itags) return null;
  for (const preferredItag of itags) {
    const match = available.find((s) => s.itag === preferredItag);
    if (match) return match;
  }
  return null;
}

function selectAnyKnown(available: Stream[]): Stream | null {
  for (const itag of ALL_VIDEO_ITAGS_DESCENDING) {
    const match = available.find((s) => s.itag === itag);
    if (match) return match;
  }
  return available.length > 0 ? available[0] : null;
}

/**
 * Map a video iTag back to its quality label — used for response payloads.
 * Default `"720p"` is preserved from the legacy build.
 */
export function itagToQualityLevel(itag: number): "480p" | "720p" | "1080p" | "2K" | "4K" {
  if (itag === 313 || itag === 401) return "4K";
  if (itag === 271 || itag === 400) return "2K";
  if (itag === 137 || itag === 248 || itag === 399) return "1080p";
  if (itag === 136 || itag === 247 || itag === 398) return "720p";
  if (itag === 135 || itag === 244 || itag === 397) return "480p";
  return "720p";
}
