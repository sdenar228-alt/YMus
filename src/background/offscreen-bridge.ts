// Offscreen Document bridge.
//
// В Service Worker MV3 нет Web Audio API. Web Audio (включая OfflineAudioContext.
// decodeAudioData) доступен только в полноценном документе. Offscreen Documents
// API позволяет создать невидимый HTML-документ из SW и общаться с ним через
// chrome.runtime.sendMessage.
//
// Сложности, которые этот модуль обходит:
// 1. Нельзя создать второй offscreen-документ, если уже есть. Проверяем через
//    chrome.runtime.getContexts (Chrome 116+).
// 2. Создание возвращает Promise до того как offscreen.js полностью загрузится
//    и зарегистрирует onMessage listener. Поэтому пингуем документ до ответа.
// 3. Параллельные вызовы должны переиспользовать одну попытку создания.
// 4. Передача больших Uint8Array через sendMessage сериализуется через JSON,
//    Array<number> на 4 МБ → ~30 МБ JSON. Используем base64 — в 5× компактнее.

import { bytesToBase64, base64ToBytes } from "../shared/base64";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const READY_TIMEOUT_MS = 5000;
const READY_POLL_INTERVAL_MS = 50;

let creating: Promise<void> | null = null;

interface ChromeWithGetContexts {
  runtime: {
    getContexts?: (filter: {
      contextTypes: string[];
      documentUrls?: string[];
    }) => Promise<Array<unknown>>;
  };
}

async function hasOffscreenDocument(): Promise<boolean> {
  const c = chrome as unknown as ChromeWithGetContexts;
  if (typeof c.runtime.getContexts !== "function") return false;
  try {
    const url = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const contexts = await c.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

/** Отправить ping в offscreen, вернуть true если ответил. */
async function pingOffscreen(): Promise<boolean> {
  try {
    const r = (await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "PING",
    })) as { pong?: boolean } | undefined;
    return r?.pong === true;
  } catch {
    return false;
  }
}

async function waitForReady(): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    if (await pingOffscreen()) return true;
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  return false;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) {
    // Документ есть — но всё равно убедимся, что listener жив.
    const ready = await waitForReady();
    if (!ready) {
      throw new Error(
        "Offscreen документ существует, но не отвечает на PING (возможно завис)",
      );
    }
    return;
  }

  if (creating !== null) {
    await creating;
    return;
  }

  console.info("[ymd][offscreen] создаю документ", OFFSCREEN_DOCUMENT_PATH);
  creating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        // BLOBS подходит лучше чем AUDIO_PLAYBACK — мы не воспроизводим звук,
        // а декодируем blob/ArrayBuffer.
        reasons: ["BLOBS" as chrome.offscreen.Reason],
        justification:
          "Декодирование FLAC/MP3 в PCM через Web Audio API (OfflineAudioContext недоступен в SW)",
      });
    } catch (e) {
      // "Only a single offscreen document may be created" — игнор, документ уже
      // создаётся параллельно (race condition).
      const msg = e instanceof Error ? e.message : String(e);
      if (!/single offscreen document/i.test(msg)) {
        throw e;
      }
      console.info("[ymd][offscreen] документ уже создан параллельно");
    }
    const ready = await waitForReady();
    if (!ready) {
      throw new Error(
        "Offscreen документ создан, но listener не зарегистрировался за " +
          READY_TIMEOUT_MS +
          "ms",
      );
    }
    console.info("[ymd][offscreen] готов");
  })().finally(() => {
    creating = null;
  });

  await creating;
}

export interface OffscreenDecodeResult {
  success: true;
  pcmData: Uint8Array;
  sampleRate: number;
  channels: number;
}

export interface OffscreenDecodeError {
  success: false;
  reason: string;
}

/**
 * Отправить сырые аудиобайты в offscreen-документ для декодирования в PCM.
 */
export async function decodeAudioInOffscreen(
  sourceBytes: Uint8Array,
  sourceMime: string,
): Promise<OffscreenDecodeResult | OffscreenDecodeError> {
  try {
    await ensureOffscreenDocument();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[ymd][offscreen] ensure упал:", msg);
    return {
      success: false,
      reason: `Не удалось подготовить offscreen-документ: ${msg}`,
    };
  }

  console.info(
    "[ymd][offscreen] отправляю декод-запрос, bytes=",
    sourceBytes.length,
  );

  const t0 = performance.now();
  const bytesB64 = bytesToBase64(sourceBytes);
  console.info(
    `[ymd][offscreen] base64 encode → ${(performance.now() - t0).toFixed(0)}ms (${bytesB64.length} chars)`,
  );

  let resp: unknown;
  try {
    resp = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "DECODE_AUDIO_TO_PCM",
      payload: {
        bytesB64,
        sourceMime,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[ymd][offscreen] sendMessage threw:", msg);
    return {
      success: false,
      reason: `Offscreen не ответил: ${msg}`,
    };
  }

  console.info("[ymd][offscreen] получен ответ:", {
    success: (resp as { success?: boolean })?.success,
    reason: (resp as { reason?: string })?.reason,
    pcmLen: (resp as { pcmDataB64?: string })?.pcmDataB64?.length,
  });

  const r = resp as
    | {
        success: boolean;
        pcmDataB64?: string;
        sampleRate?: number;
        channels?: number;
        reason?: string;
      }
    | undefined;

  if (!r || r.success !== true) {
    return {
      success: false,
      reason: r?.reason ?? "Offscreen вернул пустой ответ",
    };
  }

  if (
    typeof r.pcmDataB64 !== "string" ||
    typeof r.sampleRate !== "number" ||
    typeof r.channels !== "number"
  ) {
    return {
      success: false,
      reason: "Offscreen вернул некорректные PCM-данные",
    };
  }

  return {
    success: true,
    pcmData: base64ToBytes(r.pcmDataB64),
    sampleRate: r.sampleRate,
    channels: r.channels,
  };
}

export interface OffscreenFlacResult {
  success: true;
  flacBytes: Uint8Array;
  sampleRate: number;
  channels: number;
}

/**
 * Перепаковать MP3 (или любой декодируемый source) в FLAC через offscreen+libflac.
 * Возвращает уже готовые FLAC-байты без вшитых тегов — теги добавляются
 * вызывающим через embedFlacMetadata.
 */
export async function encodeMp3ToFlacInOffscreen(
  sourceBytes: Uint8Array,
  sourceMime: string,
): Promise<OffscreenFlacResult | OffscreenDecodeError> {
  try {
    await ensureOffscreenDocument();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[ymd][offscreen] ensure упал:", msg);
    return {
      success: false,
      reason: `Не удалось подготовить offscreen-документ: ${msg}`,
    };
  }

  console.info(
    "[ymd][offscreen] отправляю FLAC-encode-запрос, bytes=",
    sourceBytes.length,
  );

  const t0 = performance.now();
  const bytesB64 = bytesToBase64(sourceBytes);
  console.info(
    `[ymd][offscreen] base64 encode → ${(performance.now() - t0).toFixed(0)}ms (${bytesB64.length} chars)`,
  );

  let resp: unknown;
  try {
    resp = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "ENCODE_AUDIO_TO_FLAC",
      payload: {
        bytesB64,
        sourceMime,
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[ymd][offscreen] sendMessage threw:", msg);
    return {
      success: false,
      reason: `Offscreen не ответил: ${msg}`,
    };
  }

  console.info("[ymd][offscreen] FLAC-encode ответ:", {
    success: (resp as { success?: boolean })?.success,
    reason: (resp as { reason?: string })?.reason,
    flacLen: (resp as { flacDataB64?: string })?.flacDataB64?.length,
  });

  const r = resp as
    | {
        success: boolean;
        flacDataB64?: string;
        sampleRate?: number;
        channels?: number;
        reason?: string;
      }
    | undefined;

  if (!r || r.success !== true) {
    return {
      success: false,
      reason: r?.reason ?? "Offscreen вернул пустой ответ",
    };
  }

  if (
    typeof r.flacDataB64 !== "string" ||
    typeof r.sampleRate !== "number" ||
    typeof r.channels !== "number"
  ) {
    return {
      success: false,
      reason: "Offscreen вернул некорректные FLAC-данные",
    };
  }

  const flacBytes = base64ToBytes(r.flacDataB64);
  console.info(
    "[ymd][offscreen-bridge] FLAC magic после base64 decode:",
    flacBytes[0]?.toString(16),
    flacBytes[1]?.toString(16),
    flacBytes[2]?.toString(16),
    flacBytes[3]?.toString(16),
    "(expected 66 4c 61 43), len=",
    flacBytes.length,
  );

  return {
    success: true,
    flacBytes,
    sampleRate: r.sampleRate,
    channels: r.channels,
  };
}

// ─── Download via offscreen Blob ──────────────────────────────────────────────

export interface OffscreenDownloadResult {
  success: true;
  downloadId: number;
}

export interface OffscreenDownloadError {
  success: false;
  reason: string;
}

interface OffscreenBlobUrlSuccess {
  success: true;
  blobUrl: string;
  /** When true, the offscreen document already triggered the download via
   *  a synthetic `<a download>` click — the SW must NOT call
   *  chrome.downloads.download again, that would double-save the file. */
  viaAnchor?: boolean;
}

interface OffscreenBlobUrlError {
  success: false;
  reason: string;
}

/**
 * Detect browsers where chrome.downloads.download silently ignores the
 * `filename` parameter when the URL is a `blob:` URL. On those browsers
 * we have to fall back to the anchor-click path inside the offscreen
 * document. As of writing, the only known case is Yandex Browser on macOS
 * (Vivaldi, Chrome, Edge, Brave, Opera and Firefox all honour `filename`
 * fine for blob URLs).
 */
function shouldUseAnchorDownload(): boolean {
  try {
    const ua = navigator.userAgent || "";
    const isMac = /Macintosh|Mac OS X/i.test(ua);
    if (!isMac) return false;
    return /YaBrowser|Yowser/i.test(ua);
  } catch {
    return false;
  }
}

function normalizeDownloadFilename(filename: string): string {
  const trimmed = filename.trim();
  const safe = trimmed.length > 0 ? trimmed : "YMus - download";
  const cleaned = safe.replace(/[\\/:*?"<>|]/g, "_").replace(/[\u0000-\u001f]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "YMus - download";
}

/**
 * Save bytes as a file via the offscreen document.
 *
 * The offscreen document mints a `blob:` URL for the bytes and hands it
 * back. We then call `chrome.downloads.download(blobUrl, filename)` —
 * fast path that returns a real downloadId. On the few browsers where
 * `chrome.downloads.download({filename})` is silently ignored for blob
 * URLs (Yandex/Vivaldi on macOS), we instead ask the offscreen document
 * to trigger the download itself via an `<a download>` click.
 *
 * @param bytes — file contents
 * @param mime — MIME type for the Blob (e.g. "audio/mpeg", "video/mp4")
 * @param filename — desired filename (with extension)
 * @param saveAs — show the Save As dialog (optional)
 */
export async function downloadViaOffscreenBlob(
  bytes: Uint8Array,
  mime: string,
  filename: string,
  saveAs = false,
): Promise<OffscreenDownloadResult | OffscreenDownloadError> {
  await ensureOffscreenDocument();

  const useAnchor = shouldUseAnchorDownload();
  const safeFilename = normalizeDownloadFilename(filename);

  const bytesB64 = bytesToBase64(bytes);
  const r = (await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "DOWNLOAD_VIA_BLOB",
    payload: { bytesB64, sourceMime: mime, filename: safeFilename, saveAs, useAnchor },
  })) as OffscreenBlobUrlSuccess | OffscreenBlobUrlError | undefined;

  if (!r) {
    return { success: false, reason: "Offscreen did not respond" };
  }
  if (!r.success) {
    return { success: false, reason: r.reason };
  }

  // Anchor-click branch: the offscreen document already kicked off the
  // download via <a download>. We don't get a chrome.downloads id back —
  // synthesise a success with -1 so callers know the save was best-effort.
  if (r.viaAnchor) {
    return { success: true, downloadId: -1 };
  }

  // Fast path: hand the blob URL to chrome.downloads.download. This gives
  // us a real numeric id and the browser tracks the file properly.
  try {
    const downloadId = await chrome.downloads.download({
      url: r.blobUrl,
      filename: safeFilename,
      saveAs,
      conflictAction: "uniquify",
    });
    if (downloadId === undefined) {
      return { success: false, reason: "downloads.download returned no id" };
    }
    return { success: true, downloadId };
  } catch (err: any) {
    return { success: false, reason: err?.message || String(err) };
  }
}

// ─── Chunked download for files larger than the IPC limit ────────────────────

interface OffscreenChunkAck {
  success: boolean;
  reason?: string;
  blobUrl?: string;
  viaAnchor?: boolean;
}

/**
 * Save a large byte array (>64 MB) via the offscreen document by streaming it
 * over chrome.runtime.sendMessage in 32 MB chunks.
 *
 * The IPC layer has a hard 64 MB cap per message — sending a 300 MB 4K video
 * in one shot fails with "Message exceeded maximum allowed size of 64MiB".
 * Sending it in 32 MB pieces (which become ~43 MB after base64) stays well
 * under the cap and lets the offscreen document reassemble the Blob and
 * trigger an anchor-click download.
 *
 * Used by YouTube video downloads. Audio downloads (Yandex Music, < 20 MB)
 * keep using `downloadViaOffscreenBlob` — single-shot is faster for small
 * files.
 *
 * Returns success with a synthetic downloadId of -1 (the real download was
 * triggered by an `<a download>` click in the offscreen document, not by
 * chrome.downloads.download, so there is no real id).
 */
export async function downloadViaOffscreenChunked(
  bytes: Uint8Array,
  mime: string,
  filename: string,
): Promise<OffscreenDownloadResult | OffscreenDownloadError> {
  await ensureOffscreenDocument();

  // 32 MB raw → ~43 MB base64. Comfortably under the 64 MB IPC cap with
  // headroom for the message envelope.
  const CHUNK_SIZE = 32 * 1024 * 1024;
  const sessionId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // INIT
  try {
    const initRes = (await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "DOWNLOAD_BLOB_INIT",
      payload: { sessionId, sourceMime: mime, totalBytes: bytes.length },
    })) as OffscreenChunkAck | undefined;
    if (!initRes?.success) {
      return { success: false, reason: initRes?.reason || "init failed" };
    }
  } catch (err: any) {
    return { success: false, reason: err?.message || String(err) };
  }

  // CHUNK loop
  const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE);
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, bytes.length);
    const slice = bytes.subarray(start, end);
    const sliceB64 = bytesToBase64(slice);
    try {
      const ack = (await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "DOWNLOAD_BLOB_CHUNK",
        payload: { sessionId, chunkIndex: i, bytesB64: sliceB64, sourceMime: mime },
      })) as OffscreenChunkAck | undefined;
      if (!ack?.success) {
        return { success: false, reason: ack?.reason || `chunk ${i} failed` };
      }
    } catch (err: any) {
      return { success: false, reason: err?.message || String(err) };
    }
  }

  // FINISH — offscreen builds the Blob, mints a blob: URL, fires the anchor click.
  try {
    const finRes = (await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "DOWNLOAD_BLOB_FINISH",
      payload: { sessionId, filename, sourceMime: mime },
    })) as OffscreenChunkAck | undefined;
    if (!finRes?.success) {
      return { success: false, reason: finRes?.reason || "finish failed" };
    }
    return { success: true, downloadId: -1 };
  } catch (err: any) {
    return { success: false, reason: err?.message || String(err) };
  }
}


// ─── YouTube video+audio mux to MP4 ──────────────────────────────────────────

export interface MuxMp4Result {
  success: true;
  /** Final muxed MP4 bytes (init segment + interleaved video/audio). */
  bytes: Uint8Array;
}

export interface MuxMp4Error {
  success: false;
  reason: string;
}

/**
 * Send the captured audio + video buffers from the YouTube buffer-capture
 * pipeline to the offscreen document, where mediabunny remuxes them into a
 * single MP4 file. Returns the muxed MP4 bytes ready to be saved.
 *
 * Bytes are streamed in chunks because a 4K video can easily exceed the
 * 64 MB IPC cap per single sendMessage. We reuse the chunked-upload
 * pattern from `downloadViaOffscreenChunked`: INIT → CHUNK* → FINISH,
 * with the FINISH step performing the mux in offscreen and returning
 * the muxed bytes back over IPC.
 *
 * The audio/video iTags are passed alongside so offscreen knows the
 * codec containers (e.g. mp4 H.264 vs webm VP9 vs m4a AAC vs webm Opus).
 *
 * @param audioBytes   Captured audio bytes (init segment + media chunks
 *                     concatenated by the bridge).
 * @param videoBytes   Captured video bytes (same shape as audio).
 * @param audioITag    YouTube audio iTag (140/141/249/250/251/256/258).
 * @param videoITag    YouTube video iTag (135/136/137/244/247/248/271/313/397-401).
 */
export async function muxToMp4InOffscreen(
  audioBytes: Uint8Array,
  videoBytes: Uint8Array,
  audioITag: number,
  videoITag: number,
): Promise<MuxMp4Result | MuxMp4Error> {
  await ensureOffscreenDocument();

  const sessionId = `mux_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  // mediabunny + the source byte buffers all live in offscreen memory; we
  // stream the source bytes in 32 MB chunks to stay under the 64 MB IPC
  // cap. The muxed result is returned in one shot from FINISH because
  // it is typically smaller than the input (no transcode, just remux).
  const CHUNK_SIZE = 32 * 1024 * 1024;

  async function streamUpload(
    streamId: string,
    bytes: Uint8Array,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE) || 1;
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, bytes.length);
      const slice = bytes.subarray(start, end);
      const sliceB64 = bytesToBase64(slice);
      try {
        const ack = (await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "MUX_MP4_CHUNK",
          payload: {
            sessionId,
            streamId,
            chunkIndex: i,
            bytesB64: sliceB64,
            isLast: i === totalChunks - 1,
          },
        })) as { success?: boolean; reason?: string } | undefined;
        if (!ack?.success) {
          return { ok: false, reason: ack?.reason || `chunk ${i} of ${streamId} failed` };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: msg };
      }
    }
    return { ok: true };
  }

  // INIT — offscreen allocates per-session state for both streams.
  try {
    const initRes = (await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "MUX_MP4_INIT",
      payload: {
        sessionId,
        audioITag,
        videoITag,
        audioBytesTotal: audioBytes.length,
        videoBytesTotal: videoBytes.length,
      },
    })) as { success?: boolean; reason?: string } | undefined;
    if (!initRes?.success) {
      return { success: false, reason: initRes?.reason || "MUX_MP4_INIT failed" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, reason: msg };
  }

  // Upload audio + video bytes in chunks.
  const ua = await streamUpload("audio", audioBytes);
  if (!ua.ok) return { success: false, reason: ua.reason };
  const uv = await streamUpload("video", videoBytes);
  if (!uv.ok) return { success: false, reason: uv.reason };

  // FINISH — offscreen runs mediabunny on the assembled buffers and
  // returns the muxed MP4 bytes.
  try {
    const finRes = (await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "MUX_MP4_FINISH",
      payload: { sessionId },
    })) as { success?: boolean; reason?: string; muxedB64?: string } | undefined;
    if (!finRes?.success || typeof finRes.muxedB64 !== "string") {
      return { success: false, reason: finRes?.reason || "MUX_MP4_FINISH failed" };
    }
    const muxed = base64ToBytes(finRes.muxedB64);
    return { success: true, bytes: muxed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, reason: msg };
  }
}


// ─── YouTube end-to-end download (delegated to offscreen) ────────────────────

/**
 * Ensure the offscreen document is up and ready before sending a long-running
 * `YT_INNERTUBE_DOWNLOAD` request. The offscreen handler does its own work but
 * needs the document to exist first; without this helper the SW would be
 * forced to open it via a side-effect of one of the existing public bridge
 * helpers, which is awkward.
 */
export async function ensureOffscreenForYt(): Promise<void> {
  await ensureOffscreenDocument();
}
