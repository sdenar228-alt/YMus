// VK-specific filename builder.
// Validates: Requirements 11.1, 11.2, 11.3, 11.4

export interface VkFilenameParams {
  artist: string;
  title: string;
  ownerId: string;
  audioId: string;
  ext: "mp3" | "flac" | "wav";
}

// Characters illegal in filenames on Windows / common file systems.
const FORBIDDEN_CHARS_REGEX = /[\\/:*?"<>|]/g;

// Maximum length of the name part (without extension).
const MAX_NAME_LENGTH = 200;

/**
 * Build filename for VK audio download.
 * Template: "{artist} - {title}.{ext}"
 * Forbidden chars (\ / : * ? " < > |) replaced with "_"
 * Name truncated to 200 chars (without extension)
 * Fallback: "vk_audio_{ownerId}_{audioId}.{ext}" when artist+title are both empty or "Unknown"
 */
export function buildVkFilename(params: VkFilenameParams): string {
  const { artist, title, ownerId, audioId, ext } = params;

  const artistTrimmed = artist.trim();
  const titleTrimmed = title.trim();

  const artistEmpty =
    artistTrimmed === "" || artistTrimmed.toLowerCase() === "unknown";
  const titleEmpty =
    titleTrimmed === "" || titleTrimmed.toLowerCase() === "unknown";

  // Fallback when both artist and title are empty/Unknown
  if (artistEmpty && titleEmpty) {
    return `vk_audio_${ownerId}_${audioId}.${ext}`;
  }

  const sanitizedArtist = artistTrimmed.replace(FORBIDDEN_CHARS_REGEX, "_");
  const sanitizedTitle = titleTrimmed.replace(FORBIDDEN_CHARS_REGEX, "_");

  const rawName = `${sanitizedArtist} - ${sanitizedTitle}`;
  const truncatedName =
    rawName.length > MAX_NAME_LENGTH
      ? rawName.slice(0, MAX_NAME_LENGTH)
      : rawName;

  return `${truncatedName}.${ext}`;
}
