/**
 * YouTube video+audio → single MP4 muxer (runs inside the offscreen document).
 *
 * Backed by ffmpeg.wasm. The captured fragmented-WebM / fragmented-MP4 byte
 * streams from the buffer-capture flow are written to ffmpeg's virtual file
 * system, then ffmpeg is invoked with `-c copy` to remux them into a single
 * MP4 without transcoding. ffmpeg is far more tolerant of malformed
 * fragmented streams than mediabunny — it walks the container element by
 * element, tries to recover from corrupt fragments, and skips garbage.
 *
 * Heavy weight: ffmpeg core wasm is ~31 MB, loaded once per offscreen
 * lifetime. First mux call waits for `load()` (~2-5 seconds depending on
 * disk speed); subsequent calls reuse the loaded core.
 *
 * Pipeline:
 *   1. Singleton FFmpeg instance — load on first call.
 *   2. Write `audio.input` and `video.input` to the virtual FS (extension
 *      doesn't matter; ffmpeg auto-detects format from magic bytes).
 *   3. Run `ffmpeg -i video.input -i audio.input -c:v copy -c:a copy
 *      -map 0:v:0 -map 1:a:0 -shortest -movflags +faststart out.mp4`.
 *   4. Read `out.mp4` from virtual FS → return bytes.
 *   5. Clean up virtual FS so subsequent mux calls don't accumulate state.
 *
 * If the audio stream is Opus and ffmpeg can't write Opus into MP4 with
 * `-c copy` (some build configs reject that), we fall back to transcoding
 * audio to AAC (`-c:a aac -b:a 192k`). Video is always copied.
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";

export interface MuxResult {
  ok: true;
  /** Final MP4 bytes (moov + interleaved track data, faststart layout). */
  bytes: Uint8Array;
}

export interface MuxFailure {
  ok: false;
  reason: string;
}

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;
const ffmpegLogs: string[] = [];

/**
 * Get a loaded FFmpeg instance. The first call kicks off `load()` and
 * caches the result; subsequent calls return immediately. Multiple
 * concurrent first calls deduplicate via the in-flight load promise.
 */
async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance && ffmpegInstance.loaded) return ffmpegInstance;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;
  ffmpegLoadPromise = (async () => {
    const ff = new FFmpeg();
    // Forward ffmpeg log output to the offscreen console so we can
    // diagnose mux failures from the SW devtools (the bridge log
    // forwarder picks these up automatically because they start with
    // `[ymd]`).
    ff.on("log", ({ message }) => {
      // ffmpeg is verbose; keep a rolling tail in `ffmpegLogs` and
      // surface only error-looking lines to the console.
      ffmpegLogs.push(message);
      if (ffmpegLogs.length > 200) ffmpegLogs.shift();
      if (
        /error|invalid|failed|missing|corrupt/i.test(message) &&
        !/non-monotonic|deprecated/i.test(message)
      ) {
        console.warn(`[ymd][ffmpeg] ${message}`);
      }
    });
    // Load core from extension-local files. The `chrome` API is available
    // in offscreen documents and `runtime.getURL` returns the
    // chrome-extension:// URL for the bundled core/wasm/worker.
    const coreURL = chrome.runtime.getURL("ffmpeg-core.js");
    const wasmURL = chrome.runtime.getURL("ffmpeg-core.wasm");
    const classWorkerURL = chrome.runtime.getURL("ffmpeg-worker.js");
    console.info(
      `[ymd][ffmpeg] loading core from ${coreURL} + worker from ${classWorkerURL}`,
    );
    const t0 = performance.now();
    try {
      await ff.load({
        coreURL,
        wasmURL,
        classWorkerURL,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ffmpegInstance = null;
      ffmpegLoadPromise = null;
      throw new Error(`ffmpeg load failed: ${msg}`);
    }
    console.info(
      `[ymd][ffmpeg] loaded in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    ffmpegInstance = ff;
    return ff;
  })();
  return ffmpegLoadPromise;
}

/**
 * Mux captured audio + video buffers into a single MP4 file via ffmpeg.wasm.
 *
 * @param audioBytes  Captured audio bytes (init segment + media chunks
 *                    concatenated, possibly with extra EBML/ftyp prefixes
 *                    from each UMP response — ffmpeg handles that).
 * @param videoBytes  Captured video bytes (same shape).
 */
export async function muxToMp4(
  audioBytes: Uint8Array,
  videoBytes: Uint8Array,
): Promise<MuxResult | MuxFailure> {
  if (audioBytes.byteLength === 0) {
    return { ok: false, reason: "audio buffer is empty" };
  }
  if (videoBytes.byteLength === 0) {
    return { ok: false, reason: "video buffer is empty" };
  }

  let ff: FFmpeg;
  try {
    ff = await getFFmpeg();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  }

  // Pick file extensions for the inputs based on byte signature so
  // ffmpeg picks the right demuxer hint (it auto-detects, but matching
  // extension reduces probe time).
  //
  //   WebM: starts with EBML magic 1A 45 DF A3
  //   ISOBMFF: bytes 4..7 == "ftyp"
  const audioExt = looksWebm(audioBytes) ? "webm" : "m4a";
  const videoExt = looksWebm(videoBytes) ? "webm" : "mp4";
  const audioPath = `audio.${audioExt}`;
  const videoPath = `video.${videoExt}`;
  const outPath = "out.mp4";

  try {
    ffmpegLogs.length = 0;
    // Log byte sizes BEFORE writeFile — the ffmpeg.wasm wrapper transfers
    // `data.buffer` as a Worker transferable, which neuters the source
    // ArrayBuffer in this thread (subsequent .byteLength reads return 0).
    console.info(
      `[ymd][ffmpeg] writing ${audioPath} (${audioBytes.byteLength}B) + ${videoPath} (${videoBytes.byteLength}B)`,
    );
    // We pass `new Uint8Array(bytes)` — same view but ffmpeg's transfer
    // of the underlying buffer doesn't matter to us anymore (we don't
    // reuse `audioBytes`/`videoBytes` after this). The slice() call would
    // double memory but for ~17 MB it's negligible.
    await ff.writeFile(audioPath, audioBytes);
    await ff.writeFile(videoPath, videoBytes);

    // Try copy mux first (fast path). Use `-err_detect ignore_err` and
    // `-fflags +genpts+igndts+discardcorrupt` so ffmpeg doesn't bail
    // on the partially-malformed UMP-derived WebM streams. The
    // captured fragments may have stray bytes between Clusters that a
    // strict parser would reject.
    const copyArgs = [
      "-err_detect", "ignore_err",
      "-fflags", "+genpts+igndts+discardcorrupt",
      "-i", videoPath,
      "-err_detect", "ignore_err",
      "-fflags", "+genpts+igndts+discardcorrupt",
      "-i", audioPath,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "copy",
      "-shortest",
      "-movflags", "+faststart",
      "-y", outPath,
    ];
    console.info(`[ymd][ffmpeg] exec copy: ${copyArgs.join(" ")}`);
    const t0 = performance.now();
    const copyRet = await ff.exec(copyArgs);
    console.info(
      `[ymd][ffmpeg] copy mux finished in ${(performance.now() - t0).toFixed(0)}ms ret=${copyRet}`,
    );
    let outBytes: Uint8Array | null = null;
    if (copyRet === 0) {
      try {
        const data = await ff.readFile(outPath);
        outBytes = typeof data === "string"
          ? new TextEncoder().encode(data)
          : data;
      } catch (err) {
        console.warn(
          `[ymd][ffmpeg] readFile after copy failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (!outBytes || outBytes.byteLength < 1024) {
      // Copy mux failed — try transcoding audio to AAC.
      console.info(
        `[ymd][ffmpeg] copy mux produced ${outBytes?.byteLength ?? 0}B, retrying with audio→AAC transcode`,
      );
      try {
        await ff.deleteFile(outPath);
      } catch {
        /* ignore */
      }
      const transcodeArgs = [
        "-i", videoPath,
        "-i", audioPath,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "-movflags", "+faststart",
        "-y", outPath,
      ];
      console.info(`[ymd][ffmpeg] exec transcode: ${transcodeArgs.join(" ")}`);
      const t1 = performance.now();
      const trRet = await ff.exec(transcodeArgs);
      console.info(
        `[ymd][ffmpeg] transcode mux finished in ${(performance.now() - t1).toFixed(0)}ms ret=${trRet}`,
      );
      if (trRet !== 0) {
        const tail = ffmpegLogs.slice(-20).join(" | ");
        return {
          ok: false,
          reason: `ffmpeg transcode failed (ret=${trRet}); last logs: ${tail}`,
        };
      }
      try {
        const data = await ff.readFile(outPath);
        outBytes = typeof data === "string"
          ? new TextEncoder().encode(data)
          : data;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `readFile after transcode failed: ${msg}` };
      }
    }
    if (!outBytes || outBytes.byteLength < 1024) {
      const tail = ffmpegLogs.slice(-20).join(" | ");
      return {
        ok: false,
        reason: `ffmpeg produced empty output (${outBytes?.byteLength ?? 0}B); last logs: ${tail}`,
      };
    }
    console.info(
      `[ymd][ffmpeg] output ${outBytes.byteLength}B (${(outBytes.byteLength / 1024 / 1024).toFixed(2)} MB)`,
    );
    return { ok: true, bytes: outBytes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `ffmpeg exec threw: ${msg}` };
  } finally {
    // Clean up virtual FS to free memory for the next mux.
    for (const p of [audioPath, videoPath, outPath]) {
      try {
        await ff.deleteFile(p);
      } catch {
        /* ignore — file may not exist if exec failed early */
      }
    }
  }
}

function looksWebm(b: Uint8Array): boolean {
  return (
    b.byteLength > 4 &&
    b[0] === 0x1a &&
    b[1] === 0x45 &&
    b[2] === 0xdf &&
    b[3] === 0xa3
  );
}
