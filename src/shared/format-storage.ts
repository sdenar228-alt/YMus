import type { AudioFormat, FormatPreferences } from "./types";

// ─── Per-service storage support ─────────────────────────────────────────────

export type FormatStorageService = "yandex-music" | "vk" | "spotify";

const STORAGE_KEYS: Record<FormatStorageService, string> = {
  "yandex-music": "ymd_format_prefs",
  "vk": "vk_format_prefs",
  "spotify": "spotify_format_prefs",
};

// ─── Legacy single-service key (backward compat) ─────────────────────────────

const STORAGE_KEY = "ymd_format_prefs";

const VALID_FORMATS: readonly AudioFormat[] = ["mp3", "flac", "wav"];

const DEFAULT_PREFS: FormatPreferences = {
  singleTrackFormat: "mp3",
  bulkFormat: "mp3",
};

function isValidFormat(value: unknown): value is AudioFormat {
  return typeof value === "string" && VALID_FORMATS.includes(value as AudioFormat);
}

function validatePreferences(raw: unknown): FormatPreferences {
  if (raw == null || typeof raw !== "object") {
    return { ...DEFAULT_PREFS };
  }

  const obj = raw as Record<string, unknown>;

  return {
    singleTrackFormat: isValidFormat(obj.singleTrackFormat)
      ? obj.singleTrackFormat
      : "mp3",
    bulkFormat: isValidFormat(obj.bulkFormat) ? obj.bulkFormat : "mp3",
  };
}

/** Load format preferences from chrome.storage.local. Returns defaults if not set. */
export async function getFormatPreferences(): Promise<FormatPreferences> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return validatePreferences(result[STORAGE_KEY]);
}

/** Save format preferences to chrome.storage.local (supports partial updates). */
export async function setFormatPreferences(
  prefs: Partial<FormatPreferences>,
): Promise<void> {
  const current = await getFormatPreferences();

  const updated: FormatPreferences = {
    singleTrackFormat: isValidFormat(prefs.singleTrackFormat)
      ? prefs.singleTrackFormat
      : current.singleTrackFormat,
    bulkFormat: isValidFormat(prefs.bulkFormat)
      ? prefs.bulkFormat
      : current.bulkFormat,
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: updated });
}


// ─── Per-service format preferences ──────────────────────────────────────────

/** Load format preferences for a specific service. Returns defaults if not set. */
export async function getServiceFormatPreferences(
  service: FormatStorageService,
): Promise<FormatPreferences> {
  const key = STORAGE_KEYS[service];
  const result = await chrome.storage.local.get(key);
  return validatePreferences(result[key]);
}

/** Save format preferences for a specific service (supports partial updates). */
export async function setServiceFormatPreferences(
  service: FormatStorageService,
  prefs: Partial<FormatPreferences>,
): Promise<void> {
  const key = STORAGE_KEYS[service];
  const current = await getServiceFormatPreferences(service);

  const updated: FormatPreferences = {
    singleTrackFormat: isValidFormat(prefs.singleTrackFormat)
      ? prefs.singleTrackFormat
      : current.singleTrackFormat,
    bulkFormat: isValidFormat(prefs.bulkFormat)
      ? prefs.bulkFormat
      : current.bulkFormat,
  };

  await chrome.storage.local.set({ [key]: updated });
}
