// VK content script entry point.
// Инъектирует кнопки скачивания на страницах vk.com.
// Поддерживает SPA-навигацию через перехват pushState/replaceState.

import type { VkTrackMeta } from "../shared/types";
import { startVkTrackInjector, setDownloadButtonProgress } from "./vk-track-injector";
import { startVkPlaylistInjector } from "./vk-playlist";
import { getServiceFormatPreferences } from "../shared/format-storage";
import { showVkError, showVkInfo, VK_ERROR_CODES, type VkErrorCode } from "./vk-error-toast";

// ─── Error code → localized message mapping ─────────────────────────────────

const ERROR_MESSAGES: Record<string, string> = {
  VK_NOT_LOGGED_IN: "Войдите в VK в браузере для скачивания",
  VK_SESSION_EXPIRED: "Сессия VK истекла. Обновите страницу vk.com",
  VK_RATE_LIMITED: "VK ограничил запросы. Подождите и попробуйте снова",
  VK_TRACK_UNAVAILABLE: "Трек недоступен",
  VK_TIMEOUT: "Превышено время ожидания",
  VK_URL_NOT_FOUND: "Трек недоступен",
  VK_NETWORK_ERROR: "Ошибка сети. Проверьте соединение",
  VK_AUTH_REQUIRED: "Войдите в VK в браузере для скачивания",
};

// Backend error reasons that map cleanly onto our user-facing error codes.
// VK_NOT_LOGGED_IN and VK_AUTH_REQUIRED are USER actions (not extension bugs),
// so they show as info, not as a "report to dev" code.
const USER_ACTION_REASONS = new Set([
  "VK_NOT_LOGGED_IN",
  "VK_AUTH_REQUIRED",
  "VK_SESSION_EXPIRED",
  "VK_TRACK_UNAVAILABLE",
  "VK_RATE_LIMITED",
  "VK_URL_NOT_FOUND",
]);

const REASON_TO_ERROR_CODE: Record<string, VkErrorCode> = {
  VK_TIMEOUT: VK_ERROR_CODES.BRIDGE_TIMEOUT,
  VK_NETWORK_ERROR: VK_ERROR_CODES.DOWNLOAD_NETWORK,
};


// ─── Single track download handler ──────────────────────────────────────────

function onTrackClick(meta: VkTrackMeta, btn: HTMLButtonElement): void {
  if (btn.classList.contains("ymus-loading")) return;
  btn.classList.add("ymus-loading");
  btn.classList.remove("ymus-success", "ymus-error");

  const artist = meta.artist || "Unknown";
  const title = meta.title || "audio";

  // If we already have a URL (from fiber/data-audio), skip page-bridge entirely
  if (meta.encryptedUrl && meta.encryptedUrl.startsWith("https://")) {
    downloadTrackViaBackground(meta.ownerId, meta.audioId, artist, title, meta.encryptedUrl, btn);
    return;
  }

  // Get URL via page-bridge (classic VK pages with audio_row)
  getEncryptedUrlFromPage(meta.ownerId, meta.audioId, meta.accessKey)
    .then((encryptedUrl) => {
      if (!encryptedUrl || !encryptedUrl.startsWith("https://")) {
        // Fallback: try via background without URL (vkApiClient will fetch it)
        downloadTrackViaBackground(meta.ownerId, meta.audioId, artist, title, "", btn);
        return;
      }

      downloadTrackViaBackground(meta.ownerId, meta.audioId, artist, title, encryptedUrl, btn);
    })
    .catch(() => {
      // Fallback: try via background without URL
      downloadTrackViaBackground(meta.ownerId, meta.audioId, artist, title, "", btn);
    });
}

function downloadTrackViaBackground(
  ownerId: string, audioId: string, artist: string, title: string, encryptedUrl: string, btn: HTMLButtonElement
): void {
  const requestId = `ymus_dl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  // Register the button for live progress messages from background.
  trackProgressRegistry.set(requestId, btn);
  // Reset progress visuals at start so we don't keep stale numbers.
  setDownloadButtonProgress(btn, 0);

  chrome.runtime.sendMessage(
    { type: "VK_DOWNLOAD_TRACK", payload: { ownerId, audioId, artist, title, encryptedUrl, requestId } },
    (response) => {
      trackProgressRegistry.delete(requestId);
      btn.classList.remove("ymus-loading");
      if (response && response.success) {
        if (response.audioDataB64 && !response.downloadId) {
          const filename = response.filename || `${artist} - ${title}.mp3`.replace(/[<>:"/\\|?*]/g, "_");
          saveBase64AsFile(response.audioDataB64, filename);
        }
        btn.classList.add("ymus-success");
        if (response.fallbackReason) {
          showVkInfo(response.fallbackReason);
        }
        setTimeout(() => btn.classList.remove("ymus-success"), 1700);
      } else {
        btn.classList.add("ymus-error");
        const reason = String(response?.reason ?? response?.error ?? "");

        if (USER_ACTION_REASONS.has(reason)) {
          // Things the user can fix themselves — info toast, no dev-report nag.
          showVkInfo(ERROR_MESSAGES[reason] ?? reason);
        } else if (REASON_TO_ERROR_CODE[reason]) {
          showVkError(REASON_TO_ERROR_CODE[reason], ERROR_MESSAGES[reason], { reason, response });
        } else {
          // Unknown failure from backend — surface the raw reason so the dev
          // can decode it from the screenshot.
          showVkError(
            VK_ERROR_CODES.DOWNLOAD_NETWORK,
            reason ? `Ошибка скачивания: ${reason}` : "Ошибка скачивания",
            { reason, response },
          );
        }
        setTimeout(() => btn.classList.remove("ymus-error"), 2000);
      }
    }
  );
}

/** requestId → button element. Used to route VK_TRACK_PROGRESS messages
 * back to the right UI element when several downloads run concurrently. */
const trackProgressRegistry = new Map<string, HTMLButtonElement>();

// Listen for live progress updates from background. Routes VK_TRACK_PROGRESS
// either to a single-track button (via trackProgressRegistry) or to the
// currently-active playlist track (via playlistTrackInflight).
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "VK_TRACK_PROGRESS") return;
  const { requestId, percent } = msg as { requestId: string; percent: number };
  const btn = trackProgressRegistry.get(requestId);
  if (btn && btn.classList.contains("ymus-loading")) {
    setDownloadButtonProgress(btn, percent);
    return;
  }
  if (playlistTrackInflight && playlistTrackInflight.requestId === requestId) {
    playlistTrackInflight.update(percent);
  }
});

/**
 * Call VK's internal _ensureHasURL via the page-bridge script (MAIN world).
 * Returns the encrypted URL string.
 */
function getEncryptedUrlFromPage(
  ownerId: string,
  audioId: string,
  accessKey?: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const requestId = `ymus_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail && detail.requestId === requestId) {
        document.removeEventListener("ymus-url-result", handler);
        console.log(`[YMus] getEncryptedUrlFromPage result for ${ownerId}_${audioId}: url=${detail.url ? 'yes' : 'null'}`);
        resolve(detail.url || null);
      }
    };
    document.addEventListener("ymus-url-result", handler);

    // Send request to page-bridge (MAIN world script)
    console.log(`[YMus] getEncryptedUrlFromPage: requesting ${ownerId}_${audioId}${accessKey ? " (with accessKey)" : ""}`);
    document.dispatchEvent(
      new CustomEvent("ymus-get-url", {
        detail: { ownerId, audioId, requestId, accessKey },
      })
    );

    // Timeout after 10s — but first check DOM element (cross-world fallback)
    setTimeout(() => {
      document.removeEventListener("ymus-url-result", handler);
      // Check if page-bridge wrote URL to DOM (cross-world delivery)
      const resultEl = document.getElementById("ymus-url-result-data");
      if (resultEl && resultEl.getAttribute("data-request-id") === requestId) {
        const domUrl = resultEl.getAttribute("data-url") || null;
        if (domUrl) {
          console.log(`[YMus] getEncryptedUrlFromPage: got URL from DOM for ${ownerId}_${audioId}`);
          resolve(domUrl);
          return;
        }
      }
      console.log(`[YMus] getEncryptedUrlFromPage: TIMEOUT for ${ownerId}_${audioId}`);
      resolve(null);
    }, 5000); // 5s — Strategy 0 is a network call (al_audio.php), which can be slower than in-memory _ensureHasURL.
  });
}

// ─── Playlist download handler ───────────────────────────────────────────────

function onDownloadPlaylist(
  tracks: VkTrackMeta[],
  playlistTitle: string,
  progressCallback: (downloaded: number, total: number, currentTrackPct?: number) => void,
): void {
  const total = tracks.length;
  let downloaded = 0;
  let skipped = 0;

  // Sanitize playlist title for use as folder name
  const playlistFolder = playlistTitle
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "Плейлист";

  // Live progress for the track currently in flight. Updated by the global
  // VK_TRACK_PROGRESS listener (see playlistTrackInflight below) so the
  // playlist button can show ((done + currentPct/100) / total) * 100.
  let currentTrackPct = 0;

  // Read bulk format preference once before starting downloads
  getServiceFormatPreferences("vk").then((prefs) => {
    const bulkFormat = prefs.bulkFormat;
    downloadNext(0, bulkFormat);
  }).catch(() => {
    // Fallback: download without format override
    downloadNext(0, undefined);
  });

  function downloadNext(index: number, bulkFormat: string | undefined): void {
    if (index >= total) {
      progressCallback(downloaded, total);
      if (skipped > 0) {
        showVkInfo(`${downloaded} скачано, ${skipped} пропущено`);
      }
      return;
    }

    const meta = tracks[index];
    
    // If we already have the URL from fiber extraction, download via background VK_DOWNLOAD_TRACK
    if (meta.encryptedUrl && meta.encryptedUrl.startsWith("https://")) {
      const artist = meta.artist || "Unknown";
      const title = meta.title || "audio";
      
      console.log(`[YMus] Downloading via VK_DOWNLOAD_TRACK: ${artist} - ${title}`);

      // Per-track requestId so the playlist button can read the current
      // track's % from background's VK_TRACK_PROGRESS pings. Stored in
      // playlistTrackInflight; the listener updates currentTrackPct and
      // re-emits the combined progress to the button.
      const requestId = `ymus_pl_${Date.now()}_${index}_${Math.random().toString(36).slice(2)}`;
      playlistTrackInflight = {
        requestId,
        update: (pct) => {
          currentTrackPct = pct;
          progressCallback(downloaded + skipped, total, currentTrackPct);
        },
      };

      const payload: Record<string, unknown> = { ownerId: meta.ownerId, audioId: meta.audioId, artist, title, encryptedUrl: meta.encryptedUrl, playlistFolder, requestId };
      if (bulkFormat) {
        payload.preferredFormat = bulkFormat;
      }
      chrome.runtime.sendMessage(
        { type: "VK_DOWNLOAD_TRACK", payload },
        (response) => {
          playlistTrackInflight = null;
          currentTrackPct = 0;
          if (response && response.success) {
            // If audioDataB64 is returned, we need to save it via blob download
            if (response.audioDataB64 && !response.downloadId) {
              const filename = response.filename || `${artist} - ${title}.mp3`.replace(/[<>:"/\\|?*]/g, "_");
              saveBase64AsFile(response.audioDataB64, filename);
            }
            downloaded++;
          } else {
            console.log(`[YMus] Download failed for ${artist} - ${title}:`, response?.error || response?.reason);
            skipped++;
          }
          progressCallback(downloaded + skipped, total, 0);
          setTimeout(() => downloadNext(index + 1, bulkFormat), 250);
        }
      );
      return;
    }

    // Fallback: Get URL via page-bridge (works on classic VK pages with audio_row)
    getEncryptedUrlFromPage(meta.ownerId, meta.audioId, meta.accessKey).then((url) => {
      if (!url || !url.startsWith("https://")) {
        skipped++;
        progressCallback(downloaded + skipped, total);
        setTimeout(() => downloadNext(index + 1, bulkFormat), 500);
        return;
      }
      
      const artist = meta.artist || "Unknown";
      const title = meta.title || "audio";
      const filename = `${artist} - ${title}.mp3`
        .replace(/[<>:"/\\|?*]/g, "_")
        .replace(/\s+/g, " ")
        .trim();
      
      const requestId = `ymus_dl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      
      const handler = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (detail && detail.requestId === requestId) {
          document.removeEventListener("ymus-download-result", handler);
          if (detail.success) {
            downloaded++;
          } else {
            skipped++;
          }
          progressCallback(downloaded + skipped, total);
          setTimeout(() => downloadNext(index + 1, bulkFormat), 500);
        }
      };
      document.addEventListener("ymus-download-result", handler);
      
      document.dispatchEvent(
        new CustomEvent("ymus-download-audio", {
          detail: { url, filename, requestId },
        })
      );
      
      // Timeout per track
      setTimeout(() => {
        document.removeEventListener("ymus-download-result", handler);
      }, 60000);
    }).catch(() => {
      skipped++;
      progressCallback(downloaded + skipped, total);
      setTimeout(() => downloadNext(index + 1, bulkFormat), 500);
    });
  }
}

/** Routes VK_TRACK_PROGRESS for the currently-downloading playlist track
 * to its update fn. Single-slot because playlist downloads are sequential. */
let playlistTrackInflight: { requestId: string; update: (pct: number) => void } | null = null;

// ─── Base64 download utility ─────────────────────────────────────────────────

function saveBase64AsFile(base64: string, filename: string): void {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1000);
  } catch (e) {
    showVkError(VK_ERROR_CODES.DOWNLOAD_FILE_SAVE, undefined, { filename, err: String(e) });
  }
}

// ─── SPA navigation detection ────────────────────────────────────────────────

function onNavigation(): void {
  // Trigger a minor DOM change to wake up MutationObservers
  setTimeout(() => {
    const marker = document.createElement("span");
    marker.style.display = "none";
    document.body.appendChild(marker);
    marker.remove();
  }, 1000);
}

// Override pushState / replaceState
const origPushState = history.pushState.bind(history);
const origReplaceState = history.replaceState.bind(history);

history.pushState = function (...args: Parameters<typeof history.pushState>) {
  origPushState(...args);
  onNavigation();
};

history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
  origReplaceState(...args);
  onNavigation();
};

window.addEventListener("popstate", onNavigation);

// ─── Initialize ──────────────────────────────────────────────────────────────

startVkTrackInjector(onTrackClick);
startVkPlaylistInjector(onDownloadPlaylist);
console.log("[YMus] VK content script loaded");

console.log("[YMus] VK content script loaded");
