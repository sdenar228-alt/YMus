// YouTube-specific filename builder.
// Validates: Requirements 5.3, 5.6

// Characters illegal in filenames on Windows / common file systems.
const FORBIDDEN_CHARS_REGEX = /[\\/:*?"<>|]/g;

// Maximum length of the name part (without extension).
const MAX_NAME_LENGTH = 200;

/**
 * Build safe filename from YouTube video title.
 * Forbidden chars (\ / : * ? " < > |) replaced with "_".
 * Name truncated to 200 chars (without .mp4 extension).
 * Returns "Unknown" if title is empty or whitespace-only.
 */
export function buildYtFilename(title: string): string {
  const trimmed = title.trim();

  if (trimmed === "") {
    return "Unknown";
  }

  const sanitized = trimmed.replace(FORBIDDEN_CHARS_REGEX, "_");
  const truncated =
    sanitized.length > MAX_NAME_LENGTH
      ? sanitized.slice(0, MAX_NAME_LENGTH)
      : sanitized;

  return truncated;
}
