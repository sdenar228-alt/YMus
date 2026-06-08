// Filename construction for downloaded tracks.
// Implements rules described in Requirements 4.2, 4.3, 4.4 (legacy MP3 numbering)
// and Requirements 5.1, 5.2, 5.3, 5.7 (format-selection: flac/wav extensions).

import type { FilenameParams } from "./types";

// Characters that are illegal in file names on Windows / common file systems.
// Requirement 4.3: replace each occurrence with "_".
const FORBIDDEN_CHARS_REGEX = /[\\/:*?"<>|]/g;

// Requirement 4.4 / 5.7: maximum length of the name part (without extension).
const MAX_NAME_LENGTH = 200;

// Placeholder substituted when a component is missing (Requirement 4.2).
const UNKNOWN_PLACEHOLDER = "Unknown";
const UUID_LIKE_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sanitize a single name component (artist or title).
 *
 * Steps:
 * 1. If the value is undefined, null or an empty/whitespace-only string —
 *    fall back to "Unknown" (Requirement 4.2).
 * 2. Replace every forbidden filesystem character with "_" (Requirement 4.3).
 */
function sanitizeComponent(value: string | undefined | null): string {
  if (value === undefined || value === null) {
    return UNKNOWN_PLACEHOLDER;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return UNKNOWN_PLACEHOLDER;
  }

  return trimmed.replace(FORBIDDEN_CHARS_REGEX, "_");
}

function isUnknownComponent(value: string): boolean {
  return value.trim().length === 0 || value.trim().toLowerCase() === UNKNOWN_PLACEHOLDER.toLowerCase();
}

function sanitizeTrackId(value: string | undefined): string {
  const id = (value ?? "").split(":")[0].trim();
  return id.replace(FORBIDDEN_CHARS_REGEX, "_").replace(/\s+/g, "_");
}

/**
 * Build a filesystem-safe filename for a downloaded track.
 *
 * Format: `${artist} - ${title}.${codec}`.
 * - Missing artist/title is replaced with "Unknown".
 * - Forbidden filesystem characters in artist/title are replaced with "_".
 * - The name part (without extension) is truncated to 200 characters
 *   before the extension is appended.
 * - The codec value ("mp3", "aac", "flac", "wav") is used directly as the
 *   file extension, producing ".mp3", ".aac", ".flac" or ".wav" respectively.
 *
 * Validates: Requirements 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.7.
 */
export function buildFilename(params: FilenameParams): string {
  const artist = sanitizeComponent(params.artist);
  const title = sanitizeComponent(params.title);

  let rawName = `${artist} - ${title}`;
  if (
    (isUnknownComponent(artist) && isUnknownComponent(title)) ||
    UUID_LIKE_REGEX.test(artist) ||
    UUID_LIKE_REGEX.test(title)
  ) {
    const fallbackId = sanitizeTrackId(params.trackId);
    rawName = fallbackId.length > 0 ? `YMus - track-${fallbackId}` : "YMus - download";
  }

  const truncatedName =
    rawName.length > MAX_NAME_LENGTH
      ? rawName.slice(0, MAX_NAME_LENGTH)
      : rawName;

  return `${truncatedName}.${params.codec}`;
}
