// WAV converter — decodes a source audio file (FLAC or MP3) to PCM samples.
//
// В Service Worker MV3 OfflineAudioContext недоступен, поэтому декодирование
// делегируется offscreen-документу. Если OfflineAudioContext всё-таки есть
// (например, при unit-тестах), используется локальный путь.
//
// Output is the raw PCM byte stream (little-endian, interleaved channels).
// Wrapping the PCM bytes in a RIFF/WAVE container is handled by `wav-meta.ts`.

import { decodeAudioInOffscreen } from "./offscreen-bridge";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface WavConversionResult {
  success: true;
  /** Interleaved 16-bit signed PCM samples (little-endian). */
  pcmData: Uint8Array;
  /** Sample rate in Hz preserved from the source. */
  sampleRate: number;
  /** Channel count preserved from the source (1 = mono, 2 = stereo, etc.). */
  channels: number;
  /** Bits per sample of the produced PCM data — always 16. */
  bitsPerSample: 16;
}

export interface WavConversionError {
  success: false;
  /** Human-readable failure reason. */
  reason: string;
}

export type SourceMime = "audio/flac" | "audio/mpeg";

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Convert a `Uint8Array` view to an independent `ArrayBuffer` suitable for
 * `decodeAudioData`. We slice the underlying buffer to the view's range so
 * `decodeAudioData` receives an exact-fit, non-shared buffer.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // ArrayBuffer.prototype.slice returns a fresh, non-shared ArrayBuffer.
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/**
 * Interleave per-channel Float32 samples and convert each sample to a 16-bit
 * signed integer. Output bytes are little-endian.
 *
 * Conversion rule (standard for Float→Int16 PCM):
 *   - Clamp to [-1, 1].
 *   - Multiply by 32767 (positive max) for non-negative, 32768 for negatives,
 *     so the full signed-int16 range is reachable without overflow.
 */
function interleaveFloat32ToInt16LE(
  channelData: Float32Array[],
  frames: number,
): Uint8Array {
  const channels = channelData.length;
  const totalSamples = frames * channels;
  const out = new Uint8Array(totalSamples * 2);
  const view = new DataView(out.buffer);

  let writeOffset = 0;
  for (let frame = 0; frame < frames; frame++) {
    for (let ch = 0; ch < channels; ch++) {
      let sample = channelData[ch][frame];
      // Clamp to [-1, 1]
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;
      // Map to int16 range
      const int16 =
        sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      view.setInt16(writeOffset, int16, /* littleEndian */ true);
      writeOffset += 2;
    }
  }

  return out;
}

/**
 * Construct an `OfflineAudioContext` capable of running `decodeAudioData`.
 * The constructor parameters are required by the API but do not constrain
 * the decoded `AudioBuffer` — the resulting buffer carries its own sample
 * rate, channel count, and length derived from the source audio.
 */
function createDecodingContext(): OfflineAudioContext {
  // Use widely-supported defaults. Some implementations validate the sample
  // rate; 44100 is universally accepted.
  return new OfflineAudioContext({
    numberOfChannels: 1,
    length: 1,
    sampleRate: 44100,
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Decode a source audio byte stream (FLAC or MP3) to interleaved 16-bit PCM.
 *
 * Returns a `WavConversionResult` carrying the PCM payload plus the source's
 * sample rate and channel count, which the caller passes to `buildWavFile` to
 * assemble the final RIFF/WAVE container. On any decoding failure, returns a
 * `WavConversionError` so the caller can fall back to delivering the original
 * source file.
 */
export async function convertToWav(
  sourceBytes: Uint8Array,
  sourceMime: SourceMime,
): Promise<WavConversionResult | WavConversionError> {
  if (sourceBytes.length === 0) {
    return { success: false, reason: "Source audio is empty" };
  }

  if (typeof OfflineAudioContext === "undefined") {
    // Web Audio API недоступен в Service Worker — идём через offscreen-документ.
    console.info(
      "[ymd][wav] OfflineAudioContext недоступен, делегируем offscreen-документу",
    );
    const r = await decodeAudioInOffscreen(sourceBytes, sourceMime);
    if (!r.success) return r;
    return {
      success: true,
      pcmData: r.pcmData,
      sampleRate: r.sampleRate,
      channels: r.channels,
      bitsPerSample: 16,
    };
  }

  let audioBuffer: AudioBuffer;
  try {
    const ctx = createDecodingContext();
    audioBuffer = await ctx.decodeAudioData(toArrayBuffer(sourceBytes));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      "[ymd][wav] decodeAudioData упал:",
      msg,
      "sourceMime=",
      sourceMime,
      "bytes=",
      sourceBytes.length,
    );
    return {
      success: false,
      reason: `Failed to decode ${sourceMime} source: ${msg}`,
    };
  }

  const channels = audioBuffer.numberOfChannels;
  const frames = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;

  if (channels < 1 || frames < 1 || sampleRate < 1) {
    return {
      success: false,
      reason: "Decoded audio buffer is empty or invalid",
    };
  }

  // Pull each channel's Float32 samples once, then interleave into Int16 LE.
  const channelData: Float32Array[] = new Array(channels);
  for (let ch = 0; ch < channels; ch++) {
    channelData[ch] = audioBuffer.getChannelData(ch);
  }

  const pcmData = interleaveFloat32ToInt16LE(channelData, frames);

  return {
    success: true,
    pcmData,
    sampleRate,
    channels,
    bitsPerSample: 16,
  };
}
