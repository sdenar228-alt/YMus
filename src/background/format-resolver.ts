import type { AudioFormat, DownloadInfoEntry, ResolvedFormat } from "../shared/types";

/**
 * Error thrown when all available entries are preview-only (or none exist).
 */
export class PreviewOnlyError extends Error {
  constructor() {
    super("No non-preview entries available");
    this.name = "PreviewOnlyError";
  }
}

/**
 * Pick the highest-bitrate non-preview entry matching the given codec.
 * Returns undefined if no matching entry exists.
 */
function pickBestByCodec(
  entries: DownloadInfoEntry[],
  codec: string,
): DownloadInfoEntry | undefined {
  let best: DownloadInfoEntry | undefined;
  for (const entry of entries) {
    if (entry.preview) continue;
    if (entry.codec !== codec) continue;
    if (!best || entry.bitrateInKbps > best.bitrateInKbps) {
      best = entry;
    }
  }
  return best;
}

/**
 * Select the best download-info entry for the given preferred format.
 *
 * Rules:
 * - "mp3": pick highest-bitrate non-preview MP3 entry.
 * - "flac": pick highest-bitrate non-preview FLAC entry; fall back to best MP3.
 * - "wav": pick best source for conversion (FLAC preferred, then MP3).
 *
 * Throws PreviewOnlyError if no non-preview entries exist at all.
 */
export function resolveFormat(
  entries: DownloadInfoEntry[],
  preferredFormat: AudioFormat,
): ResolvedFormat {
  // Check if any non-preview entries exist at all
  const hasNonPreview = entries.some((e) => !e.preview);
  if (!hasNonPreview) {
    throw new PreviewOnlyError();
  }

  switch (preferredFormat) {
    case "mp3": {
      const best = pickBestByCodec(entries, "mp3");
      if (best) {
        return { entry: best, outputFormat: "mp3", fellBack: false };
      }
      // MP3 should always be available if non-preview entries exist,
      // but handle edge case: fall back to any non-preview entry
      const anyNonPreview = entries.find((e) => !e.preview)!;
      return {
        entry: anyNonPreview,
        outputFormat: anyNonPreview.codec as AudioFormat,
        fellBack: true,
        fallbackReason: "MP3 недоступен, использован альтернативный формат",
      };
    }

    case "flac": {
      const bestFlac = pickBestByCodec(entries, "flac");
      if (bestFlac) {
        return { entry: bestFlac, outputFormat: "flac", fellBack: false };
      }
      // Настоящего FLAC нет (Я.Музыка веб-API не отдаёт lossless для большинства
      // треков). Берём лучший MP3 как источник — message-router перепакует его
      // в FLAC-контейнер через libflac. Считаем outputFormat=flac, fellBack=false,
      // потому что пользователь получит .flac файл (даже если lossy внутри).
      const bestMp3 = pickBestByCodec(entries, "mp3");
      if (bestMp3) {
        return { entry: bestMp3, outputFormat: "flac", fellBack: false };
      }
      // No FLAC or MP3 — pick any non-preview entry as source for repacking.
      const anyEntry = entries.find((e) => !e.preview)!;
      return { entry: anyEntry, outputFormat: "flac", fellBack: false };
    }

    case "wav": {
      // For WAV, we need a source to convert from. Prefer FLAC, then MP3.
      const bestFlac = pickBestByCodec(entries, "flac");
      if (bestFlac) {
        return { entry: bestFlac, outputFormat: "wav", fellBack: false };
      }
      const bestMp3 = pickBestByCodec(entries, "mp3");
      if (bestMp3) {
        return { entry: bestMp3, outputFormat: "wav", fellBack: false };
      }
      // No FLAC or MP3 — pick any non-preview entry as source
      const anyEntry = entries.find((e) => !e.preview)!;
      return { entry: anyEntry, outputFormat: "wav", fellBack: false };
    }

    default: {
      // Treat unknown format as mp3
      const best = pickBestByCodec(entries, "mp3");
      if (best) {
        return { entry: best, outputFormat: "mp3", fellBack: false };
      }
      const anyNonPreview = entries.find((e) => !e.preview)!;
      return {
        entry: anyNonPreview,
        outputFormat: anyNonPreview.codec as AudioFormat,
        fellBack: true,
        fallbackReason: "Формат недоступен, использован альтернативный",
      };
    }
  }
}
