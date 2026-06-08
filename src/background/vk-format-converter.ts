// VK Format Converter — orchestrates MP3→FLAC/WAV conversion for VK tracks.
//
// VK serves audio exclusively as MP3 (direct URLs or HLS streams). This module
// converts the resulting MP3 buffer into the user's preferred format using the
// existing offscreen-bridge infrastructure.
//
// Design invariant: this function NEVER throws. On any conversion error it
// returns the original MP3 bytes with a `fallbackReason` explaining what failed.

import { AudioFormat } from "../shared/types";
import { bytesToBase64 } from "../shared/base64";
import { encodeMp3ToFlacInOffscreen, decodeAudioInOffscreen } from "./offscreen-bridge";
import { embedFlacMetadata } from "./flac-meta";
import { buildWavFile } from "./wav-meta";

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface VkTrackMetaForConversion {
  artist: string;
  title: string;
}

export interface VkConversionResult {
  /** Always true — the function never fails outright. */
  success: true;
  /** Converted (or original) audio data as base64. */
  audioDataB64: string;
  /** Actual file extension of the returned audio. */
  ext: "mp3" | "flac" | "wav";
  /** Set when the actual format differs from requested (fallback to MP3). */
  fallbackReason?: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Detect audio MIME type from first bytes.
 * MP3: starts with 0xFF 0xFB/0xF3/0xF2 (MPEG sync word) or ID3 tag
 * AAC/ADTS: starts with 0xFF 0xF0-0xFF (ADTS sync word)
 * MPEG-TS: starts with 0x47
 */
function detectAudioMime(bytes: Uint8Array): string {
  if (bytes.length < 4) return "audio/mpeg";
  
  // ID3 tag → MP3
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return "audio/mpeg";
  }
  
  // MPEG sync word check
  if (bytes[0] === 0xFF) {
    const second = bytes[1];
    // MP3: 0xFB (MPEG1 Layer3), 0xF3 (MPEG2 Layer3), 0xF2 (MPEG2.5 Layer3)
    // Also 0xFA, 0xE2, etc for different MPEG versions/layers
    if ((second & 0xE0) === 0xE0) {
      // Check layer bits to distinguish MP3 from AAC
      const layer = (second >> 1) & 0x03;
      if (layer === 0) {
        // Layer = 0 means "reserved" in MPEG, but in ADTS it's AAC
        return "audio/aac";
      }
      return "audio/mpeg";
    }
    // ADTS: 0xFFF (12 bits sync) — 0xFF followed by 0xF0-0xFF
    if ((second & 0xF0) === 0xF0) {
      return "audio/aac";
    }
  }
  
  return "audio/mpeg"; // Default
}

function makeFallback(mp3Bytes: Uint8Array, reason: string): VkConversionResult {
  console.warn("[ymd][vk-format-converter] fallback на MP3:", reason);
  return {
    success: true,
    audioDataB64: bytesToBase64(mp3Bytes),
    ext: "mp3",
    fallbackReason: reason,
  };
}

// ─── FLAC conversion ──────────────────────────────────────────────────────────

async function convertToFlac(
  mp3Bytes: Uint8Array,
  meta: VkTrackMetaForConversion,
): Promise<VkConversionResult> {
  // Try decoding with multiple MIME types — VK may serve AAC (ADTS) or MP3
  // Also try video/mp2t since VK HLS segments are MPEG-TS
  const mimeTypes = ["video/mp2t", "audio/aac", "audio/mpeg", "audio/mp4"];
  
  // First try raw data with all MIMEs
  for (const mime of mimeTypes) {
    console.log(`[ymd][vk-format-converter] convertToFlac: trying mime=${mime}, bytes=${mp3Bytes.length}`);
    const encodeResult = await encodeMp3ToFlacInOffscreen(mp3Bytes, mime);
    if (encodeResult.success) {
      // Embed metadata into FLAC
      let finalFlacBytes: Uint8Array;
      try {
        finalFlacBytes = embedFlacMetadata(encodeResult.flacBytes, {
          artist: meta.artist,
          title: meta.title,
        });
      } catch (e) {
        console.warn("[ymd][vk-format-converter] embedFlacMetadata failed:", e instanceof Error ? e.message : String(e));
        finalFlacBytes = encodeResult.flacBytes;
      }
      return {
        success: true,
        audioDataB64: bytesToBase64(finalFlacBytes),
        ext: "flac",
      };
    }
    console.log(`[ymd][vk-format-converter] ${mime} failed: ${encodeResult.reason}`);
  }

  return makeFallback(mp3Bytes, "Не удалось декодировать аудио (пробовал AAC и MP3)");
}

// ─── WAV conversion ───────────────────────────────────────────────────────────

async function convertToWav(
  mp3Bytes: Uint8Array,
  meta: VkTrackMetaForConversion,
): Promise<VkConversionResult> {
  // Try decoding with multiple MIME types
  const mimeTypes = ["video/mp2t", "audio/aac", "audio/mpeg", "audio/mp4"];
  
  for (const mime of mimeTypes) {
    console.log(`[ymd][vk-format-converter] convertToWav: trying mime=${mime}, bytes=${mp3Bytes.length}`);
    const decodeResult = await decodeAudioInOffscreen(mp3Bytes, mime);
    if (decodeResult.success) {
      let wavBytes: Uint8Array;
      try {
        wavBytes = buildWavFile(
          decodeResult.pcmData,
          decodeResult.sampleRate,
          decodeResult.channels,
          16,
          { artist: meta.artist, title: meta.title },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return makeFallback(mp3Bytes, `Ошибка создания WAV: ${msg}`);
      }
      return {
        success: true,
        audioDataB64: bytesToBase64(wavBytes),
        ext: "wav",
      };
    }
    console.log(`[ymd][vk-format-converter] ${mime} failed: ${decodeResult.reason}`);
  }

  return makeFallback(mp3Bytes, "Не удалось декодировать аудио для WAV (пробовал AAC и MP3)");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert an MP3 buffer to the target format.
 * On any conversion error — falls back to returning the original MP3 without throwing.
 */
export async function convertVkAudio(
  mp3Bytes: Uint8Array,
  targetFormat: AudioFormat,
  meta: VkTrackMetaForConversion,
): Promise<VkConversionResult> {
  try {
    switch (targetFormat) {
      case "flac":
        return await convertToFlac(mp3Bytes, meta);

      case "wav":
        return await convertToWav(mp3Bytes, meta);

      case "mp3":
        // No conversion needed — return original bytes as-is
        return {
          success: true,
          audioDataB64: bytesToBase64(mp3Bytes),
          ext: "mp3",
        };

      default: {
        // Exhaustiveness guard
        const _exhaustive: never = targetFormat;
        return makeFallback(mp3Bytes, `Неизвестный формат: ${_exhaustive}`);
      }
    }
  } catch (e) {
    // Top-level safety net — should never be reached in practice
    const msg = e instanceof Error ? e.message : String(e);
    return makeFallback(mp3Bytes, `Непредвиденная ошибка конвертации: ${msg}`);
  }
}
