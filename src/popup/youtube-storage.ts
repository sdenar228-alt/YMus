export type VideoQuality = "480p" | "720p" | "1080p" | "2K" | "4K";
export type DownloadMode = "video" | "audio-only" | "video-audio";

export interface YouTubePreferences {
  quality: VideoQuality;
  downloadMode: DownloadMode;
}

const QUALITY_STORAGE_KEY = "ytPreferredQuality";
const MODE_STORAGE_KEY = "ytDownloadMode";
/** @deprecated kept for migration */
const LEGACY_STORAGE_KEY = "youtube_prefs";

const VALID_QUALITIES: readonly VideoQuality[] = ["480p", "720p", "1080p", "2K", "4K"];
const VALID_MODES: readonly DownloadMode[] = ["video", "audio-only", "video-audio"];

const DEFAULTS: YouTubePreferences = { quality: "1080p", downloadMode: "video" };

function isValidQuality(value: unknown): value is VideoQuality {
  return typeof value === "string" && VALID_QUALITIES.includes(value as VideoQuality);
}

function isValidMode(value: unknown): value is DownloadMode {
  return typeof value === "string" && VALID_MODES.includes(value as DownloadMode);
}

/** Load YouTube preferences from chrome.storage.local. Returns defaults if not set or invalid. */
export async function getYouTubePreferences(): Promise<YouTubePreferences> {
  const result = await chrome.storage.local.get([QUALITY_STORAGE_KEY, MODE_STORAGE_KEY, LEGACY_STORAGE_KEY]);

  // Migration: if new keys are absent but legacy key exists, migrate
  if (result[QUALITY_STORAGE_KEY] === undefined && result[LEGACY_STORAGE_KEY] != null) {
    const legacy = result[LEGACY_STORAGE_KEY] as Record<string, unknown> | undefined;
    if (legacy && typeof legacy === "object") {
      const quality = isValidQuality(legacy.quality) ? legacy.quality : DEFAULTS.quality;
      const downloadMode = isValidMode(legacy.downloadMode) ? legacy.downloadMode : DEFAULTS.downloadMode;
      // Persist under new keys and remove legacy
      await chrome.storage.local.set({
        [QUALITY_STORAGE_KEY]: quality,
        [MODE_STORAGE_KEY]: downloadMode,
      });
      await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
      return { quality, downloadMode };
    }
  }

  const quality = isValidQuality(result[QUALITY_STORAGE_KEY]) ? result[QUALITY_STORAGE_KEY] : DEFAULTS.quality;
  const downloadMode = isValidMode(result[MODE_STORAGE_KEY]) ? result[MODE_STORAGE_KEY] : DEFAULTS.downloadMode;

  return { quality, downloadMode };
}

/** Save YouTube preferences to chrome.storage.local (supports partial updates). */
export async function setYouTubePreferences(
  prefs: Partial<YouTubePreferences>,
): Promise<void> {
  const updates: Record<string, unknown> = {};

  if (prefs.quality !== undefined) {
    updates[QUALITY_STORAGE_KEY] = isValidQuality(prefs.quality) ? prefs.quality : undefined;
  }
  if (prefs.downloadMode !== undefined) {
    updates[MODE_STORAGE_KEY] = isValidMode(prefs.downloadMode) ? prefs.downloadMode : undefined;
  }

  // Only set valid values
  const toSet: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) toSet[key] = val;
  }

  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }
}
