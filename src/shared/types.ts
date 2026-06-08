// Shared types for yandex-music-downloader Chrome Extension

// ─── Service identifiers ──────────────────────────────────────────────────────

export type ServiceId = "yandex-music" | "vk" | "youtube" | "spotify";

// ─── Audio format ─────────────────────────────────────────────────────────────

export type AudioFormat = "mp3" | "flac" | "wav";

// ─── Format preferences ──────────────────────────────────────────────────────

export interface FormatPreferences {
  singleTrackFormat: AudioFormat;
  bulkFormat: AudioFormat;
}

// ─── Format resolution ───────────────────────────────────────────────────────

export interface DownloadInfoEntry {
  codec: string;
  bitrateInKbps: number;
  preview: boolean;
  downloadInfoUrl: string;
  /** Уже подписанный URL аудио (только для записей из /get-file-info). */
  directUrl?: string;
}

export interface ResolvedFormat {
  /** The entry selected for download. */
  entry: DownloadInfoEntry;
  /** The actual output format (may differ from preferred if fallback occurred). */
  outputFormat: AudioFormat;
  /** Whether a fallback was applied. */
  fellBack: boolean;
  /** Human-readable fallback reason, if any. */
  fallbackReason?: string;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

export interface CacheEntry {
  url: string;
  trackId: string;
  bitrateInKbps: number;
  codec: "mp3" | "aac" | "unknown";
  timestamp: number;
}

// ─── Track metadata ───────────────────────────────────────────────────────────

export interface TrackMeta {
  trackId: string;
  artist: string;
  title: string;
}

// ─── Filename ─────────────────────────────────────────────────────────────────

export interface FilenameParams {
  artist: string;
  title: string;
  codec: "mp3" | "aac" | "flac" | "wav";
  trackId?: string;
}

// ─── Button state ─────────────────────────────────────────────────────────────

export type ButtonState = "idle" | "loading" | "active" | "error" | "disabled";

export interface ButtonStateConfig {
  state: ButtonState;
  label: string;
  errorMessage?: string;
  clickable: boolean;
}

// ─── Message types ────────────────────────────────────────────────────────────

export type MessageType =
  | "GET_DOWNLOAD_URL"
  | "START_DOWNLOAD"
  | "TRACK_CHANGED";

export interface GetDownloadURLMessage {
  type: "GET_DOWNLOAD_URL";
  payload: { trackId: string };
}

export interface StartDownloadMessage {
  type: "START_DOWNLOAD";
  payload: {
    url: string;
    artist: string;
    title: string;
    codec: "mp3" | "aac";
  };
}

export interface TrackChangedMessage {
  type: "TRACK_CHANGED";
  payload: { previousTrackId: string };
}

// ─── Service Worker responses ─────────────────────────────────────────────────

export interface SuccessResponse {
  success: true;
  url: string;
  bitrateInKbps: number;
  codec: "mp3" | "aac";
  /**
   * Identifier returned by `chrome.downloads.download()` when the SW performs
   * the download itself (DOWNLOAD_BY_INPUT and DOWNLOAD_TRACK). Present iff
   * the SW called `chrome.downloads.download()` and it resolved with a
   * numeric id. Absent for legacy responses that delegate the actual save
   * to the content script.
   */
  downloadId?: number;
}

/**
 * Stable error codes returned to content scripts.
 *
 * Yandex/VK use the original 5 codes; YouTube cobalt + fallback path adds
 * COBALT_ERROR / DOWNLOAD_FAILED / INVALID_REQUEST / NO_SUITABLE_QUALITY.
 */
export type ErrorCode =
  | "AUTH_REQUIRED"
  | "DRM_PROTECTED"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "API_ERROR"
  | "COBALT_ERROR"
  | "DOWNLOAD_FAILED"
  | "INVALID_REQUEST"
  | "NO_SUITABLE_QUALITY";

export interface ErrorResponse {
  success: false;
  reason: string;
  errorCode?: ErrorCode;
}

export type ServiceWorkerResponse = SuccessResponse | ErrorResponse;

// ─── YouTube download messages ───────────────────────────────────────────────

export interface YtDownloadVideoMessage {
  type: "YT_DOWNLOAD_VIDEO";
  payload: {
    videoId: string;
    url: string;
    title: string;
  };
}

export interface YtDownloadProgressMessage {
  type: "YT_DOWNLOAD_PROGRESS";
  payload: {
    videoId: string;
    /** 0..100, undefined when Content-Length is unknown. */
    pct?: number;
    phase: "request" | "download" | "mux";
  };
}

export interface YtDownloadVideoResponse {
  success: boolean;
  errorCode?: ErrorCode;
  reason?: string;
  filename?: string;
  downloadId?: number;
}

// ─── Yandex API ───────────────────────────────────────────────────────────────

export interface YandexDownloadInfoResponse {
  result: Array<{
    downloadInfoUrl: string;
    codec: string;
    bitrateInKbps: number;
    gain: boolean;
    preview: boolean;
  }>;
}

// ─── VK types ─────────────────────────────────────────────────────────────────

export interface VkTrackMeta {
  ownerId: string;
  audioId: string;
  artist: string;
  title: string;
  encryptedUrl?: string;
  /** VK accessKey for the audio. Required for tracks NOT in user's "My music"
   *  (e.g. recommendations / artist tracks / search) — without it, al_audio.php
   *  refuses to return the URL. Comes from data-audio[24] when present. */
  accessKey?: string;
}

export interface VkDownloadTrackMessage {
  type: "VK_DOWNLOAD_TRACK";
  payload: VkTrackMeta;
}

export interface VkDownloadPlaylistMessage {
  type: "VK_DOWNLOAD_PLAYLIST";
  payload: {
    tracks: VkTrackMeta[];
    playlistTitle: string;
  };
}

export interface VkDownloadResponse {
  success: boolean;
  downloadId?: number;
  audioDataB64?: string;
  filename?: string;
  reason?: string;
  errorCode?: VkErrorCode;
  actualFormat?: string;
  fallbackReason?: string;
  progress?: { downloaded: number; total: number; skipped: number };
  strategy?: "direct" | "hls_demux";
}

export type VkErrorCode =
  | "VK_AUTH_REQUIRED"
  | "VK_NOT_LOGGED_IN"
  | "VK_SESSION_EXPIRED"
  | "VK_RATE_LIMITED"
  | "VK_TIMEOUT"
  | "VK_URL_NOT_FOUND"
  | "VK_TRACK_UNAVAILABLE"
  | "VK_NETWORK_ERROR";
