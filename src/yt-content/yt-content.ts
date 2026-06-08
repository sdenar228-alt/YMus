/**
 * YouTube content script entry point.
 *
 * SABR-replay architecture (post-revert): the SW captures the player's
 * `googlevideo.com/videoplayback` POSTs via `chrome.webRequest`. The
 * content script just needs to make sure the player has issued at least
 * one such POST before the user clicks "Скачать" — i.e. the user must
 * have started playback. The click flow is:
 *
 *   1. Pre-flight the distribution-protection guard (`YT_CHECK_GUARD`).
 *   2. Live / DRM screening (surface `LIVE_STREAM` / `DRM_PROTECTED`).
 *   3. Switch player quality through the bridge (`SET_QUALITY`) so the
 *      replayed iTags match the user's preference.
 *   4. Reload the player + sleep so the SW captures a fresh SABR body.
 *   5. `chrome.runtime.sendMessage({ type: "YT_DOWNLOAD_VIDEO", payload:
 *      { videoId, url, title, durationSec } })`.
 *
 * The SW handles everything else: parses the captured bodies, replays
 * them, muxes the result via mediabunny, and saves the MP4. No bytes
 * round-trip from this content script.
 */

import { startSpaObserver } from "./yt-spa-observer";
import { injectDownloadButton, YtDownloadButton } from "./yt-button-injector";
import {
  collectPlaylistVideoIds,
  getCurrentPlaylistId,
  injectPlaylistDownloadButton,
  PlaylistDownloadButton,
} from "./yt-playlist-injector";
import { forceFullBuffer } from "./yt-buffer-capture";

const TAG = "[YMus YT]";

/** Auto-resume storage key — preserved verbatim from legacy. */
const AUTO_DOWNLOAD_KEY = "ymus_yt_pending_download";
/** Auto-resume TTL — 180 s (legacy contract). */
const AUTO_DOWNLOAD_TTL_MS = 180_000;

/** Bridge round-trip timeout for short actions (SET_QUALITY, RELOAD_VIDEO). */
const BRIDGE_SHORT_TIMEOUT_MS = 2_000;
/** Settle delay after a successful quality switch. */
const QUALITY_SETTLE_DELAY_MS = 1_500;
/** Sleep after RELOAD_VIDEO so webRequest can record the SABR body. */
const RELOAD_SETTLE_MS = 2_500;
/** Sleep when we did not need to reload but want a SABR body to be recorded. */
const PLAYBACK_SETTLE_MS = 1_500;

/** Page-age window where a click is treated as a "fresh load". */
const FRESH_LOAD_MIN_AGE_MS = 1_500;
const FRESH_LOAD_MAX_AGE_MS = 60_000;

/** Currently active button instance (single-video). */
let currentButton: YtDownloadButton | null = null;

/** Currently displayed video ID. */
let currentVideoId: string | null = null;

/** Re-entry guard for `runClickFlow`. */
let clickFlowInProgress = false;
let currentClickFlowVideoId: string | null = null;

/** The last buffer-capture progress value the runClickFlow saw, in 0..100
 *  (i.e. 0..70 % on the overall bar). Cleared at the start of each click
 *  flow. Used by the YT_DOWNLOAD_PROGRESS listener to lerp the SW
 *  download phase from this floor up to 90 % so the visual bar never
 *  jumps forward when buffering finished early. */
let lastBufferCapturePct = 0;

// ─── Video type detection ────────────────────────────────────────────────────

function getVideoType(): "regular" | "shorts" {
  return location.pathname.startsWith("/shorts/") ? "shorts" : "regular";
}

// ─── Title extraction ────────────────────────────────────────────────────────

function extractVideoTitle(): string {
  try {
    const player = document.getElementById("movie_player") as
      | (HTMLElement & { getVideoData?: () => { title?: string } })
      | null;
    const fromPlayer = player?.getVideoData?.()?.title;
    if (typeof fromPlayer === "string" && fromPlayer.trim().length > 0) {
      return fromPlayer.trim();
    }
  } catch {
    /* ignore */
  }
  try {
    const h1 = document.querySelector(
      "h1.ytd-watch-metadata yt-formatted-string, h1.ytd-watch-metadata, ytd-watch-metadata h1",
    );
    const fromH1 = h1?.textContent?.trim();
    if (fromH1 && fromH1.length > 0) return fromH1;
  } catch {
    /* ignore */
  }
  try {
    const meta = document.querySelector(
      'meta[name="title"]',
    ) as HTMLMetaElement | null;
    const fromMeta = meta?.content?.trim();
    if (fromMeta && fromMeta.length > 0) return fromMeta;
  } catch {
    /* ignore */
  }
  try {
    let t = document.title || "";
    t = t.replace(/^\s*\(\d+\)\s*/, "");
    t = t.replace(/\s+-\s+YouTube\s*$/, "");
    if (t.trim().length > 0) return t.trim();
  } catch {
    /* ignore */
  }
  return "youtube_video";
}

// ─── Player helpers ──────────────────────────────────────────────────────────

interface YtVideoData {
  title?: string;
  isLive?: boolean;
  isLiveContent?: boolean;
  isDrmProtected?: boolean;
}

interface YtPlayer extends HTMLElement {
  getVideoData?: () => YtVideoData;
}

function getMoviePlayer(): YtPlayer | null {
  try {
    return document.getElementById("movie_player") as YtPlayer | null;
  } catch {
    return null;
  }
}

function getPlayerVideoData(): YtVideoData | null {
  try {
    return getMoviePlayer()?.getVideoData?.() ?? null;
  } catch {
    return null;
  }
}

function getOnPageVideo(): HTMLVideoElement | null {
  try {
    return document.querySelector("video") as HTMLVideoElement | null;
  } catch {
    return null;
  }
}

function pausePlayer(): void {
  try {
    const v = getOnPageVideo();
    if (v && !v.paused) v.pause();
  } catch {
    /* ignore */
  }
}

// ─── Quality preference ──────────────────────────────────────────────────────

async function getPreferredQualityHeight(): Promise<number> {
  try {
    const result = await chrome.storage.local.get("ytPreferredQuality");
    const stored = (result as { ytPreferredQuality?: unknown }).ytPreferredQuality;
    switch (stored) {
      case "480p":
        return 480;
      case "720p":
        return 720;
      case "1080p":
        return 1080;
      case "2K":
        return 1440;
      case "4K":
        return 2160;
      default:
        return 1080;
    }
  } catch {
    return 1080;
  }
}

// ─── Auto-resume ─────────────────────────────────────────────────────────────

interface PendingDownload {
  videoId: string;
  expiresAt: number;
  playlist?: { ids: string[]; index: number };
}

async function markAutoDownload(
  videoId: string,
  playlist?: { ids: string[]; index: number },
): Promise<void> {
  const data: PendingDownload = {
    videoId,
    expiresAt: Date.now() + AUTO_DOWNLOAD_TTL_MS,
    ...(playlist ? { playlist } : {}),
  };
  await chrome.storage.local.set({ [AUTO_DOWNLOAD_KEY]: data });
}

async function consumePendingAutoDownload(): Promise<PendingDownload | null> {
  try {
    const result = await chrome.storage.local.get(AUTO_DOWNLOAD_KEY);
    const data = (result as Record<string, unknown>)[AUTO_DOWNLOAD_KEY] as
      | PendingDownload
      | undefined;
    if (!data || typeof data !== "object") return null;
    await chrome.storage.local.remove(AUTO_DOWNLOAD_KEY);
    if (typeof data.expiresAt !== "number" || Date.now() > data.expiresAt) {
      console.log(
        `${TAG} [auto-resume] pending download expired for ${data.videoId}`,
      );
      return null;
    }
    return data;
  } catch (e) {
    console.error(`${TAG} [auto-resume] consume failed`, e);
    return null;
  }
}

function isFreshLoadForVideo(videoId: string): boolean {
  try {
    const nav = performance.getEntriesByType?.("navigation")?.[0];
    if (!nav) return false;
    const ageMs = performance.now();
    if (ageMs > FRESH_LOAD_MIN_AGE_MS && ageMs < FRESH_LOAD_MAX_AGE_MS) {
      const params = new URLSearchParams(location.search);
      if (params.get("v") === videoId) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

// ─── Bridge round-trip helper ────────────────────────────────────────────────

interface BridgeResponseEnvelope {
  source?: unknown;
  action?: unknown;
}

function postBridge<TRes = unknown>(
  action: string,
  payload: Record<string, unknown>,
  expectedResponseAction: string,
  timeoutMs: number = BRIDGE_SHORT_TIMEOUT_MS,
): Promise<TRes | null> {
  return new Promise((resolve) => {
    let settled = false;
    const handler = (event: MessageEvent): void => {
      if (settled) return;
      if (event.source !== window) return;
      const data = event.data as BridgeResponseEnvelope | null;
      if (!data || data.source !== "ymus-yt-bridge") return;
      if (data.action !== expectedResponseAction) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", handler);
      resolve(data as unknown as TRes);
    };
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", handler);
      console.warn(
        `${TAG} [bridge] timeout waiting for ${expectedResponseAction} (action=${action}, ${timeoutMs}ms)`,
      );
      resolve(null);
    }, timeoutMs);
    window.addEventListener("message", handler);
    try {
      window.postMessage(
        { source: "ymus-yt-content", action, ...payload },
        "*",
      );
    } catch (e) {
      if (!settled) {
        settled = true;
        window.clearTimeout(timer);
        window.removeEventListener("message", handler);
        console.error(`${TAG} [bridge] postMessage threw`, e);
        resolve(null);
      }
    }
  });
}

interface SetQualityResponse extends BridgeResponseEnvelope {
  success?: boolean;
  reason?: string;
  appliedLabel?: string;
}

// ─── Single-video download flow ──────────────────────────────────────────────

type ErrorCode =
  | "DRM_PROTECTED"
  | "LIVE_STREAM"
  | "NO_SUITABLE_QUALITY"
  | "NO_SABR_SESSION"
  | "DOWNLOAD_FAILED"
  | "AUTO_RESUME_NEEDED";

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  DRM_PROTECTED: "Видео защищено DRM",
  LIVE_STREAM: "Прямые трансляции не поддерживаются",
  NO_SUITABLE_QUALITY: "Нет подходящего видеопотока",
  NO_SABR_SESSION: "Включите воспроизведение видео и попробуйте снова",
  DOWNLOAD_FAILED: "Не удалось собрать видео",
  AUTO_RESUME_NEEDED: "Перезагружаем страницу…",
};

const RETRYABLE_ERRORS = new Set<string>(["DOWNLOAD_FAILED", "NO_SABR_SESSION"]);

const NON_RETRYABLE_ERRORS = new Set<string>([
  "DRM_PROTECTED",
  "LIVE_STREAM",
  "NO_SUITABLE_QUALITY",
]);

function applyButtonError(btn: YtDownloadButton, code: ErrorCode): void {
  const msg = ERROR_MESSAGES[code] ?? code;
  if (NON_RETRYABLE_ERRORS.has(code)) {
    btn.setState("disabled");
  } else {
    btn.setState("error");
  }
  btn.setTooltip(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function handleDownloadClick(videoId: string): void {
  if (!currentButton) return;
  if (clickFlowInProgress) {
    console.log(
      `${TAG} [click] ignored — a flow is already running for ${currentClickFlowVideoId}`,
    );
    return;
  }
  console.log(
    `${TAG} [click] download requested for videoId=${videoId} at`,
    new Date().toISOString(),
  );
  currentButton.setState("loading");
  currentButton.setLabel("0%");

  // Reset cross-phase progress tracking for this new click flow.
  lastBufferCapturePct = 0;

  clickFlowInProgress = true;
  currentClickFlowVideoId = videoId;
  void runClickFlow(videoId).finally(() => {
    clickFlowInProgress = false;
    currentClickFlowVideoId = null;
  });
}

/**
 * SABR-replay click flow:
 *   1. Stale-page → auto-resume + reload.
 *   2. Live / DRM pre-flight.
 *   3. Quality switch through the bridge.
 *   4. Reload the player so a fresh SABR POST is captured by the SW.
 *   5. Sleep so the player has emitted at least one POST.
 *   6. `chrome.runtime.sendMessage("YT_DOWNLOAD_VIDEO")` — SW handles
 *      replay + mux + save.
 */
async function runClickFlow(videoId: string): Promise<void> {
  // 1. Stale-page → schedule auto-resume + reload.
  if (!isFreshLoadForVideo(videoId)) {
    console.log(
      `${TAG} [click] not a fresh load for ${videoId}, scheduling auto-resume + reload`,
    );
    if (currentButton) {
      currentButton.setLabel(ERROR_MESSAGES.AUTO_RESUME_NEEDED);
    }
    try { await markAutoDownload(videoId); } catch (e) { console.error(`${TAG} [auto-resume] markAutoDownload failed`, e); }
    try { location.reload(); } catch (e) { console.error(`${TAG} [auto-resume] reload failed`, e); }
    return;
  }

  // 2. Live / DRM pre-flight.
  let video = getOnPageVideo();
  const data = getPlayerVideoData();
  if (data?.isLive || data?.isLiveContent || video?.duration === Infinity) {
    if (currentButton && currentVideoId === videoId) {
      applyButtonError(currentButton, "LIVE_STREAM");
    }
    return;
  }
  if (data?.isDrmProtected) {
    if (currentButton && currentVideoId === videoId) {
      applyButtonError(currentButton, "DRM_PROTECTED");
    }
    return;
  }
  if (!video || !isFinite(video.duration) || video.duration <= 0) {
    if (currentButton && currentVideoId === videoId) {
      applyButtonError(currentButton, "DOWNLOAD_FAILED");
    }
    return;
  }
  const durationSec = video.duration;

  // 3. Quality switch through the bridge.
  try {
    const targetHeight = await getPreferredQualityHeight();
    const switched = await postBridge<SetQualityResponse>(
      "SET_QUALITY",
      { targetHeight },
      "SET_QUALITY_RESPONSE",
      BRIDGE_SHORT_TIMEOUT_MS,
    );
    if (switched && switched.success === false && switched.reason === "api_missing") {
      if (currentButton && currentVideoId === videoId) {
        applyButtonError(currentButton, "NO_SUITABLE_QUALITY");
      }
      return;
    }
    if (switched && switched.success === true) {
      console.log(
        `${TAG} player quality switch: OK (target=${targetHeight}px, applied=${switched.appliedLabel ?? "—"})`,
      );
      await sleep(QUALITY_SETTLE_DELAY_MS);
    }
  } catch (e) {
    console.error(`${TAG} pre-flight quality switch failed`, e);
  }

  // 4. Reload the player. This forces YouTube to re-issue
  //    `videoplayback` POSTs with the current quality preference,
  //    giving the SW a fresh SABR template body to replay.
  console.log(`${TAG} [click] reloading player to refresh SABR session`);
  const reloadResp = await postBridge<{ success?: boolean; reason?: string }>(
    "RELOAD_VIDEO",
    { videoId },
    "RELOAD_VIDEO_RESPONSE",
    BRIDGE_SHORT_TIMEOUT_MS,
  );
  if (reloadResp && reloadResp.success === true) {
    await sleep(RELOAD_SETTLE_MS);
  } else {
    console.warn(
      `${TAG} [click] RELOAD_VIDEO failed (${reloadResp?.reason ?? "unknown"}) — proceeding`,
    );
    await sleep(PLAYBACK_SETTLE_MS);
  }

  // 4b. Drive the on-page <video> through the entire timeline so the
  //     player issues a SABR POST for every segment. The SW's
  //     `chrome.webRequest.onBeforeRequest` hook captures each request
  //     body — this is the only way to get the full set of
  //     `__ytSabrBodies` covering the whole video. Without this step
  //     we'd only have the bodies the player happened to send during
  //     the user's actual viewing (usually the first 30s).
  //
  //     `forceFullBuffer` drives the player but we don't read its byte
  //     output — the bytes are captured by the SW directly. We just
  //     need the video.buffered timeline to span [0, duration] before
  //     we send YT_DOWNLOAD_VIDEO.
  //
  //     The on-page `<video>` reference may have changed after the
  //     RELOAD_VIDEO bridge call, so re-resolve it here.
  video = getOnPageVideo();
  if (!video || !isFinite(video.duration) || video.duration <= 0) {
    if (currentButton && currentVideoId === videoId) {
      applyButtonError(currentButton, "DOWNLOAD_FAILED");
    }
    return;
  }
  console.log(
    `${TAG} [click] starting forceFullBuffer to populate SABR bodies (duration=${durationSec.toFixed(1)}s)`,
  );
  try { video.muted = true; } catch { /* ignore */ }
  // Pick the same quality height the bridge will switch the player to
  // so `forceFullBuffer` can choose a matching `playbackRate` (≤ 1080p
  // → 16x, 1440p → 4x, 2160p → 2x).
  const qualityHeight = await getPreferredQualityHeight();
  const captureResult = await forceFullBuffer(
    video,
    durationSec,
    qualityHeight,
    (pct) => {
      if (currentButton && currentVideoId === videoId) {
        // Remember the maximum buffer-capture pct so the download/mux
        // phase mapping can use it as the floor.
        if (pct > lastBufferCapturePct) lastBufferCapturePct = pct;
        // Map 0..100 → 0..70 (rest of progress goes to download/mux phases).
        currentButton.setProgress(Math.round(pct * 0.7));
      }
    },
  );
  if (!captureResult.ok) {
    console.warn(
      `${TAG} [click] forceFullBuffer failed: reason=${captureResult.reason}`,
    );
    // Don't block the download — even a partial buffer gives us SABR
    // bodies for the captured time range. The SW's direct gap-fill
    // replay can attempt to fill the rest. Log the warning and
    // proceed.
  }

  // 5. Send the request to background. SW does the heavy lifting.
  const videoTitle = extractVideoTitle();

  if (currentButton && currentVideoId === videoId) {
    currentButton.setLabel("Запрос…");
  }

  console.log(
    `${TAG} [download] sending YT_DOWNLOAD_VIDEO (title="${videoTitle}", duration=${durationSec.toFixed(1)}s)`,
  );

  let response:
    | { success?: boolean; errorCode?: string; reason?: string; filename?: string }
    | undefined;
  try {
    response = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: "YT_DOWNLOAD_VIDEO",
            payload: {
              videoId,
              url: location.href,
              title: videoTitle,
              durationSec,
            },
          },
          (resp) => {
            if (chrome.runtime.lastError) {
              resolve({
                success: false,
                errorCode: "DOWNLOAD_FAILED",
                reason: chrome.runtime.lastError.message ?? "SW недоступен",
              });
              return;
            }
            resolve(resp as typeof response);
          },
        );
      } catch (err) {
        resolve({
          success: false,
          errorCode: "DOWNLOAD_FAILED",
          reason: (err as Error).message,
        });
      }
    });
  } catch (e) {
    console.error(`${TAG} sendMessage threw`, e);
  }

  console.log(
    `${TAG} [download] background response:`,
    response === undefined
      ? "undefined"
      : `success=${response.success} errorCode=${response.errorCode ?? "—"} reason=${response.reason ?? "—"}`,
  );
  if (!currentButton || currentVideoId !== videoId) return;

  if (response && response.success) {
    currentButton.setProgress(100);
    currentButton.setState("success");
    setTimeout(() => {
      if (currentButton && currentVideoId === videoId) {
        currentButton.setState("idle");
      }
    }, 2000);
    return;
  }

  const errorCodeRaw: string = response?.errorCode || "DOWNLOAD_FAILED";
  const reason: string =
    response?.reason ||
    ERROR_MESSAGES[errorCodeRaw as ErrorCode] ||
    "Неизвестная ошибка";
  const errorCode: ErrorCode = (
    NON_RETRYABLE_ERRORS.has(errorCodeRaw) || RETRYABLE_ERRORS.has(errorCodeRaw)
      ? errorCodeRaw
      : "DOWNLOAD_FAILED"
  ) as ErrorCode;
  applyButtonError(currentButton, errorCode);
  if (reason && reason !== ERROR_MESSAGES[errorCode]) {
    currentButton.setTooltip(reason);
  }
}

// ─── Phase progress tracking ──────────────────────────────────────────────
//
// The overall progress bar maps three phases of the download into a 0–100
// scale. The buffer capture phase fills 0–70 %; the SW download phase fills
// 70–90 %; the mux phase fills 90–95 %; the final save bumps to 100 %.
//
// CRITICAL: the SW's `phase=download` ticks must NOT jump straight to
// 70+% if the buffer capture phase only ever reached, say, 50 % (which
// would correspond to 35 % of the overall bar). We therefore remember the
// real buffer-coverage that the capture phase reached and use it as the
// floor for the download/mux re-mapping. If the user sees 35 % when
// buffering finishes, the next visible value should be 35 %+, not 70 %.
//
// The `lastBufferCapturePct` module-level variable is declared near the
// top of this file alongside `clickFlowInProgress`.

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "YT_DOWNLOAD_PROGRESS" || !message.payload) return;

  const { videoId, pct, phase } = message.payload as {
    videoId: string;
    pct?: number;
    phase?: "request" | "download" | "mux";
  };

  if (currentButton && currentVideoId === videoId && typeof pct === "number") {
    if (phase === "request") {
      currentButton.setLabel("Запрос…");
    } else if (phase === "download") {
      // SW download phase: lerp from `bufferFloor` (where buffer
      // capture left off) up to 90 % as `pct` goes 0..100.
      // `bufferFloor` is `lastBufferCapturePct * 0.7` — i.e. the
      // overall-bar value that buffering reached. If buffering reached
      // 100 %, this slice becomes the canonical 70..90 % range; if
      // buffering only reached 50 %, the slice becomes 35..90 % so
      // the bar fills smoothly without jumping forward.
      const bufferFloor = Math.round(lastBufferCapturePct * 0.7);
      const downloadCeiling = 90;
      const span = Math.max(0, downloadCeiling - bufferFloor);
      currentButton.setProgress(bufferFloor + Math.round((pct / 100) * span));
    } else if (phase === "mux") {
      currentButton.setLabel("Сборка…");
      // Mux phase: 90..95 % range. The SW emits pct=99 mid-mux and
      // pct=100 once the file is saved — both land in 94..95 % here so
      // the visual bar does not snap to 100 % before the download finishes.
      currentButton.setProgress(90 + Math.round(pct * 0.05));
    } else {
      // Unknown / legacy phases — pass through unchanged.
      currentButton.setProgress(pct);
    }
  }

  if (
    playlistInProgress &&
    playlistProgressState &&
    typeof pct === "number"
  ) {
    const effectivePct = phase === "mux" ? 100 : pct;
    playlistProgressState.pct = effectivePct;
    if (currentPlaylistButton) {
      currentPlaylistButton.setProgress(
        playlistProgressState.current,
        playlistProgressState.total,
        effectivePct,
      );
    }
  }
});

// ─── SPA navigation handler ──────────────────────────────────────────────────

function onNavigate(videoId: string | null): void {
  console.log(
    `${TAG} [nav] onNavigate fired, videoId=${videoId} (was=${currentVideoId})`,
  );

  if (currentButton) {
    currentButton.remove();
    currentButton = null;
  }

  currentVideoId = videoId;
  if (!videoId) return;
  const id: string = videoId;

  const videoType = getVideoType();
  let elapsed = 0;
  let delay = 300;

  function tryInject(): void {
    if (currentVideoId !== id) return;

    const button = injectDownloadButton(id, videoType, () => {
      handleDownloadClick(id);
    });

    if (button) {
      currentButton = button;
      console.log(
        `${TAG} Button injected for videoId=${id} (${videoType})`,
      );
      void tryAutoResume(id);
      return;
    }

    elapsed += delay;
    if (elapsed >= 10_000) {
      console.warn(
        `${TAG} Action bar not found after 10s for videoId=${id}`,
      );
      return;
    }
    delay = Math.min(delay * 1.5, 2000);
    setTimeout(tryInject, delay);
  }

  tryInject();
}

// ─── Auto-resume bootstrap ───────────────────────────────────────────────────

let autoResumeFiredFor: string | null = null;

async function tryAutoResume(videoId: string): Promise<void> {
  if (autoResumeFiredFor === videoId) return;
  try {
    const pending = await consumePendingAutoDownload();
    if (!pending) return;
    if (pending.videoId !== videoId) {
      console.log(
        `${TAG} [auto-resume] pending.videoId=${pending.videoId} ≠ current=${videoId}`,
      );
      return;
    }
    autoResumeFiredFor = videoId;
    console.log(`${TAG} [auto-resume] re-issuing click for ${videoId}`);
    handleDownloadClick(videoId);
  } catch (e) {
    console.error(`${TAG} [auto-resume] tryAutoResume failed`, e);
  }
}

// ─── Distribution-protection guard ───────────────────────────────────────────

function checkDistributionGuard(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "YT_CHECK_GUARD" }, (response) => {
        if (chrome.runtime.lastError) {
          // fail-closed: if sendMessage failed we cannot prove the SW is
          // unblocked, so treat as blocked=true and skip wiring buttons.
          resolve(true);
          return;
        }
        resolve(!!response?.blocked);
      });
    } catch {
      // fail-closed on synchronous throw too.
      resolve(true);
    }
  });
}

// ─── Playlist download wiring ────────────────────────────────────────────────

let currentPlaylistButton: PlaylistDownloadButton | null = null;
let playlistInProgress = false;
let playlistProgressState: {
  current: number;
  total: number;
  pct?: number;
} | null = null;

async function handlePlaylistDownloadClick(): Promise<void> {
  const listId = getCurrentPlaylistId();
  if (!listId) {
    console.warn(`${TAG} [playlist] no list id in URL — aborting`);
    return;
  }

  const videoIds = collectPlaylistVideoIds();
  if (videoIds.length === 0) {
    console.warn(`${TAG} [playlist] no videos found in the rendered list`);
    return;
  }

  console.log(
    `${TAG} [playlist] starting batch download: list=${listId}, ${videoIds.length} videos`,
  );

  playlistInProgress = true;
  playlistProgressState = { current: 0, total: videoIds.length, pct: 0 };
  if (currentPlaylistButton) {
    currentPlaylistButton.setState("loading");
    currentPlaylistButton.setProgress(0, videoIds.length, 0);
  }

  pausePlayer();

  const first = videoIds[0];
  const playlist = { ids: videoIds, index: 0 };
  try {
    await markAutoDownload(first, playlist);
    location.href = `https://www.youtube.com/watch?v=${first}&list=${listId}`;
  } catch (e) {
    console.error(`${TAG} [playlist] kickoff failed`, e);
    playlistInProgress = false;
    playlistProgressState = null;
    if (currentPlaylistButton) {
      currentPlaylistButton.setState("idle");
    }
  }
}

function startPlaylistButtonWatcher(): void {
  const tryInject = (): void => {
    if (!getCurrentPlaylistId()) {
      if (currentPlaylistButton) {
        currentPlaylistButton.remove();
        currentPlaylistButton = null;
      }
      return;
    }
    const handle = injectPlaylistDownloadButton(() => {
      void handlePlaylistDownloadClick();
    });
    if (handle) {
      currentPlaylistButton = handle;
      if (playlistInProgress) {
        handle.setState("loading");
        if (playlistProgressState) {
          handle.setProgress(
            playlistProgressState.current,
            playlistProgressState.total,
            playlistProgressState.pct,
          );
        }
      }
    }
  };

  tryInject();

  const observer = new MutationObserver(() => {
    tryInject();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener("yt-navigate-finish", () => {
    setTimeout(tryInject, 500);
  });
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

void (async () => {
  const blocked = await checkDistributionGuard();
  if (blocked) {
    console.warn(
      `${TAG} Distribution protection active — YouTube downloader disabled`,
    );
    return;
  }
  startSpaObserver(onNavigate);
  startPlaylistButtonWatcher();
  console.log(`${TAG} Content script loaded (SABR replay)`);
})();
