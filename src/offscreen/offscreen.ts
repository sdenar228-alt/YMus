// Offscreen document вЂ” РІС‹РїРѕР»РЅСЏРµС‚ С‚СЏР¶С‘Р»СѓСЋ СЂР°Р±РѕС‚Сѓ СЃ Web Audio API Рё WASM-РєРѕРґРµРєР°РјРё,
// РєРѕС‚РѕСЂС‹С… РЅРµС‚ РІ Service Worker MV3.
//
// РџРѕРґРґРµСЂР¶РёРІР°РµРјС‹Рµ СЃРѕРѕР±С‰РµРЅРёСЏ (РІСЃРµ СЃ target="offscreen"):
//   PING                  в†’ { pong: true } вЂ” health check
//   DECODE_AUDIO_TO_PCM   в†’ РґРµРєРѕРґРёСЂСѓРµС‚ FLAC/MP3 РІ interleaved 16-bit PCM (РґР»СЏ WAV)
//   ENCODE_AUDIO_TO_FLAC  в†’ РґРµРєРѕРґРёСЂСѓРµС‚ MP3 в†’ FLAC С‡РµСЂРµР· libflac.js (lossless РєРѕРЅС‚РµР№РЅРµСЂ РґР»СЏ lossy РёСЃС…РѕРґРЅРёРєР°)
//   ENCODE_OGG_TO_MP3     → транскодирует расшифрованный Spotify Ogg Vorbis в MP3 192 kbps
//                          через тот же ffmpeg-worker.js (см. spotify-transcode.ts)

// Статический импорт Spotify-транскодера (R11.1, R11.2). ffmpeg-инстанс внутри
// модуля ленив — реальная загрузка core+wasm происходит при первом вызове
// encodeOggToMp3, поэтому статический import не утяжеляет cold-start
// offscreen-документа для VK/Yandex/YouTube-сценариев.
import { encodeOggToMp3 } from "./spotify-transcode";

// в”Ђв”Ђв”Ђ РўРёРїС‹ libflac.js в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// Р“Р»РѕР±Р°Р»СЊРЅС‹Р№ Flac РёРЅР¶РµРєС‚РёС‚СЃСЏ СЃРєСЂРёРїС‚РѕРј libflac.min.wasm.js (СЃРј. offscreen.html).
interface FlacGlobal {
  isReady(): boolean;
  /** Р РµРіРёСЃС‚СЂРёСЂСѓРµС‚ callback РЅР° РіРѕС‚РѕРІРЅРѕСЃС‚СЊ WASM-РјРѕРґСѓР»СЏ (РѕРґРЅРѕСЂР°Р·РѕРІС‹Р№ СЃРµС‚С‚РµСЂ). */
  onready: (() => void) | null;
  /** Persistent event listener вЂ” СЃСЂР°Р±РѕС‚Р°РµС‚ РґР°Р¶Рµ РµСЃР»Рё 'ready' СѓР¶Рµ Р±С‹Р» Р·Р°С„Р°Р№СЂРµРЅ. */
  on(event: "ready", listener: (e: unknown) => void): void;
  off(event: "ready", listener: (e: unknown) => void): void;
  create_libflac_encoder(
    sampleRate: number,
    channels: number,
    bps: number,
    compressionLevel: number,
    totalSamples: number,
    isVerify?: boolean | number,
  ): number;
  init_encoder_stream(
    encoder: number,
    writeCallback: (
      data: Uint8Array,
      bytes: number,
      samples: number,
      currentFrame: number,
    ) => void,
    metadataCallback: (data: unknown) => void,
    isWriteOgg?: boolean | number,
    clientData?: unknown,
  ): number;
  FLAC__stream_encoder_process_interleaved(
    encoder: number,
    buffer: Int32Array,
    samples: number,
  ): boolean | number;
  FLAC__stream_encoder_finish(encoder: number): boolean | number;
  FLAC__stream_encoder_delete(encoder: number): void;
  FLAC__stream_encoder_get_state(encoder: number): number;
}

declare const Flac: FlacGlobal;

// в”Ђв”Ђв”Ђ base64 в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
// Р›РѕРєР°Р»СЊРЅР°СЏ РєРѕРїРёСЏ РёР· shared/base64.ts. Offscreen РЅРµ РёРјРїРѕСЂС‚РёСЂСѓРµС‚ РёР· shared
// РЅР°РїСЂСЏРјСѓСЋ С‡С‚РѕР±С‹ РёР·Р±РµР¶Р°С‚СЊ Р»РёС€РЅРёС… Р·Р°РІРёСЃРёРјРѕСЃС‚РµР№ РІ РјР°Р»РµРЅСЊРєРѕРј Р±Р°РЅРґР»Рµ.

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(
      null,
      slice as unknown as number[],
    );
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// в”Ђв”Ђв”Ђ РЎРѕРѕР±С‰РµРЅРёСЏ в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

interface OffscreenRequest {
  target: "offscreen";
  type:
    | "DECODE_AUDIO_TO_PCM"
    | "ENCODE_AUDIO_TO_FLAC"
    | "PING"
    | "DOWNLOAD_VIA_BLOB"
    | "DOWNLOAD_BLOB_INIT"
    | "DOWNLOAD_BLOB_CHUNK"
    | "DOWNLOAD_BLOB_FINISH"
    | "MUX_MP4_INIT"
    | "MUX_MP4_CHUNK"
    | "MUX_MP4_FINISH"
    | "YT_INNERTUBE_DOWNLOAD"
    | "ENCODE_OGG_TO_MP3";
  payload?: {
    /** РЎС‹СЂС‹Рµ Р±Р°Р№С‚С‹ source-С„Р°Р№Р»Р°, base64-encoded. */
    bytesB64: string;
    /** MIME-С‚РёРї source. */
    sourceMime: string;
    /** For DOWNLOAD_VIA_BLOB: filename to save as. */
    filename?: string;
    /** For DOWNLOAD_VIA_BLOB: optional saveAs flag. */
    saveAs?: boolean;
    /**
     * For DOWNLOAD_VIA_BLOB: if true, the offscreen document triggers the
     * download itself via a synthetic `<a download>` click. Otherwise it
     * just mints a `blob:` URL and returns it to the SW, which is much
     * faster and gives a real `chrome.downloads.download()` id back.
     *
     * Anchor mode is needed only on browsers that ignore the `filename`
     * parameter of chrome.downloads.download for blob URLs (Yandex/Vivaldi
     * on macOS).
     */
    useAnchor?: boolean;
    /** For DOWNLOAD_BLOB_*: session id linking init/chunk/finish. */
    sessionId?: string;
    /** For DOWNLOAD_BLOB_INIT: total expected size in bytes. */
    totalBytes?: number;
    /** For DOWNLOAD_BLOB_CHUNK: index of this chunk (for ordering). */
    chunkIndex?: number;
    /** For MUX_MP4_INIT: YouTube audio iTag (140/141/249/250/251/...). */
    audioITag?: number;
    /** For MUX_MP4_INIT: YouTube video iTag (135/136/137/244/247/248/271/313/...). */
    videoITag?: number;
    /** For MUX_MP4_INIT: total bytes for the audio stream (for sanity). */
    audioBytesTotal?: number;
    /** For MUX_MP4_INIT: total bytes for the video stream (for sanity). */
    videoBytesTotal?: number;
    /** For MUX_MP4_CHUNK: which stream (audio or video) this chunk belongs to. */
    streamId?: "audio" | "video";
    /** For MUX_MP4_CHUNK: true when this is the last chunk for `streamId`. */
    isLast?: boolean;
    /** For YT_INNERTUBE_DOWNLOAD: target video id. */
    videoId?: string;
    /** For YT_INNERTUBE_DOWNLOAD: filename to save the muxed MP4 as. */
    ytFilename?: string;
    /** For YT_INNERTUBE_DOWNLOAD: preferred quality, e.g. "1080p". */
    preferredQuality?: string;
    /**
     * For YT_INNERTUBE_DOWNLOAD: tab id of the originating content
     * script. The offscreen document forwards download/mux progress
     * ticks (`YT_DOWNLOAD_PROGRESS`) to this tab so the on-page button
     * can update its ring without round-tripping through the SW.
     */
    senderTabId?: number;
  };
}

interface DecodeSuccess {
  success: true;
  /** Interleaved 16-bit PCM (LE), base64-encoded. */
  pcmDataB64: string;
  sampleRate: number;
  channels: number;
}

interface EncodeFlacSuccess {
  success: true;
  /** Р“РѕС‚РѕРІС‹Рµ FLAC-Р±Р°Р№С‚С‹, base64-encoded. */
  flacDataB64: string;
  sampleRate: number;
  channels: number;
}

interface OffscreenFailure {
  success: false;
  reason: string;
}

type DecodeResponse = DecodeSuccess | OffscreenFailure;
type EncodeFlacResponse = EncodeFlacSuccess | OffscreenFailure;

// в”Ђв”Ђв”Ђ Helpers в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

function interleaveFloat32ToInt16LE(
  channelData: Float32Array[],
  frames: number,
): Uint8Array {
  const channels = channelData.length;
  const out = new Uint8Array(frames * channels * 2);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (let frame = 0; frame < frames; frame++) {
    for (let ch = 0; ch < channels; ch++) {
      let s = channelData[ch][frame];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      const i16 = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
      view.setInt16(offset, i16, true);
      offset += 2;
    }
  }
  return out;
}

/** Convert per-channel Float32 в†’ interleaved Int32 (16-bit value range). */
function interleaveFloat32ToInt32_16bit(
  channelData: Float32Array[],
  frames: number,
): Int32Array {
  const channels = channelData.length;
  const out = new Int32Array(frames * channels);
  let offset = 0;
  for (let frame = 0; frame < frames; frame++) {
    for (let ch = 0; ch < channels; ch++) {
      let s = channelData[ch][frame];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      out[offset++] =
        s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
  }
  return out;
}

/**
 * Р”РµРєРѕРґРёСЂРѕРІР°С‚СЊ Р°СѓРґРёРѕ (FLAC/MP3) С‡РµСЂРµР· OfflineAudioContext РІ AudioBuffer.
 * Р’РѕР·РІСЂР°С‰Р°РµС‚ per-channel Float32 + РїР°СЂР°РјРµС‚СЂС‹.
 */
async function decodeToAudioBuffer(bytes: Uint8Array): Promise<
  | {
      success: true;
      channelData: Float32Array[];
      frames: number;
      sampleRate: number;
      channels: number;
    }
  | { success: false; reason: string }
> {
  if (bytes.length === 0) {
    return { success: false, reason: "Source audio is empty" };
  }
  if (typeof OfflineAudioContext === "undefined") {
    return {
      success: false,
      reason: "OfflineAudioContext РЅРµРґРѕСЃС‚СѓРїРµРЅ РґР°Р¶Рµ РІ offscreen",
    };
  }
  try {
    const ctx = new OfflineAudioContext({
      numberOfChannels: 1,
      length: 1,
      sampleRate: 44100,
    });
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const buf = await ctx.decodeAudioData(ab);
    const channels = buf.numberOfChannels;
    const frames = buf.length;
    const sampleRate = buf.sampleRate;
    if (channels < 1 || frames < 1 || sampleRate < 1) {
      return { success: false, reason: "Decoded buffer is empty" };
    }
    const channelData: Float32Array[] = [];
    for (let ch = 0; ch < channels; ch++) {
      channelData.push(buf.getChannelData(ch));
    }
    return { success: true, channelData, frames, sampleRate, channels };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, reason: `decodeAudioData failed: ${msg}` };
  }
}

// в”Ђв”Ђв”Ђ Action: PCM (РґР»СЏ WAV) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

async function decodeAudioToPcm(
  bytes: Uint8Array,
  sourceMime: string,
): Promise<DecodeResponse> {
  const r = await decodeToAudioBuffer(bytes);
  if (!r.success) {
    return {
      success: false,
      reason: `Failed to decode ${sourceMime}: ${r.reason}`,
    };
  }
  const pcm = interleaveFloat32ToInt16LE(r.channelData, r.frames);
  return {
    success: true,
    pcmDataB64: bytesToBase64(pcm),
    sampleRate: r.sampleRate,
    channels: r.channels,
  };
}

// в”Ђв”Ђв”Ђ Action: encode в†’ FLAC в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

/** Р”РѕР¶РґР°С‚СЊСЃСЏ РіРѕС‚РѕРІРЅРѕСЃС‚Рё WASM-РјРѕРґСѓР»СЏ libflac.
 *
 * РСЃРїРѕР»СЊР·СѓРµС‚ `Flac.on("ready", ...)` вЂ” СЌС‚Рѕ persisted-event listener: СЃСЂР°Р±РѕС‚Р°РµС‚
 * РґР°Р¶Рµ РµСЃР»Рё 'ready' СѓР¶Рµ Р±С‹Р» Р·Р°С„Р°Р№СЂРµРЅ РґРѕ РїРѕРґРїРёСЃРєРё (race-safe).
 */
function waitForFlacReady(): Promise<void> {
  if (typeof Flac === "undefined") {
    return Promise.reject(
      new Error("libflac.min.wasm.js РЅРµ Р·Р°РіСЂСѓР·РёР»СЃСЏ (Flac global РѕС‚СЃСѓС‚СЃС‚РІСѓРµС‚)"),
    );
  }
  if (Flac.isReady()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      Flac.off("ready", listener);
      if (err) reject(err);
      else resolve();
    };
    const timeout = setTimeout(() => {
      finish(new Error("libflac РЅРµ СЃС‚Р°Р» ready Р·Р° 15 СЃРµРє"));
    }, 15000);
    const listener = () => {
      clearTimeout(timeout);
      finish();
    };
    Flac.on("ready", listener);
  });
}

async function encodeAudioToFlac(
  bytes: Uint8Array,
  sourceMime: string,
): Promise<EncodeFlacResponse> {
  const t0 = performance.now();
  const decoded = await decodeToAudioBuffer(bytes);
  if (!decoded.success) {
    return {
      success: false,
      reason: `Failed to decode ${sourceMime} for FLAC encoding: ${decoded.reason}`,
    };
  }
  const t1 = performance.now();
  console.info(
    `[ymd][offscreen] decode в†’ ${(t1 - t0).toFixed(0)}ms (${decoded.frames} frames, ${decoded.channels}ch, ${decoded.sampleRate}Hz)`,
  );

  try {
    await waitForFlacReady();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, reason: msg };
  }
  const t2 = performance.now();
  console.info(`[ymd][offscreen] flac ready в†’ ${(t2 - t1).toFixed(0)}ms`);

  const { channelData, frames, sampleRate, channels } = decoded;
  const bps = 16;
  // Compression level: 1 (Р±С‹СЃС‚СЂС‹Р№). Р Р°Р·РЅРёС†Р° СЃ level 8 РЅР° lossy-РёСЃС‚РѕС‡РЅРёРєРµ
  // СЃРѕСЃС‚Р°РІР»СЏРµС‚ РІСЃРµРіРѕ ~5% СЂР°Р·РјРµСЂР° (~0.6 РњР‘ РЅР° С‚СЂРµРє), РЅРѕ СЌРЅРєРѕРґРёРЅРі РІ 2-3Г—
  // Р±С‹СЃС‚СЂРµРµ. РљР°С‡РµСЃС‚РІРѕ Р·РІСѓРєР° РѕРґРёРЅР°РєРѕРІРѕ РЅР° РІСЃРµС… СѓСЂРѕРІРЅСЏС… вЂ” FLAC lossless.
  const compressionLevel = 1;

  const flacChunks: Uint8Array[] = [];
  let totalLen = 0;
  const writeCallback = (data: Uint8Array, bytes: number) => {
    const copy = new Uint8Array(bytes);
    copy.set(data.subarray(0, bytes));
    flacChunks.push(copy);
    totalLen += bytes;
  };

  const encoder = Flac.create_libflac_encoder(
    sampleRate,
    channels,
    bps,
    compressionLevel,
    frames,
    0, // is_verify вЂ” РїРµСЂРµРґР°С‘Рј 0 (РЅРµ false), РєР°Рє РІ РїСЂРёРјРµСЂРµ libflacjs
  );
  console.info("[ymd][offscreen] create_libflac_encoder в†’", encoder);
  if (encoder === 0) {
    return { success: false, reason: "РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕР·РґР°С‚СЊ FLAC-СЌРЅРєРѕРґРµСЂ" };
  }

  try {
    const initStatus = Flac.init_encoder_stream(
      encoder,
      writeCallback,
      () => {
        /* metadata callback */
      },
      // Р’РђР–РќРћ: 4-Р№ Р°СЂРіСѓРјРµРЅС‚ вЂ” ogg_serial_number. Р›СЋР±РѕРµ number РІРєР»СЋС‡Р°РµС‚ Ogg-FLAC,
      // РґР°Р¶Рµ 0! РџРµСЂРµРґР°С‘Рј false, С‡С‚РѕР±С‹ РїРѕР»СѓС‡РёС‚СЊ РЅР°С‚РёРІРЅС‹Р№ FLAC ("fLaC" magic).
      false,
      0,
    );
    console.info(
      "[ymd][offscreen] init_encoder_stream в†’ status=",
      initStatus,
      "encoder_state=",
      Flac.FLAC__stream_encoder_get_state(encoder),
    );
    if (initStatus !== 0) {
      return {
        success: false,
        reason: `init_encoder_stream РІРµСЂРЅСѓР» ${initStatus}`,
      };
    }

    // РџСЂРѕС†РµСЃСЃРёРј С‡Р°РЅРєР°РјРё вЂ” РёРЅР°С‡Рµ libflac РїС‹С‚Р°РµС‚СЃСЏ РІС‹РґРµР»РёС‚СЊ framesГ—channelsГ—4
    // Р±Р°Р№С‚ РІ WASM HEAP Р·Р° СЂР°Р·, С‡С‚Рѕ РјРѕР¶РµС‚ РЅРµ РІР»РµР·С‚СЊ (HEAP СЃС‚Р°СЂС‚СѓРµС‚ СЃ 16 РњР‘).
    // 8192 СЃСЌРјРїР»РѕРІ Г— 2 РєР°РЅР°Р»Р° Г— 4 Р±Р°Р№С‚Р° = 64 РљР‘ Р·Р° С‡Р°РЅРє вЂ” Р±РµР·РѕРїР°СЃРЅРѕ.
    const CHUNK_FRAMES = 8192;
    const t3a = performance.now();
    for (let off = 0; off < frames; off += CHUNK_FRAMES) {
      const end = Math.min(off + CHUNK_FRAMES, frames);
      const chunkLen = end - off;
      const chunkBuf = new Int32Array(chunkLen * channels);
      let bo = 0;
      for (let f = off; f < end; f++) {
        for (let ch = 0; ch < channels; ch++) {
          let s = channelData[ch][f];
          if (s > 1) s = 1;
          else if (s < -1) s = -1;
          chunkBuf[bo++] =
            s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        }
      }

      const ok = Flac.FLAC__stream_encoder_process_interleaved(
        encoder,
        chunkBuf,
        chunkLen,
      );
      // Р’РђР–РќРћ: РІРѕР·РІСЂР°С‰Р°РµС‚ number (1=ok, 0=fail), РЅРµ boolean. РџСЂРѕРІРµСЂСЏРµРј != 1.
      if (ok !== true && ok !== 1) {
        const state = Flac.FLAC__stream_encoder_get_state(encoder);
        return {
          success: false,
          reason: `process_interleaved failed at frame ${off} (rc=${ok}, state=${state})`,
        };
      }
    }
    const t3b = performance.now();
    console.info(
      `[ymd][offscreen] flac process loop в†’ ${(t3b - t3a).toFixed(0)}ms (${Math.ceil(frames / CHUNK_FRAMES)} chunks)`,
    );

    const finishOk = Flac.FLAC__stream_encoder_finish(encoder);
    if (finishOk !== true && finishOk !== 1) {
      return { success: false, reason: "FLAC encoder finish failed" };
    }
  } finally {
    Flac.FLAC__stream_encoder_delete(encoder);
  }

  const t4 = performance.now();
  console.info(
    `[ymd][offscreen] flac encode total в†’ ${(t4 - t2).toFixed(0)}ms (${totalLen} bytes, level=${compressionLevel})`,
  );

  // РЎРєР»РµРёС‚СЊ С‡Р°РЅРєРё РІ РѕРґРёРЅ Uint8Array.
  const flac = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of flacChunks) {
    flac.set(c, offset);
    offset += c.length;
  }

  const flacDataB64 = bytesToBase64(flac);
  const t5 = performance.now();
  console.info(
    `[ymd][offscreen] base64 в†’ ${(t5 - t4).toFixed(0)}ms (${flacDataB64.length} chars), total=${(t5 - t0).toFixed(0)}ms`,
  );
  // [DEBUG] РїРµСЂРІС‹Рµ Р±Р°Р№С‚С‹ вЂ” РґРѕР»Р¶РЅС‹ Р±С‹С‚СЊ "fLaC" (0x66 0x4C 0x61 0x43).
  console.info(
    "[ymd][offscreen] flac magic check:",
    flac[0]?.toString(16),
    flac[1]?.toString(16),
    flac[2]?.toString(16),
    flac[3]?.toString(16),
    "(expected 66 4c 61 43)",
  );

  return {
    success: true,
    flacDataB64,
    sampleRate,
    channels,
  };
}

// в”Ђв”Ђв”Ђ Listener в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

// РЎС‚Р°СЂС‚РѕРІР°СЏ РґРёР°РіРЅРѕСЃС‚РёРєР° вЂ” СЃСЂР°Р·Сѓ РІ Р»РѕРіР°С… РІРёРґРЅРѕ, Р·Р°РіСЂСѓР·РёР»СЃСЏ Р»Рё libflac.
console.info(
  "[ymd][offscreen] init: typeof Flac=",
  typeof Flac,
  "Flac.isReady=",
  typeof Flac !== "undefined" ? Flac.isReady() : "(no Flac)",
);
if (typeof Flac !== "undefined") {
  Flac.on("ready", () => {
    console.info("[ymd][offscreen] Flac ready event СЃСЂР°Р±РѕС‚Р°Р»");
  });
}

// Chunked download sessions вЂ” keyed by sessionId. Each session accumulates
// Uint8Array chunks until DOWNLOAD_BLOB_FINISH triggers the final assembly.
const chunkSessions = new Map<string, { chunks: Uint8Array[]; mime: string }>();

/**
 * Per-mux-session state: separate ordered chunk arrays for audio and
 * video plus the original iTags (purely informational вЂ” the mediabunny
 * remuxer auto-detects formats from magic bytes). Lives only between
 * MUX_MP4_INIT and MUX_MP4_FINISH.
 */
const muxSessions = new Map<
  string,
  {
    audioChunks: Uint8Array[];
    videoChunks: Uint8Array[];
    audioITag: number;
    videoITag: number;
  }
>();

/**
 * Concatenate a sparse-or-dense array of Uint8Array chunks into one
 * contiguous Uint8Array. Holes (chunks not yet uploaded) are treated as
 * zero-length, which would only happen on a buggy upload вЂ” but we don't
 * throw because the muxer will surface the error cleanly via mediabunny
 * format detection.
 */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) {
    if (c) total += c.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    if (!c) continue;
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const m = message as Partial<OffscreenRequest>;
  if (m?.target !== "offscreen") return false;

  if (m.type === "PING") {
    sendResponse({ pong: true });
    return false;
  }

  // ─── Spotify: Ogg Vorbis → MP3 192 kbps ─────────────────────────────────
  //
  // Контракт сериализации байтов через chrome.runtime сохраняем тем же,
  // что и у соседних обработчиков (DECODE_AUDIO_TO_PCM / ENCODE_AUDIO_TO_FLAC /
  // DOWNLOAD_VIA_BLOB / MUX_MP4_*): бинарь ездит как base64-строка в поле
  // payload.bytesB64 (вход) и в поле mp3DataB64 (выход). Передавать
  // Uint8Array напрямую через chrome.runtime.sendMessage в MV3 ненадёжно
  // (некоторые сборки Chromium роняют типизированные массивы в plain JSON
  // или {0:…,1:…,length:…}-подобный объект), поэтому единая конвенция —
  // base64. Оркестратор в task 4.1 (spotify-download-handler.ts) обязан:
  //   - кодировать Decrypted_Ogg_Buffer через bytesToBase64 из shared/base64.ts
  //     и слать `{ target: "offscreen", type: "ENCODE_OGG_TO_MP3",
  //       payload: { bytesB64, sourceMime: 'audio/ogg; codecs="vorbis"' } }`;
  //   - на ответ `{ ok: true, mp3DataB64 }` декодировать через base64ToBytes
  //     и передавать в chrome.downloads.download (через blob: URL);
  //   - на ответ `{ ok: false, error }` — мапить в SPOTIFY_TRANSCODE_FAILED.
  if (m.type === "ENCODE_OGG_TO_MP3") {
    const payload = m.payload;
    if (
      !payload ||
      typeof payload.bytesB64 !== "string" ||
      typeof payload.sourceMime !== "string"
    ) {
      sendResponse({ ok: false, error: "Invalid ENCODE_OGG_TO_MP3 payload" });
      return false;
    }
    const bytes = base64ToBytes(payload.bytesB64);
    void encodeOggToMp3(bytes, payload.sourceMime)
      .then((mp3) => {
        sendResponse({ ok: true, mp3DataB64: bytesToBase64(mp3) });
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err);
        sendResponse({ ok: false, error });
      });
    return true;
  }

  if (m.type === "DECODE_AUDIO_TO_PCM") {
    const payload = m.payload;
    if (!payload || typeof payload.bytesB64 !== "string") {
      sendResponse({ success: false, reason: "Invalid payload" });
      return false;
    }
    const bytes = base64ToBytes(payload.bytesB64);
    void decodeAudioToPcm(bytes, payload.sourceMime).then((r) =>
      sendResponse(r),
    );
    return true;
  }

  if (m.type === "ENCODE_AUDIO_TO_FLAC") {
    const payload = m.payload;
    if (!payload || typeof payload.bytesB64 !== "string") {
      sendResponse({ success: false, reason: "Invalid payload" });
      return false;
    }
    const bytes = base64ToBytes(payload.bytesB64);
    void encodeAudioToFlac(bytes, payload.sourceMime).then((r) =>
      sendResponse(r),
    );
    return true;
  }

  if (m.type === "DOWNLOAD_VIA_BLOB") {
    // Two modes:
    //   1) Default (fast path): build the Blob, mint a blob: URL, hand it
    //      back. The SW then calls chrome.downloads.download(blobUrl, ...)
    //      which gives a proper downloadId and resolves quickly.
    //   2) Anchor-click (slow path): synthesise an `<a download>` and
    //      click it here. Used only for browsers that ignore the
    //      `filename` parameter for blob URLs (Yandex Browser / Vivaldi
    //      on macOS) вЂ” there the user would otherwise see "Р·Р°РіСЂСѓР¶РµРЅРЅРѕРµ.mp3"
    //      or "<UUID>.mp3" instead of the real track name.
    const payload = m.payload;
    if (!payload || typeof payload.bytesB64 !== "string") {
      sendResponse({ success: false, reason: "Invalid payload" });
      return false;
    }
    void (async () => {
      try {
        const bytes = base64ToBytes(payload.bytesB64);
        const blob = new Blob([bytes], { type: payload.sourceMime });
        const blobUrl = URL.createObjectURL(blob);
        const filename = normalizeDownloadFilename(payload.filename);

        if (payload.useAnchor) {
          const a = document.createElement("a");
          a.href = blobUrl;
          a.download = filename;
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          try { a.remove(); } catch { /* ignore */ }
        }

        // Revoke the blob URL well after the download is presumably done.
        // 5 min is enough for very large files even on slow disks.
        setTimeout(() => {
          try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
        }, 5 * 60_000);

        sendResponse({
          success: true,
          blobUrl,
          viaAnchor: !!payload.useAnchor,
        });
      } catch (err: any) {
        sendResponse({ success: false, reason: err?.message || String(err) });
      }
    })();
    return true;
  }

  // в”Ђв”Ђв”Ђ Chunked download (for files > 64 MB IPC limit) в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  //
  // chrome.runtime.sendMessage caps each message at 64 MB. For 4K videos
  // (300+ MB) we can't use DOWNLOAD_VIA_BLOB above. The SW splits the data
  // into в‰¤32 MB chunks (well below the cap to leave room for base64 inflation
  // and message envelope overhead), sends them in order via DOWNLOAD_BLOB_CHUNK,
  // then issues DOWNLOAD_BLOB_FINISH which assembles the final Blob and
  // triggers an anchor click. State per session is stored in chunkSessions.

  if (m.type === "DOWNLOAD_BLOB_INIT") {
    const sid = m.payload?.sessionId;
    if (!sid) {
      sendResponse({ success: false, reason: "Missing sessionId" });
      return false;
    }
    chunkSessions.set(sid, { chunks: [], mime: m.payload?.sourceMime || "application/octet-stream" });
    sendResponse({ success: true });
    return false;
  }

  if (m.type === "DOWNLOAD_BLOB_CHUNK") {
    const sid = m.payload?.sessionId;
    const idx = m.payload?.chunkIndex;
    const b64 = m.payload?.bytesB64;
    if (!sid || typeof idx !== "number" || typeof b64 !== "string") {
      sendResponse({ success: false, reason: "Invalid chunk payload" });
      return false;
    }
    const session = chunkSessions.get(sid);
    if (!session) {
      sendResponse({ success: false, reason: "Unknown sessionId" });
      return false;
    }
    try {
      session.chunks[idx] = base64ToBytes(b64);
      sendResponse({ success: true });
    } catch (err: any) {
      sendResponse({ success: false, reason: err?.message || String(err) });
    }
    return false;
  }

  if (m.type === "DOWNLOAD_BLOB_FINISH") {
    const sid = m.payload?.sessionId;
    const filename = (m.payload?.filename || "download").trim() || "download";
    if (!sid) {
      sendResponse({ success: false, reason: "Missing sessionId" });
      return false;
    }
    const session = chunkSessions.get(sid);
    if (!session) {
      sendResponse({ success: false, reason: "Unknown sessionId" });
      return false;
    }
    void (async () => {
      try {
        // Build the Blob from the ordered chunk array. Blob accepts a list
        // of BufferSources directly вЂ” no need to copy into one big buffer,
        // which would double our memory usage.
        const blob = new Blob(session.chunks, { type: session.mime });
        const blobUrl = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        try { a.remove(); } catch { /* ignore */ }

        // Drop chunks ASAP so the offscreen page can GC the array of
        // ~10 Г— 32 MB Uint8Arrays. The Blob keeps a reference to the
        // underlying data via its own internal buffer.
        chunkSessions.delete(sid);

        setTimeout(() => {
          try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
        }, 5 * 60_000);

        sendResponse({ success: true, blobUrl, viaAnchor: true });
      } catch (err: any) {
        chunkSessions.delete(sid);
        sendResponse({ success: false, reason: err?.message || String(err) });
      }
    })();
    return true;
  }

  // в”Ђв”Ђв”Ђ MP4 mux for YouTube video+audio в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  //
  // The chunked session pattern mirrors the DOWNLOAD_BLOB flow above: SW
  // calls MUX_MP4_INIT once, then streams audio + video bytes via
  // MUX_MP4_CHUNK (32 MB each), then MUX_MP4_FINISH which runs the
  // actual remux through mediabunny and returns the muxed MP4 bytes.

  if (m.type === "MUX_MP4_INIT") {
    const sid = m.payload?.sessionId;
    if (!sid) {
      sendResponse({ success: false, reason: "Missing sessionId" });
      return false;
    }
    muxSessions.set(sid, {
      audioChunks: [],
      videoChunks: [],
      audioITag: m.payload?.audioITag ?? 0,
      videoITag: m.payload?.videoITag ?? 0,
    });
    console.info(
      `[ymd][offscreen] MUX_MP4_INIT session=${sid} audioITag=${m.payload?.audioITag} videoITag=${m.payload?.videoITag}`,
    );
    sendResponse({ success: true });
    return false;
  }

  if (m.type === "MUX_MP4_CHUNK") {
    const sid = m.payload?.sessionId;
    const streamId = m.payload?.streamId;
    const idx = m.payload?.chunkIndex;
    const b64 = m.payload?.bytesB64;
    if (
      !sid ||
      (streamId !== "audio" && streamId !== "video") ||
      typeof idx !== "number" ||
      typeof b64 !== "string"
    ) {
      sendResponse({ success: false, reason: "Invalid mux chunk payload" });
      return false;
    }
    const session = muxSessions.get(sid);
    if (!session) {
      sendResponse({ success: false, reason: "Unknown sessionId" });
      return false;
    }
    try {
      if (streamId === "audio") {
        session.audioChunks[idx] = base64ToBytes(b64);
      } else {
        session.videoChunks[idx] = base64ToBytes(b64);
      }
      sendResponse({ success: true });
    } catch (err: any) {
      sendResponse({
        success: false,
        reason: err?.message || String(err),
      });
    }
    return false;
  }

  if (m.type === "MUX_MP4_FINISH") {
    const sid = m.payload?.sessionId;
    if (!sid) {
      sendResponse({ success: false, reason: "Missing sessionId" });
      return false;
    }
    const session = muxSessions.get(sid);
    if (!session) {
      sendResponse({ success: false, reason: "Unknown sessionId" });
      return false;
    }
    void (async () => {
      try {
        // Concatenate the chunk arrays back into single byte buffers
        // before handing them to mediabunny. The chunk array is already
        // ordered by chunkIndex (we wrote into [idx]).
        const audioBytes = concatChunks(session.audioChunks);
        const videoBytes = concatChunks(session.videoChunks);
        // Free chunk references ASAP вЂ” mediabunny copies the bytes
        // internally; keeping the chunk arrays around would double our
        // memory footprint for big videos.
        muxSessions.delete(sid);

        console.info(
          `[ymd][offscreen] MUX_MP4_FINISH muxing audio=${audioBytes.byteLength}B video=${videoBytes.byteLength}B`,
        );
        const t0 = performance.now();
        const { muxToMp4 } = await import("./yt-mp4-muxer");
        const result = await muxToMp4(audioBytes, videoBytes);
        const dt = (performance.now() - t0).toFixed(0);

        if (!result.ok) {
          console.warn(
            `[ymd][offscreen] MUX_MP4_FINISH failed in ${dt}ms: ${result.reason}`,
          );
          sendResponse({ success: false, reason: result.reason });
          return;
        }
        console.info(
          `[ymd][offscreen] MUX_MP4_FINISH ok in ${dt}ms в†’ ${(result.bytes.byteLength / 1024 / 1024).toFixed(2)} MB`,
        );
        sendResponse({
          success: true,
          muxedB64: bytesToBase64(result.bytes),
        });
      } catch (err: any) {
        muxSessions.delete(sid);
        sendResponse({
          success: false,
          reason: err?.message || String(err),
        });
      }
    })();
    return true;
  }

  // в”Ђв”Ђв”Ђ YouTube end-to-end download via youtubei.js в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
  //
  // Service workers can't run dynamic `import()` (HTML spec disallows it),
  // so the SW delegates the entire YouTube download flow here. This
  // handler:
  //   1. Imports the prebuilt youtubei.js bundle (chrome-extension:// URL).
  //   2. Calls `Innertube.create()` and `getInfo(videoId)` once.
  //   3. Validates playability (live/DRM в†’ terminal errors).
  //   4. Picks video + audio formats via `chooseFormat`.
  //   5. Drains both `download()` ReadableStreams into Uint8Arrays in
  //      parallel, emitting `YT_DOWNLOAD_PROGRESS` ticks back to the
  //      originating tab as bytes accumulate.
  //   6. Hands the byte buffers to `muxToMp4` (ffmpeg.wasm) which
  //      remuxes them into a single MP4.
  //   7. Builds a Blob, mints a blob URL, fires an `<a download>` click
  //      so the browser saves the file with the requested filename.
  //   8. Returns `{ success: true, downloadId: -1 }` because the save
  //      went through anchor click rather than `chrome.downloads.download`
  //      (no real downloadId is available; the file is still in the
  //      user's downloads tray).
  return false;
});

console.info("[ymd][offscreen] listener Р·Р°СЂРµРіРёСЃС‚СЂРёСЂРѕРІР°РЅ");

// в”Ђв”Ђв”Ђ Bridge offscreen-side logs into the service worker so we can see
//     them in the SW devtools alongside background-side logs. The SW
//     side has no listener for OFFSCREEN_LOG вЂ” chrome.runtime.sendMessage
//     just delivers it to every extension context, and the SW logs a
//     single string each time. The offscreen document itself still has
//     its own console (chrome://inspect/#other) so this is purely
//     additive. в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ
const _origInfo = console.info.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
function bridgeLog(level: "info" | "warn" | "error", args: unknown[]): void {
  // Only forward our own [ymd] tagged logs вЂ” third-party libs (mediabunny,
  // libflac.js) get noisy and would flood the SW console.
  const first = args[0];
  if (typeof first !== "string" || !first.startsWith("[ymd]")) return;
  try {
    const text = args
      .map((a) => {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    chrome.runtime
      .sendMessage({
        target: "background",
        type: "OFFSCREEN_LOG",
        level,
        text,
      })
      .catch(() => {
        /* SW may be sleeping; the offscreen-side console still has the log */
      });
  } catch {
    /* never let logging break the pipeline */
  }
}

function normalizeDownloadFilename(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const fallback = raw.length > 0 ? raw : "YMus - download";
  const cleaned = fallback.replace(/[\\/:*?"<>|]/g, "_").replace(/[\u0000-\u001f]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "YMus - download";
}
console.info = (...args: unknown[]): void => {
  _origInfo(...args);
  bridgeLog("info", args);
};
console.warn = (...args: unknown[]): void => {
  _origWarn(...args);
  bridgeLog("warn", args);
};
console.error = (...args: unknown[]): void => {
  _origError(...args);
  bridgeLog("error", args);
};
