// YouTube video id extractor.
//
// Supports the three URL shapes that yt-content matches and that cobalt
// accepts as input:
//   - https://www.youtube.com/watch?v=ID...
//   - https://youtu.be/ID...
//   - https://www.youtube.com/shorts/ID...
//
// YouTube video ids are exactly 11 characters from the [A-Za-z0-9_-] alphabet.

const VIDEO_ID_REGEX = /(?:[?&]v=|\/shorts\/|youtu\.be\/)([A-Za-z0-9_-]{11})/;

/**
 * Pull the 11-character YouTube video id out of a watch / shorts / youtu.be
 * URL. Returns null for empty, malformed, or unsupported URLs.
 */
export function extractVideoId(url: string): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const match = VIDEO_ID_REGEX.exec(url);
  if (match === null) return null;
  return match[1] ?? null;
}
