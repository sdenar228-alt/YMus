// Mux audio + video into MP4 using mediabunny — runs directly in the
// Service Worker (no offscreen, no ffmpeg.wasm). Mediabunny works in SW
// because its encoded-passthrough mode does not require WebCodecs.
//
// Ported from the legacy 22 May build's `yt-mediabunny-mux.ts`.

import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  type AudioCodec,
  type InputAudioTrack,
  type InputVideoTrack,
  type VideoCodec,
} from "mediabunny";

const TAG = "[YMus YT MUX]";

export interface MuxResultSuccess {
  success: true;
  data: Uint8Array;
}

export interface MuxResultError {
  success: false;
  error: string;
}

export type MuxResult = MuxResultSuccess | MuxResultError;

/**
 * Remux a video track + audio track into an MP4 container in encoded
 * passthrough mode. Inputs are the raw bytes assembled from SABR replay
 * (init segment + media segments concatenated). Output is a fully
 * playable MP4 ready to be saved via `chrome.downloads`.
 */
export async function muxToMp4(
  videoData: Uint8Array,
  audioData: Uint8Array,
): Promise<MuxResult> {
  let videoInput: Input | null = null;
  let audioInput: Input | null = null;
  try {
    videoInput = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(videoData),
    });
    audioInput = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(audioData),
    });

    const videoTrack = await videoInput.getPrimaryVideoTrack();
    const audioTrack = await audioInput.getPrimaryAudioTrack();
    if (!videoTrack) {
      return { success: false, error: "Видео-дорожка не найдена" };
    }
    if (!audioTrack) {
      return { success: false, error: "Аудио-дорожка не найдена" };
    }

    const videoConfig = await videoTrack.getDecoderConfig();
    const audioConfig = await audioTrack.getDecoderConfig();
    if (!videoConfig) {
      return {
        success: false,
        error: "Не удалось извлечь конфиг видео-декодера",
      };
    }
    if (!audioConfig) {
      return {
        success: false,
        error: "Не удалось извлечь конфиг аудио-декодера",
      };
    }

    const videoCodec = pickVideoCodec(videoConfig.codec);
    const audioCodec = pickAudioCodec(audioConfig.codec);
    if (!videoCodec) {
      return {
        success: false,
        error: `Неподдерживаемый видео-кодек: ${videoConfig.codec}`,
      };
    }
    if (!audioCodec) {
      return {
        success: false,
        error: `Неподдерживаемый аудио-кодек: ${audioConfig.codec}`,
      };
    }

    console.log(
      `${TAG} Muxing video=${videoConfig.codec} (→${videoCodec}) audio=${audioConfig.codec} (→${audioCodec})`,
    );

    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target,
    });

    const videoSource = new EncodedVideoPacketSource(videoCodec);
    const audioSource = new EncodedAudioPacketSource(audioCodec);
    output.addVideoTrack(videoSource);
    output.addAudioTrack(audioSource);
    await output.start();

    await Promise.all([
      pipeVideoPackets(videoTrack, videoSource, videoConfig as VideoDecoderConfig),
      pipeAudioPackets(audioTrack, audioSource, audioConfig as AudioDecoderConfig),
    ]);

    await output.finalize();

    if (!target.buffer) {
      return { success: false, error: "Mediabunny не вернул выходной буфер" };
    }
    const out = new Uint8Array(target.buffer);
    console.log(`${TAG} Muxed: ${(out.byteLength / 1024 / 1024).toFixed(2)} MB`);
    return { success: true, data: out };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} mux failed: ${msg}`, err);
    return { success: false, error: msg };
  } finally {
    try {
      videoInput?.dispose();
    } catch {
      /* ignore */
    }
    try {
      audioInput?.dispose();
    } catch {
      /* ignore */
    }
  }
}

/** Map a YouTube `decoderConfig.codec` string to a mediabunny VideoCodec. */
export function pickVideoCodec(codecString: string | undefined): VideoCodec | null {
  const c = (codecString || "").toLowerCase();
  if (c.startsWith("avc1") || c.startsWith("avc3")) return "avc";
  if (c.startsWith("hev1") || c.startsWith("hvc1")) return "hevc";
  if (c.startsWith("vp9") || c.startsWith("vp09")) return "vp9";
  if (c.startsWith("vp8")) return "vp8";
  if (c.startsWith("av01") || c.startsWith("av1")) return "av1";
  return null;
}

/** Map a YouTube `decoderConfig.codec` string to a mediabunny AudioCodec. */
export function pickAudioCodec(codecString: string | undefined): AudioCodec | null {
  const c = (codecString || "").toLowerCase();
  if (c === "opus") return "opus";
  if (c === "vorbis") return "vorbis";
  if (c.startsWith("mp4a")) return "aac";
  if (c.startsWith("mp3") || c === "mp4a.6b" || c === "mp4a.69") return "mp3";
  if (c === "flac") return "flac";
  return null;
}

async function pipeVideoPackets(
  track: InputVideoTrack,
  source: EncodedVideoPacketSource,
  decoderConfig: VideoDecoderConfig,
): Promise<void> {
  const sink = new EncodedPacketSink(track);
  let isFirst = true;
  let count = 0;
  for await (const packet of sink.packets()) {
    if (isFirst) {
      await source.add(packet, { decoderConfig });
      isFirst = false;
    } else {
      await source.add(packet);
    }
    count++;
  }
  console.log(`${TAG}   video: ${count} packets piped`);
}

async function pipeAudioPackets(
  track: InputAudioTrack,
  source: EncodedAudioPacketSource,
  decoderConfig: AudioDecoderConfig,
): Promise<void> {
  const sink = new EncodedPacketSink(track);
  let isFirst = true;
  let count = 0;
  for await (const packet of sink.packets()) {
    if (isFirst) {
      await source.add(packet, { decoderConfig });
      isFirst = false;
    } else {
      await source.add(packet);
    }
    count++;
  }
  console.log(`${TAG}   audio: ${count} packets piped`);
}
