// Folder name sanitization for playlist/album downloads.
// Implements rules described in Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6.

// Characters that are illegal in folder names on Windows / common file systems.
// Requirement 2.2: replace each occurrence with "_".
const FORBIDDEN_CHARS_REGEX = /[\\/:*?"<>|]/g;

// Requirement 2.4: maximum length of the folder name.
const MAX_FOLDER_LENGTH = 100;

// Requirement 2.5: fallback when the result is empty.
const DEFAULT_FOLDER_NAME = "Playlist";

// Requirement 2.6: reserved Windows device names (case-insensitive).
const RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/**
 * Sanitize a raw string for use as a folder name in the file system.
 *
 * Steps (strictly in order, Requirement 2.1):
 *  1. Replace forbidden characters [\/:*?"<>|] with "_"
 *  2. Trim leading/trailing whitespace
 *  3. Remove trailing dots
 *  4. Truncate to 100 characters
 *  5. Empty string → fallback "Playlist"
 *  6. Reserved Windows names → append "_"
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6.
 */
export function sanitizeFolderName(raw: string): string {
  // Step 1: Replace forbidden characters with "_".
  let result = raw.replace(FORBIDDEN_CHARS_REGEX, "_");

  // Step 2: Trim leading and trailing whitespace.
  result = result.trim();

  // Step 3: Remove trailing dots.
  result = result.replace(/\.+$/, "");

  // Step 4: Truncate to 100 characters.
  if (result.length > MAX_FOLDER_LENGTH) {
    result = result.slice(0, MAX_FOLDER_LENGTH);
  }

  // Step 5: Empty string → fallback "Playlist".
  if (result.length === 0) {
    return DEFAULT_FOLDER_NAME;
  }

  // Step 6: Reserved Windows names → append "_".
  if (RESERVED_NAMES.has(result.toUpperCase())) {
    result = result + "_";
  }

  return result;
}
