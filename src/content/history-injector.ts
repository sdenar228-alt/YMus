/**
 * Module: history-injector
 *
 * Активируется на странице истории прослушиваний (/users/{login}/history),
 * обнаруживает Date_Header элементы и внедряет Date_Download_Button рядом
 * с каждым заголовком даты. При навигации прочь — отключает наблюдение.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.3, 2.4, 7.1
 */

import { observeURLChanges } from "./url-observer";
import { isHistoryPage } from "./history-url-matcher";
import { createDateButton, type DateButton } from "./history-button-factory";
import { createRateLimiter, createDebouncer } from "./history-rate-limiter";
import { collectTrackIds, collectTrackIdsFromState } from "./history-track-collector";
import { createBulkDownload, type BulkDownloadController } from "./bulk-download";
import { sanitizeFolderName } from "../shared/folder-sanitizer";
import { getFormatPreferences } from "../shared/format-storage";

// ─── Constants ───────────────────────────────────────────────────────────────

const DATE_HEADER_SELECTOR = "h2[data-date-anchor]";
const BUTTON_MARKER_ATTR = "data-ymd-date-btn";
const DEBOUNCE_DELAY_MS = 200;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HistoryInjectorDeps {
  notify: (text: string, kind: "success" | "error" | "info") => void;
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Запуск инжектора. Вызывается из content.ts.
 * Подписывается на URL changes и активирует/деактивирует наблюдение
 * за DOM в зависимости от текущей страницы.
 */
export function startHistoryInjector(deps: HistoryInjectorDeps): void {
  let observer: MutationObserver | null = null;
  const rateLimiter = createRateLimiter();
  const debouncer = createDebouncer(DEBOUNCE_DELAY_MS);
  let active = false;

  function scanAndInject(): void {
    if (!rateLimiter.tryAcquire()) return;

    const headers = document.querySelectorAll(DATE_HEADER_SELECTOR);
    for (let i = 0; i < headers.length; i++) {
      injectButtonIfNeeded(headers[i], deps);
    }
  }

  function handleMutation(): void {
    debouncer.schedule(scanAndInject);
  }

  function activate(): void {
    if (active) return;
    active = true;

    // Немедленный первый проход
    scanAndInject();

    // Запуск MutationObserver.
    // scanAndInject идемпотентен (маркер data-ymd-date-btn предотвращает дубли),
    // поэтому guard не нужен — debounce достаточно для производительности.
    observer = new MutationObserver(handleMutation);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function deactivate(): void {
    if (!active) return;
    active = false;

    debouncer.cancel();
    rateLimiter.reset();

    if (observer !== null) {
      observer.disconnect();
      observer = null;
    }
  }

  function handleURLChange(newURL: string): void {
    const url = new URL(newURL);
    if (isHistoryPage(url.pathname)) {
      activate();
    } else {
      deactivate();
    }
  }

  // Подписка на SPA-навигацию
  observeURLChanges(handleURLChange);

  // Проверяем текущую страницу при инициализации
  if (isHistoryPage(location.pathname)) {
    activate();
  }

  // Дополнительный механизм: polling location.pathname как fallback
  // для SPA-навигации (патч history.pushState не работает в MV3 isolated world).
  // При SPA-переходе на /music-history делаем тихую перезагрузку,
  // чтобы получить __STATE_SNAPSHOT__ с полными данными истории.
  let lastPathname = location.pathname;

  setInterval(() => {
    const current = location.pathname;
    if (current !== lastPathname) {
      const wasHistory = isHistoryPage(lastPathname);
      lastPathname = current;

      if (isHistoryPage(current)) {
        if (!wasHistory) {
          // SPA-переход НА страницу истории.
          // __STATE_SNAPSHOT__ с данными доступен только при полной загрузке.
          // Проверим — если indexesMap нет, перезагрузим страницу.
          setTimeout(() => {
            const scripts = document.querySelectorAll("script");
            let hasHistoryData = false;
            for (const s of scripts) {
              const t = s.textContent || "";
              if (t.includes("indexesMap") && t.includes("_0_0_")) {
                hasHistoryData = true;
                break;
              }
            }
            if (!hasHistoryData) {
              // Тихая перезагрузка для получения SSR-данных
              location.reload();
            } else {
              activate();
            }
          }, 1000);
        } else {
          activate();
        }
      } else {
        deactivate();
      }
    }
  }, 500);
}

// ─── Injection logic ─────────────────────────────────────────────────────────

/**
 * Внедряет кнопку скачивания рядом с Date_Header, если кнопка ещё не
 * была внедрена (идемпотентность через data-атрибут маркер).
 */
function injectButtonIfNeeded(
  header: Element,
  deps: HistoryInjectorDeps,
): void {
  // Идемпотентность: проверяем маркер на header
  if (header.hasAttribute(BUTTON_MARKER_ATTR)) return;

  const dateText = (header.textContent ?? "").trim();
  if (dateText.length === 0) return;

  const dateButton = createDateButton(dateText);

  // Привязываем click handler
  dateButton.element.addEventListener("click", () => {
    void handleDateButtonClick(header, dateButton, dateText, deps);
  });

  // Вставляем кнопку после header (внутрь, в конец)
  header.appendChild(dateButton.element);
  header.setAttribute(BUTTON_MARKER_ATTR, "1");
}

/**
 * Обработчик клика по Date_Download_Button.
 * Собирает track ID через custom resolve, делегирует в createBulkDownload.
 *
 * Requirements: 3.4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 5.1, 5.2
 */
async function handleDateButtonClick(
  header: Element,
  dateButton: DateButton,
  dateText: string,
  deps: HistoryInjectorDeps,
): Promise<void> {
  dateButton.setState("loading");

  // Извлекаем ВСЕ треки за дату из __STATE_SNAPSHOT__ (обход виртуализации)
  const trackIds = collectTrackIdsFromState(header);

  if (trackIds.length === 0) {
    deps.notify("Треки не найдены", "error");
    dateButton.setState("idle");
    return;
  }

  // Читаем формат из storage с fallback на MP3 (Req 5.1, 5.2)
  let format: string;
  try {
    const prefs = await getFormatPreferences();
    format = prefs.bulkFormat;
  } catch {
    format = "mp3";
  }

  const folderName = sanitizeFolderName(dateText);
  const total = trackIds.length;

  // Показываем confirmation dialog с количеством треков и ETA (Req 4.1)
  const etaSeconds = Math.ceil((total * 800) / 1000);
  const confirmed = window.confirm(
    `Скачать ${total} треков? Примерно ${etaSeconds} сек.`,
  );
  if (!confirmed) {
    dateButton.setState("idle");
    return;
  }

  // Трекинг результата для определения success/error
  let hadErrors = false;

  const controller: BulkDownloadController = createBulkDownload(
    {
      onProgress(done: number, total: number): void {
        dateButton.setState("progress", `${done}/${total}`);
      },
      onIdle(): void {
        // Определяем итоговое состояние: success если нет ошибок, error если есть (Req 4.4, 4.6)
        if (hadErrors) {
          dateButton.setState("error");
        } else {
          dateButton.setState("success");
        }
      },
      notify(text: string, kind: "success" | "error" | "info"): void {
        deps.notify(text, kind);
        if (kind === "error") {
          hadErrors = true;
        }
      },
      confirm(_message: string): boolean {
        // Мы уже показали confirm выше, всегда подтверждаем внутренний вызов
        return true;
      },
    },
    {
      resolve: async () => ({
        ids: trackIds,
        source: "DOM" as const,
        title: folderName,
      }),
    },
  );

  try {
    await controller.start();
  } catch (e) {
    dateButton.setState("error");
    deps.notify(
      e instanceof Error ? e.message : "Ошибка скачивания",
      "error",
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Format is read from storage via getFormatPreferences().
// The Service Worker uses the stored format preference when processing
// DOWNLOAD_TRACK messages, so explicit format passing is not needed here.
