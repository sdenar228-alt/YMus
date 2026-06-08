// Entry-point content script для open.spotify.com (изолированный мир,
// `run_at: "document_idle"`).
//
// Контракт модуля:
//   * Один раз при старте инжектирует общие стили кнопки
//     (`injectSpotifyButtonStyles()`), запускает track-injector и
//     now-playing-injector с единым обработчиком клика `onTrackClick`.
//   * При клике формирует новый `sessionId` и шлёт в background SW
//     сообщение `SPOTIFY_DOWNLOAD_TRACK`. Карта `sessionId → button`
//     используется только для маршрутизации `SPOTIFY_DOWNLOAD_PROGRESS`-
//     сообщений; никакого глобального single-active-capture лока нет —
//     параллельные скачивания разрешены и ограничены только
//     per-button CSS-классом `.ymus-loading` (R14.3, R14.4, R14.6).
//   * Перехватывает SPA-навигацию через `pushState`/`replaceState` и
//     `popstate`. Spotify рендерит новую страницу не мгновенно (асинхронные
//     React-апдейты), поэтому через 1 500 мс после события мы провоцируем
//     лёгкую DOM-мутацию (вставка/удаление невидимого `<span>`), чтобы
//     поднять MutationObserver'ы внутри injector'ов и заставить их
//     перепросканировать DOM (R2.8). Этот же приём используется в
//     `vk-content.ts` и подтверждён работающим в продакшене.
//   * Маппит ответ SW: `success: true` → `setButtonSuccess(btn)` на
//     1 700 мс + опциональный `showSpotifyInfo(fallbackReason)`;
//     `success: false` → `setButtonError(btn)` на 1 500 мс +
//     `showSpotifyError(errorCode, override?, ctx?)`. Смена состояния
//     кнопки выполняется ДО попытки показа toast (R15.4, R15.5): если
//     `showSpotify*` бросит, кнопка всё равно окажется в корректном
//     терминальном состоянии.
//   * MAIN-world bridge (`spotify-page-bridge.ts`) НЕ подключается —
//     это Phase 2 fallback (см. design § «MAIN-world bridge»).

import type {
  SpotifyDownloadProgressMessage,
  SpotifyDownloadResponse,
  SpotifyTrackMeta,
} from "../shared/spotify-types";
import {
  injectSpotifyButtonStyles,
  setButtonError,
  setButtonLoading,
  setButtonSuccess,
  setDownloadButtonProgress,
} from "./spotify-button-states";
import { startSpotifyNowPlayingInjector } from "./spotify-now-playing-injector";
import { startSpotifyTrackInjector } from "./spotify-track-injector";
import { showSpotifyError, showSpotifyInfo } from "./spotify-error-toast";

/** Тип сообщения, которое content script шлёт в SW при клике по кнопке. */
const MSG_DOWNLOAD_TRACK = "SPOTIFY_DOWNLOAD_TRACK" as const;

/** Тип progress-сообщений, рассылаемых SW обратно во вкладку. */
const MSG_DOWNLOAD_PROGRESS = "SPOTIFY_DOWNLOAD_PROGRESS" as const;

/**
 * Задержка пере-сканирования DOM после SPA-навигации (R2.8). Spotify
 * рендерит новый маршрут асинхронно через React; 1 500 мс — верхняя
 * граница, оговорённая в acceptance criteria.
 */
const SPA_RESCAN_DELAY_MS = 1500;

/**
 * Карта `sessionId → button`, по которой content script роутит
 * прогресс-сообщения от SW обратно к конкретной кнопке. Карта живёт
 * пока активны соответствующие скачивания; запись удаляется в callback
 * `chrome.runtime.sendMessage`, как только SW прислал финальный ответ
 * (success или failure).
 *
 * Это per-session map — несколько одновременных скачиваний не делят
 * состояние и не блокируют друг друга (R14.3, R14.4).
 */
const sessionToButton: Map<string, HTMLButtonElement> = new Map();

/**
 * Сгенерировать уникальный `sessionId`. Формат `ymus_spotify_{ts}_{rnd}`
 * выбран для удобства поиска по логам — префикс `ymus_spotify_` сразу
 * отличает наши сообщения от внутренних запросов Spotify.
 */
function generateSessionId(): string {
  return `ymus_spotify_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * Единый обработчик клика для обоих injector'ов (track-row и now-playing).
 * Шаги:
 *   1. Сгенерировать `sessionId` и зарегистрировать кнопку в карте.
 *   2. Перевести кнопку в loading с 0% (детерминатно).
 *   3. Отправить `SPOTIFY_DOWNLOAD_TRACK` в SW; в callback'е снять
 *      запись из карты, обработать ответ (success/error) и показать
 *      toast.
 *
 * Любые исключения внутри обработчика toast'а гасятся, чтобы не
 * сломать смену состояния кнопки (R15.5).
 */
function onTrackClick(meta: SpotifyTrackMeta, btn: HTMLButtonElement): void {
  const sessionId = generateSessionId();
  sessionToButton.set(sessionId, btn);

  // Сразу переводим кнопку в детерминатный loading с 0%, чтобы
  // пользователь видел отклик до прихода первого progress-сообщения.
  setButtonLoading(btn, 0);

  chrome.runtime.sendMessage(
    {
      type: MSG_DOWNLOAD_TRACK,
      payload: { sessionId, trackMeta: meta },
    },
    (response: SpotifyDownloadResponse | undefined) => {
      // Снимаем запись из карты сразу: финальный ответ пришёл, дальнейших
      // прогрессов по этому sessionId не будет.
      sessionToButton.delete(sessionId);

      // chrome.runtime.lastError выставляется, если SW был выгружен или
      // расширение перезагрузилось во время скачивания. Обращение к
      // полю гасит «Unchecked runtime.lastError» в DevTools.
      const lastError = chrome.runtime.lastError;
      if (response === undefined || lastError !== undefined) {
        // R15.4 / R15.5 — состояние кнопки меняется до toast.
        setButtonError(btn);
        try {
          showSpotifyError(
            "SPOTIFY_DOWNLOAD_FAILED",
            "Не удалось связаться с расширением",
            lastError?.message,
          );
        } catch {
          // Toast не должен ломать пайплайн смены состояния кнопки.
        }
        return;
      }

      if (response.success) {
        // R15.3 — success-индикатор на 1 700 мс, авто-откат в idle
        // выполняется внутри `setButtonSuccess`.
        setButtonSuccess(btn);
        if (response.fallbackReason !== undefined) {
          try {
            showSpotifyInfo(response.fallbackReason);
          } catch {
            // см. комментарий выше
          }
        }
        return;
      }

      // Failure-ветка (R15.4, R15.5): сначала кнопка в error, затем toast.
      setButtonError(btn);
      try {
        showSpotifyError(response.errorCode, undefined, response.reason);
      } catch {
        // Любая ошибка при показе toast не должна повлиять на состояние
        // кнопки, которое мы уже выставили в error.
      }
    },
  );
}

/**
 * Обработчик прогресс-сообщений от SW. Извлекает `sessionId`, ищет
 * соответствующую кнопку в карте и обновляет её прогресс. Если кнопки
 * в карте нет (поздний прогресс уже после финального ответа) —
 * молча игнорируем.
 *
 * `setDownloadButtonProgress` сама по себе не меняет state-классы,
 * поэтому сообщение, дошедшее уже после `setButtonSuccess`/`setButtonError`,
 * не «откатит» кнопку в loading — оно лишь обновит CSS-переменную
 * прогресса, которая невидима в success/error визуально (R15.2).
 */
function onProgressMessage(message: SpotifyDownloadProgressMessage): void {
  const btn = sessionToButton.get(message.payload.sessionId);
  if (btn === undefined) return;
  setDownloadButtonProgress(btn, message.payload.percent);
}

/**
 * Type-guard для `SPOTIFY_DOWNLOAD_PROGRESS`. Сообщения от SW могут
 * иметь произвольную форму (другие фичи), поэтому мы валидируем поля
 * до приведения к нашему типу.
 */
function isProgressMessage(msg: unknown): msg is SpotifyDownloadProgressMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as { type?: unknown; payload?: unknown };
  if (m.type !== MSG_DOWNLOAD_PROGRESS) return false;
  if (typeof m.payload !== "object" || m.payload === null) return false;
  const p = m.payload as { sessionId?: unknown; percent?: unknown };
  if (typeof p.sessionId !== "string") return false;
  // percent: number | null
  if (p.percent !== null && typeof p.percent !== "number") return false;
  return true;
}

/**
 * Спровоцировать «холостую» DOM-мутацию, чтобы поднять MutationObserver'ы
 * внутри injector'ов. Используется как safety-net после SPA-навигации,
 * когда Spotify рендерит новый маршрут асинхронно и наш ранний
 * `MutationObserver` мог не получить ни одного события за окно
 * наблюдения. Точно такой же приём применяется в `vk-content.ts`.
 *
 * Ловим исключения на случай, если к моменту срабатывания таймера
 * `document.body` уже отсоединён (страница закрыта в момент перехода).
 */
function tickleObserversToRescan(): void {
  setTimeout(() => {
    try {
      if (document.body === null) return;
      const marker = document.createElement("span");
      marker.style.display = "none";
      marker.setAttribute("data-ymus-spotify-tick", "1");
      document.body.appendChild(marker);
      marker.remove();
    } catch {
      // Любые DOM-исключения здесь некритичны: injector'ы всё равно
      // подтянутся при следующем естественном изменении страницы.
    }
  }, SPA_RESCAN_DELAY_MS);
}

/**
 * Перехватить `pushState`/`replaceState` и `popstate`, чтобы заметить
 * SPA-навигацию Spotify. Сами injector'ы уже наблюдают за DOM через
 * `MutationObserver`, но `tickleObserversToRescan` — гарантированный
 * safety-net на случай, если react-перерисовка происходит в одном
 * мутационном «такте» с навигацией и observer-callback пропускает её.
 */
function startSpaNavigationWatcher(): void {
  // pushState
  const origPushState = history.pushState.bind(history);
  history.pushState = function (
    ...args: Parameters<typeof history.pushState>
  ): void {
    origPushState(...args);
    tickleObserversToRescan();
  };

  // replaceState
  const origReplaceState = history.replaceState.bind(history);
  history.replaceState = function (
    ...args: Parameters<typeof history.replaceState>
  ): void {
    origReplaceState(...args);
    tickleObserversToRescan();
  };

  // popstate (browser back/forward)
  window.addEventListener("popstate", () => {
    tickleObserversToRescan();
  });
}

/**
 * Стартовая точка content script. Идемпотентна для своего собственного
 * вызова: при повторном запуске injector'ы внутри сами отключают
 * предыдущие MutationObserver'ы.
 */
function start(): void {
  // Стили один раз при старте (R15.6, R16.2). Повторные вызовы — no-op.
  injectSpotifyButtonStyles();

  // Track-row injector — одна кнопка на каждый `[data-testid="tracklist-row"]`.
  startSpotifyTrackInjector(onTrackClick);
  // Now-playing bar — ровно одна кнопка, обновляемая при смене трека.
  startSpotifyNowPlayingInjector(onTrackClick);

  // Слушаем прогресс из SW. Возвращаем `false` — синхронный listener,
  // не удерживаем порт ответа.
  chrome.runtime.onMessage.addListener((message: unknown): boolean => {
    if (isProgressMessage(message)) {
      onProgressMessage(message);
    }
    return false;
  });

  startSpaNavigationWatcher();

  // eslint-disable-next-line no-console
  console.log("[YMus] Spotify content script loaded");
}

// `run_at: "document_idle"` гарантирует, что body уже существует.
// Дополнительная проверка `typeof document` — защита от случайной
// загрузки модуля в SW-контексте (например, через статический import
// из неправильного места).
if (typeof document !== "undefined") {
  start();
}
