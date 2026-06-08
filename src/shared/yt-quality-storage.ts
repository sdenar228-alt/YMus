// YouTube quality preference storage helpers.
//
// Reads the user's preferred YouTube download quality from
// `chrome.storage.local["ytPreferredQuality"]`. Used by the buffer-capture
// pipeline (and the popup UI which writes the same key) to drive the
// page-bridge `SET_QUALITY` round-trip before `forceFullBuffer()` runs.
//
// Moved out of `src/background/yt-download-manager.ts` (which has been
// deleted along with the rest of the cobalt path) so the helper can be
// shared across background and content scripts without dragging the
// orchestrator surface back in.

// ─── Public Types ────────────────────────────────────────────────────────────

export type QualityLevel = "480p" | "720p" | "1080p" | "2K" | "4K";

export const QUALITY_ORDER: Record<QualityLevel, number> = {
  "480p": 480,
  "720p": 720,
  "1080p": 1080,
  "2K": 1440,
  "4K": 2160,
};

const VALID_QUALITY_LEVELS: QualityLevel[] = [
  "480p",
  "720p",
  "1080p",
  "2K",
  "4K",
];

// ─── Preferred Quality Storage ───────────────────────────────────────────────

/**
 * Reads preferred quality from chrome.storage.local.
 * Falls back to "1080p" for invalid or missing values.
 */
export async function getPreferredQuality(): Promise<QualityLevel> {
  try {
    const result = await chrome.storage.local.get("ytPreferredQuality");
    const stored = result.ytPreferredQuality;

    if (isValidQualityLevel(stored)) {
      return stored;
    }
  } catch {
    // Storage access failed — use default
  }

  return "1080p";
}

/**
 * Type guard: checks if a value is a valid QualityLevel.
 */
export function isValidQualityLevel(value: unknown): value is QualityLevel {
  return (
    typeof value === "string" &&
    VALID_QUALITY_LEVELS.includes(value as QualityLevel)
  );
}
