// Helper for constructing the popup status message when a format fallback
// occurred during a single-track download (Requirements 6.1, 6.3, 6.4).

import type { AudioFormat } from "../shared/types";

/**
 * Build the popup status message describing why the actual download format
 * differs from the user's preferred format.
 *
 * - FLAC → MP3: "FLAC недоступен для этого трека, скачан в MP3" (Requirement 6.1)
 * - WAV → other format (conversion failed): "Конвертация в WAV не удалась,
 *   скачан в {format}" (Requirement 6.4)
 * - Other unexpected fallbacks: prefer the reason returned by the Service
 *   Worker; fall back to a generic message.
 *
 * Callers MUST only invoke this when an actual fallback occurred (i.e.
 * `preferred !== actual`). When the download produced the preferred format,
 * no notification SHALL be shown (Requirement 6.3).
 */
export function buildFallbackMessage(
  preferred: AudioFormat,
  actual: AudioFormat,
  reasonFromWorker: string | undefined,
): string {
  if (preferred === "flac" && actual === "mp3") {
    return "FLAC недоступен для этого трека, скачан в MP3";
  }
  if (preferred === "wav" && actual !== "wav") {
    return `Конвертация в WAV не удалась, скачан в ${actual.toUpperCase()}`;
  }
  if (reasonFromWorker !== undefined && reasonFromWorker.length > 0) {
    return reasonFromWorker;
  }
  return `Скачан в ${actual.toUpperCase()} вместо ${preferred.toUpperCase()}`;
}
