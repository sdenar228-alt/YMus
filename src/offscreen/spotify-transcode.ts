/**
 * Spotify Ogg Vorbis → MP3 транскодер (выполняется в offscreen-документе).
 *
 * Принимает уже расшифрованный Ogg Vorbis-буфер от оркестратора
 * `spotify-download-handler` и возвращает MP3 192 kbps c сохранением
 * исходной частоты дискретизации и числа каналов. Реализован поверх
 * существующего `ffmpeg-worker.js` / `ffmpeg-core.wasm` (см.
 * `src/offscreen/ffmpeg-worker-entry.ts`, `manifest.json` →
 * `web_accessible_resources`) через обёртку `@ffmpeg/ffmpeg`, как и
 * YouTube-mux в `yt-mp4-muxer.ts`.
 *
 * Контракт:
 *   - принимает только MIME `audio/ogg; codecs="vorbis"` (R11.1);
 *   - параметры ffmpeg: `-c:a libmp3lame -b:a 192k`, sample rate и каналы
 *     наследуются из источника (R11.2);
 *   - результат начинается либо с ID3v2 (`"ID3"`), либо с MP3 sync-frame
 *     `0xFF 0xEx`, иначе бросаем ошибку (R11.3); оркестратор маппит
 *     любой бросок в `SPOTIFY_TRANSCODE_FAILED`;
 *   - таймер 60 000 мс применяется на стороне SW (R11.4) — здесь
 *     собственного таймаута нет.
 *
 * Singleton ffmpeg-инстанса локален файлу, чтобы не плодить зависимостей
 * от `yt-mp4-muxer.ts`. ffmpeg-core ~31 МБ грузится один раз за время
 * жизни offscreen-документа; повторные вызовы переиспользуют инстанс.
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";

/** Единственный поддерживаемый MIME входа (R11.1). */
const ALLOWED_MIME = 'audio/ogg; codecs="vorbis"';

/** Singleton ffmpeg + дедупликация конкурентной загрузки. */
let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;
/** Кольцевой буфер последних ffmpeg-логов (для диагностики). */
const ffmpegLogs: string[] = [];

/**
 * Возвращает загруженный ffmpeg-инстанс. Первый вызов запускает
 * `load()` и кеширует промис; конкурентные первые вызовы дедуплицируются.
 */
async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance && ffmpegInstance.loaded) return ffmpegInstance;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;
  ffmpegLoadPromise = (async () => {
    const ff = new FFmpeg();
    ff.on("log", ({ message }) => {
      ffmpegLogs.push(message);
      if (ffmpegLogs.length > 200) ffmpegLogs.shift();
      if (
        /error|invalid|failed|missing|corrupt/i.test(message) &&
        !/non-monotonic|deprecated/i.test(message)
      ) {
        console.warn(`[ymd][spotify-ffmpeg] ${message}`);
      }
    });
    // Грузим core/wasm/worker из bundled-ресурсов расширения.
    // chrome.runtime.getURL доступен в offscreen-документе.
    const coreURL = chrome.runtime.getURL("ffmpeg-core.js");
    const wasmURL = chrome.runtime.getURL("ffmpeg-core.wasm");
    const classWorkerURL = chrome.runtime.getURL("ffmpeg-worker.js");
    console.info(
      `[ymd][spotify-ffmpeg] loading core from ${coreURL} + worker from ${classWorkerURL}`,
    );
    const t0 = performance.now();
    try {
      await ff.load({ coreURL, wasmURL, classWorkerURL });
    } catch (err) {
      // Сбрасываем кеш — следующий вызов попробует заново.
      ffmpegInstance = null;
      ffmpegLoadPromise = null;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ffmpeg load failed: ${msg}`);
    }
    console.info(
      `[ymd][spotify-ffmpeg] loaded in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    ffmpegInstance = ff;
    return ff;
  })();
  return ffmpegLoadPromise;
}

/**
 * Проверяет, что байты начинаются с валидного MP3-заголовка:
 * либо ID3v2 (`"ID3"` = 0x49 0x44 0x33), либо синхро-фрейм MP3
 * (первый байт 0xFF, у второго старшие 3 бита `111` → `(b & 0xE0) === 0xE0`).
 *
 * Достаточно проверки первых 3 байт: ID3v2 диагностируется по 3 байтам,
 * sync-frame — по 2; запрашиваем 3 байта, чтобы единая ветка покрывала оба.
 */
function isValidMp3Header(out: Uint8Array): boolean {
  if (out.byteLength < 3) return false;
  const b0 = out[0];
  const b1 = out[1];
  const b2 = out[2];
  const isId3 = b0 === 0x49 && b1 === 0x44 && b2 === 0x33;
  const isSyncFrame = b0 === 0xff && (b1 & 0xe0) === 0xe0;
  return isId3 || isSyncFrame;
}

/**
 * Транскодирует Ogg Vorbis-байты в MP3 192 kbps через ffmpeg.wasm.
 *
 * @param bytes Расшифрованный Ogg Vorbis-буфер (после `validateDecryption`).
 * @param mime  Должен ровно равняться `audio/ogg; codecs="vorbis"`.
 * @returns     MP3-байты, начинающиеся либо с ID3v2-тега, либо со sync-frame.
 * @throws      `Error` с описательным сообщением; оркестратор (task 4.1)
 *              ловит его и эмитит `SPOTIFY_TRANSCODE_FAILED` (R11.4).
 */
export async function encodeOggToMp3(
  bytes: Uint8Array,
  mime: string,
): Promise<Uint8Array> {
  // R11.1 — строгая проверка MIME. Любой другой формат отклоняется.
  if (mime !== ALLOWED_MIME) {
    throw new Error("encodeOggToMp3: unsupported MIME: " + mime);
  }
  if (bytes.byteLength === 0) {
    throw new Error("encodeOggToMp3: input buffer is empty");
  }

  let ff: FFmpeg;
  try {
    ff = await getFFmpeg();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error("encodeOggToMp3: " + msg);
  }

  // Имена в виртуальной FS ffmpeg.wasm. ffmpeg всё равно автодетектит
  // формат по magic-байтам, но корректное расширение помогает выбрать
  // демуксер без лишних проб.
  const inputPath = "input.ogg";
  const outputPath = "output.mp3";

  try {
    ffmpegLogs.length = 0;
    console.info(
      `[ymd][spotify-ffmpeg] writing ${inputPath} (${bytes.byteLength}B)`,
    );
    // ffmpeg.wasm передаёт ArrayBuffer как transferable во worker —
    // исходный `bytes` после writeFile использовать нельзя. Это нас не
    // задевает: больше мы к нему не обращаемся.
    await ff.writeFile(inputPath, bytes);

    // R11.2 — параметры транскода. Sample rate / каналы наследуются
    // автоматически (без `-ar`/`-ac` ffmpeg оставляет исходные).
    const args = [
      "-i",
      inputPath,
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      outputPath,
    ];
    console.info(`[ymd][spotify-ffmpeg] exec: ${args.join(" ")}`);
    const t0 = performance.now();
    const ret = await ff.exec(args);
    console.info(
      `[ymd][spotify-ffmpeg] exec finished in ${(performance.now() - t0).toFixed(0)}ms ret=${ret}`,
    );
    if (ret !== 0) {
      const tail = ffmpegLogs.slice(-20).join(" | ");
      throw new Error(
        `encodeOggToMp3: ffmpeg exit code ${ret}; last logs: ${tail}`,
      );
    }

    const data = await ff.readFile(outputPath);
    const out =
      typeof data === "string" ? new TextEncoder().encode(data) : data;

    // R11.3 — валидация MP3-заголовка. Без этого мы могли бы отдать
    // SW что угодно (например, ffmpeg при странных входах генерит
    // пустой/повреждённый файл с ret=0). Бросок здесь оркестратор
    // мапит на SPOTIFY_TRANSCODE_FAILED.
    if (!isValidMp3Header(out)) {
      throw new Error(
        "encodeOggToMp3: output is not a valid MP3 (no ID3 or sync frame)",
      );
    }

    console.info(
      `[ymd][spotify-ffmpeg] output ${out.byteLength}B (${(out.byteLength / 1024).toFixed(1)} KB)`,
    );
    return out;
  } finally {
    // Чистим виртуальную FS, чтобы повторные вызовы не накапливали
    // мусор и не путали ffmpeg при коллизиях имён.
    for (const p of [inputPath, outputPath]) {
      try {
        await ff.deleteFile(p);
      } catch {
        // файл может отсутствовать, если exec упал до writeFile/readFile
      }
    }
  }
}
