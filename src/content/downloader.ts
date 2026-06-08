// Скачивание трека: запрашивает у Service Worker полный сценарий
// (resolve URL → fetch → tag/repack → chrome.downloads.download), и ждёт
// числовой `downloadId` в ответе как подтверждение того, что файл реально
// записан в систему пользователя.
//
// До wave-mode-fixes (task 3.3) SW для no-folder DOWNLOAD_TRACK возвращал
// байты, а content-script сам создавал Blob+<a download> и инициировал
// сохранение. Это создавало гонку: floating-button мог показать success
// раньше, чем браузер фактически зарегистрировал загрузку. Теперь SW сам
// вызывает `chrome.downloads.download()` для всех форматов и для всех
// флоу (bulk и single-track), и success-ответ приходит ТОЛЬКО после
// возврата числового downloadId.

export interface DownloadResult {
  success: boolean;
  reason?: string;
  errorCode?: string;
  /** `downloadId`, возвращённый `chrome.downloads.download()` в SW. */
  downloadId?: number;
}

interface SwDownloadResponse {
  success: boolean;
  filename?: string;
  reason?: string;
  errorCode?: string;
  downloadId?: number;
}

export async function downloadTrackWithTags(
  trackId: string,
  meta?: { artist?: string; title?: string },
  folder?: string,
  onProgress?: (percent: number) => void,
): Promise<DownloadResult> {
  if (typeof chrome === "undefined" || chrome.runtime?.id === undefined) {
    return {
      success: false,
      reason: "Расширение обновлено. Перезагрузите эту страницу (F5).",
    };
  }

  // Per-call requestId so the SW can route YM_TRACK_PROGRESS messages
  // back to *this* call only. Caller wires onProgress to a button's ring.
  const requestId =
    onProgress !== undefined
      ? `ymd_dl_${Date.now()}_${Math.random().toString(36).slice(2)}`
      : undefined;

  const progressListener =
    onProgress !== undefined
      ? (msg: unknown): void => {
          if (
            typeof msg !== "object" ||
            msg === null ||
            (msg as { type?: unknown }).type !== "YM_TRACK_PROGRESS"
          ) {
            return;
          }
          const m = msg as { requestId?: unknown; percent?: unknown };
          if (m.requestId !== requestId) return;
          if (typeof m.percent !== "number") return;
          onProgress(m.percent);
        }
      : null;
  if (progressListener !== null) {
    chrome.runtime.onMessage.addListener(progressListener);
  }

  const payload: {
    trackId: string;
    meta?: { artist?: string; title?: string };
    folder?: string;
    requestId?: string;
  } = { trackId, meta };
  if (folder) {
    payload.folder = folder;
  }
  if (requestId !== undefined) {
    payload.requestId = requestId;
  }

  let r: SwDownloadResponse | undefined;
  try {
    r = (await chrome.runtime.sendMessage({
      type: "DOWNLOAD_TRACK",
      payload,
    })) as SwDownloadResponse | undefined;
  } catch (e) {
    if (progressListener !== null) {
      chrome.runtime.onMessage.removeListener(progressListener);
    }
    return {
      success: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  } finally {
    // We can detach the listener once the round-trip is done — by then
    // the SW has either succeeded (final 99→100% snap is the caller's
    // job) or errored (no more progress will come).
    if (progressListener !== null) {
      chrome.runtime.onMessage.removeListener(progressListener);
    }
  }

  if (r === undefined) {
    return { success: false, reason: "Service Worker не ответил" };
  }

  if (!r.success) {
    return {
      success: false,
      reason: r.reason ?? "Не удалось скачать трек",
      errorCode: r.errorCode,
    };
  }

  // Контракт: SW отвечает success=true ТОЛЬКО после того, как
  // `chrome.downloads.download()` вернул числовой `downloadId`. Если поле
  // отсутствует — это нарушение контракта (например, регрессия в SW), и
  // вызывающий код (popup/floating-button) должен трактовать ситуацию как
  // ошибку, а не показывать зелёный индикатор. Validates Requirements 2.5, 2.6.
  if (typeof r.downloadId !== "number") {
    return {
      success: false,
      reason: "Файл не записан в систему",
    };
  }

  return { success: true, downloadId: r.downloadId };
}
