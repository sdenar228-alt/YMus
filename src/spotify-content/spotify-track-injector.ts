// DOM-инжектор кнопки скачивания в строки трек-листа на open.spotify.com.
//
// Контракт:
//   * `startSpotifyTrackInjector(onClick)` запускает первичный
//     `scanAndInject()`, ставит `MutationObserver` на `document.body`
//     с `subtree: true, childList: true` и реагирует на изменения DOM
//     с дебаунсом 200 мс (R2.1, R2.2).
//   * Обработанные `Spotify_Track_Row` помечаются атрибутом
//     `data-ymus-spotify-bound="1"`. Уже помеченные строки пропускаются
//     до тех пор, пока на них есть реально присоединённая наша кнопка
//     (R2.4, R2.5). При обнаружении «битого» состояния — атрибут есть,
//     но кнопки нет — маркер сбрасывается и кнопка инжектится заново
//     (защита от React-re-render, который мог стереть детей строки).
//   * При **физическом** удалении строки из DOM (видим через
//     `mutation.removedNodes`) атомарно отключаем `protectObserver`
//     этой строки и удаляем кнопку из DOM. Listener'ы навешены на
//     саму кнопку, поэтому удаление узла из дерева автоматически
//     отвязывает все обработчики (R2.6).
//   * При виртуализации через `display:none` / трансформацию за вьюпорт
//     узел остаётся в DOM, и мы оставляем кнопку и её обработчики на
//     месте (R2.7). Это поведение покрывается тем, что мы реагируем
//     только на `removedNodes`, а не на стилевые изменения.
//   * На самой кнопке навешены capture-фазные listener'ы
//     `pointerdown` / `mousedown` / `touchstart` / `click` со
//     `stopPropagation()`, чтобы клик не дошёл до делегированного
//     row-handler'а Spotify и не запустил воспроизведение трека
//     (R14.2). Для `click` дополнительно вызывается `preventDefault()`.
//   * Повторные клики, пока кнопка имеет класс `ymus-loading`, тихо
//     игнорируются (R14.6). Параллельные скачивания на разных кнопках
//     ничем не блокируются — состояние локально в DOM-классах
//     конкретной кнопки (R14.3, R14.4).
//   * `protectButtonFromReact(row, btn)` ставит на каждый row отдельный
//     `MutationObserver`, который при стирании детей React-re-render'ом
//     восстанавливает нашу кнопку. Скопировано из `vk-track-injector.ts`.
//
// Модуль не отправляет сообщений в background SW и не работает с
// `chrome.*` напрямую: вызывающий entry-point получает callback
// `onClick(meta, btn)` и сам формирует сообщение `SPOTIFY_DOWNLOAD_TRACK`.

import type { SpotifyTrackMeta } from "../shared/spotify-types";
import { extractSpotifyTrackMeta } from "./spotify-track-meta";
import {
  createSpotifyDownloadButton,
  injectSpotifyButtonStyles,
  setButtonError,
} from "./spotify-button-states";
import { showSpotifyError } from "./spotify-error-toast";

const SPOTIFY_BOUND_ATTR = "data-ymus-spotify-bound";
const SPOTIFY_ROW_SELECTOR = '[data-testid="tracklist-row"]';

/** Дополнительный класс на кнопке трек-листа — чтобы отличать её от
 *  кнопки now-playing-bar и при необходимости находить через `:scope`. */
const TRACK_BTN_CLASS = "ymus-spotify-track-dl-btn";

/** id `<style>` с inline-разметкой позиционирования кнопки. */
const POSITIONING_STYLE_ID = "ymus-spotify-track-injector-styles";

/** Дебаунс между мутациями `document.body`, чтобы не сканировать DOM
 *  по 100 раз во время burst-перерисовок Spotify (R2.2). */
const SCAN_DEBOUNCE_MS = 200;

let onClickRef: ((meta: SpotifyTrackMeta, btn: HTMLButtonElement) => void) | null = null;
let observer: MutationObserver | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Карта `row → MutationObserver`, защищающий конкретную кнопку от
 * React-re-render'а. WeakMap позволяет GC автоматически освобождать
 * запись, когда сам узел строки больше нигде не удерживается.
 *
 * Дополнительно при удалении строки из DOM (`detachRemovedNode`) мы
 * **явно** вызываем `obs.disconnect()` и `protectObservers.delete(row)`,
 * чтобы не оставлять висячий observer, держащий ссылку на отсоединённый
 * узел (R2.6).
 */
const protectObservers: WeakMap<Element, MutationObserver> = new WeakMap();

/** Идемпотентно вставить минимальные стили позиционирования кнопки. */
function injectPositioningStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(POSITIONING_STYLE_ID) !== null) return;
  const head = document.head ?? document.documentElement;
  if (head === null) return;

  const style = document.createElement("style");
  style.id = POSITIONING_STYLE_ID;
  // Стилизуем только саму инъекцию: даём строке `position: relative`,
  // а кнопке — абсолютное позиционирование в правом крае строки. Так
  // мы не зависим от внутренней grid-структуры Spotify и не рискуем
  // сломать его макет, если структура `[role="gridcell"]` поменяется.
  style.textContent = `
    [data-testid="tracklist-row"][${SPOTIFY_BOUND_ATTR}] {
      position: relative !important;
    }
    /* Кнопка лежит абсолютом ЛЕВЕЕ нативной "Сохранить"-стрелки Spotify.
     * 56 px справа достаточно, чтобы не накрывать их иконку и при этом
     * остаться внутри последней колонки трек-листа. z-index выкручен
     * на 100, чтобы перекрыть Spotify-overlay-эффекты при наведении. */
    .${TRACK_BTN_CLASS} {
      position: absolute !important;
      right: 56px !important;
      top: 50% !important;
      transform: translateY(-50%) !important;
      z-index: 100 !important;
    }
  `;
  head.appendChild(style);
}

/**
 * Один проход по DOM: находит все `Spotify_Track_Row`, для каждой
 * непомеченной — инжектит кнопку. Идемпотентно: при повторных вызовах
 * уже корректно помеченные строки пропускаются (R2.4, R2.5).
 */
function scanAndInject(): void {
  if (typeof document === "undefined" || document.body === null) return;
  injectSpotifyButtonStyles();
  injectPositioningStyles();

  const rows = document.querySelectorAll<HTMLElement>(SPOTIFY_ROW_SELECTOR);
  for (const row of Array.from(rows)) {
    const existingBtn = row.querySelector<HTMLButtonElement>(
      `:scope > button.${TRACK_BTN_CLASS}`,
    );

    // Уже инжектирована живая кнопка — пропускаем (R2.5).
    if (
      row.getAttribute(SPOTIFY_BOUND_ATTR) !== null &&
      existingBtn !== null &&
      existingBtn.isConnected
    ) {
      continue;
    }

    // Stale state: атрибут есть, а кнопки нет либо она отсоединена
    // (React стёр детей строки). Сбрасываем маркер, чтобы пере-инжектить.
    if (row.getAttribute(SPOTIFY_BOUND_ATTR) !== null) {
      row.removeAttribute(SPOTIFY_BOUND_ATTR);
    }

    injectButtonIntoRow(row);
    row.setAttribute(SPOTIFY_BOUND_ATTR, "1");
  }
}

/**
 * Создаёт кнопку, навешивает обработчики и добавляет её в строку.
 *
 * Обработчики создаются здесь же и захватывают `row` через замыкание,
 * чтобы извлечение меты на клике видело именно ту строку, в которую
 * кнопка была инжектирована. На случай, если изначальный `row` к
 * моменту клика отсоединён (виртуализация / SPA-навигация), повторно
 * пытаемся найти ближайшую `Spotify_Track_Row` через `closest`.
 */
function injectButtonIntoRow(row: HTMLElement): void {
  const btn = createSpotifyDownloadButton();
  btn.classList.add(TRACK_BTN_CLASS);

  // Глушим события указателя в capture-фазе на самой кнопке, чтобы
  // клик не запускал воспроизведение Spotify (R14.2). preventDefault
  // вызывается только на `click`, чтобы не блокировать pointer-/touch-
  // дефолты вроде scroll cancel — нам нужно лишь не дать событию
  // долететь до делегированного row-handler'а.
  const swallowPropagation = (event: Event): void => {
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  btn.addEventListener("pointerdown", swallowPropagation, true);
  btn.addEventListener("mousedown", swallowPropagation, true);
  btn.addEventListener("touchstart", swallowPropagation, {
    capture: true,
    passive: false,
  });

  btn.addEventListener(
    "click",
    (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      // Повторный клик пока кнопка в loading — игнорируем (R14.6).
      if (btn.classList.contains("ymus-loading")) return;

      // Резолв строки на момент клика. Обычно живёт исходный `row`,
      // но если SPA-перерисовка отсоединила узел, поднимаемся по DOM
      // от самой кнопки — возможно, она уже перевешена в новый row.
      let activeRow: Element | null = row.isConnected ? row : null;
      if (activeRow === null) {
        activeRow = btn.closest(SPOTIFY_ROW_SELECTOR);
      }

      if (activeRow === null) {
        // Не нашли строку — невозможно вытащить trackId. Показываем
        // toast и переводим кнопку в error на 1500 мс (R3.7, R15.4).
        showSpotifyError("SPOTIFY_TRACK_ID_INVALID");
        setButtonError(btn);
        return;
      }

      const meta = extractSpotifyTrackMeta(activeRow);
      if (meta === null) {
        // Дампим структуру строки, чтобы было видно, какие data-testid
        // и href сейчас живут на этой Spotify-разметке. Это убирает
        // догадки и позволяет быстро поправить селекторы для нового
        // варианта DOM.
        try {
          const links = Array.from(
            activeRow.querySelectorAll<HTMLAnchorElement>("a"),
          ).map((a) => ({
            href: a.getAttribute("href"),
            text: (a.textContent ?? "").trim().slice(0, 40),
          }));
          const uriHosts = Array.from(
            activeRow.querySelectorAll<HTMLElement>(
              "[data-context-uri], [data-uri]",
            ),
          ).map((el) => ({
            tag: el.tagName.toLowerCase(),
            uri:
              el.getAttribute("data-context-uri") ??
              el.getAttribute("data-uri") ??
              "",
          }));
          const testids = Array.from(
            activeRow.querySelectorAll<HTMLElement>("[data-testid]"),
          )
            .slice(0, 8)
            .map((el) => el.getAttribute("data-testid"));
          console.warn(
            "[ymd][spotify][injector] extractSpotifyTrackMeta returned null for row.",
            { links, uriHosts, testids, html: activeRow.outerHTML.slice(0, 800) },
          );
        } catch {
          /* ignore diag failure */
        }
        showSpotifyError("SPOTIFY_TRACK_ID_INVALID");
        setButtonError(btn);
        return;
      }

      if (onClickRef !== null) {
        onClickRef(meta, btn);
      }
    },
    true,
  );

  row.appendChild(btn);
  protectButtonFromReact(row, btn);
}

/**
 * Watch the row for React re-renders that strip our button. Если кнопка
 * перестала быть ребёнком строки, пере-вставляем её. Когда строка сама
 * отсоединяется от DOM — наблюдатель отключается; явное отключение
 * также делает `detachRemovedNode` в основном обсервере.
 *
 * Реализация скопирована с `vk-track-injector.ts` для единообразия.
 */
function protectButtonFromReact(row: HTMLElement, btn: HTMLButtonElement): void {
  // Если для этой строки уже стоит наблюдатель (повторный
  // `injectButtonIntoRow` после stale-сценария) — отключаем его, чтобы
  // не плодить параллельных обсерверов.
  const prev = protectObservers.get(row);
  if (prev !== undefined) {
    prev.disconnect();
    protectObservers.delete(row);
  }

  let stopped = false;
  const obs = new MutationObserver(() => {
    if (stopped) return;
    if (!row.isConnected) {
      stopped = true;
      obs.disconnect();
      protectObservers.delete(row);
      return;
    }
    if (!row.contains(btn)) {
      try {
        row.appendChild(btn);
      } catch {
        // Row может быть в транзитном состоянии — следующая мутация
        // вызовет наблюдатель снова, и мы повторим попытку.
      }
    }
  });
  obs.observe(row, { childList: true });
  protectObservers.set(row, obs);
}

/** Дебаунсит вызовы `scanAndInject` под burst-мутации Spotify (R2.2). */
function debouncedScan(): void {
  if (debounceTimer !== null) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    scanAndInject();
  }, SCAN_DEBOUNCE_MS);
}

/**
 * Обходит удалённое поддерево и для каждой `Spotify_Track_Row` с нашей
 * меткой:
 *   1. отключает её `protectObserver` и убирает запись из карты;
 *   2. удаляет нашу кнопку из DOM (что атомарно отвязывает все её
 *      capture-фазные listener'ы — R2.6).
 *
 * Сама строка уже отсоединена от документа, но всё ещё доступна как
 * `Element` в момент срабатывания observer'а; `querySelector` по
 * поддереву работает корректно.
 */
function detachRemovedNode(node: Node): void {
  if (!(node instanceof Element)) return;

  const bound: Element[] = [];
  if (typeof node.matches === "function" && node.matches(`[${SPOTIFY_BOUND_ATTR}]`)) {
    bound.push(node);
  }
  if (typeof node.querySelectorAll === "function") {
    for (const el of Array.from(node.querySelectorAll(`[${SPOTIFY_BOUND_ATTR}]`))) {
      bound.push(el);
    }
  }

  for (const row of bound) {
    const obs = protectObservers.get(row);
    if (obs !== undefined) {
      obs.disconnect();
      protectObservers.delete(row);
    }
    const btn = row.querySelector<HTMLButtonElement>(`button.${TRACK_BTN_CLASS}`);
    if (btn !== null) {
      try {
        btn.remove();
      } catch {
        // Узел может уже не иметь parentElement — это нормально.
      }
    }
  }
}

/**
 * Запустить инжектор. Идемпотентно: повторный вызов сначала отключает
 * предыдущий observer и сбрасывает дебаунсер, после чего стартует с
 * чистого состояния. Полезно для SPA-перенавигаций — entry-point может
 * перезапустить инжектор после `pushState`/`popstate`.
 */
export function startSpotifyTrackInjector(
  onClick: (meta: SpotifyTrackMeta, btn: HTMLButtonElement) => void,
): void {
  onClickRef = onClick;

  // На случай повторного запуска — отключаем предыдущий observer.
  if (observer !== null) {
    observer.disconnect();
    observer = null;
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  scanAndInject();

  observer = new MutationObserver((mutations) => {
    // Сначала «очищаем» отвалившиеся строки — это снимает observer'ы и
    // удаляет кнопки атомарно, до того как дебаунсер запланирует
    // следующий скан.
    for (const mutation of mutations) {
      for (const removed of Array.from(mutation.removedNodes)) {
        detachRemovedNode(removed);
      }
    }
    debouncedScan();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * Остановить инжектор: отключить главный observer и сбросить
 * запланированный скан. Существующие кнопки в DOM при этом **не**
 * удаляются — пользователь должен иметь возможность доскачать уже
 * запущенный трек. Используется entry-point'ом на unload-подобных
 * сценариях.
 */
export function stopSpotifyTrackInjector(): void {
  if (observer !== null) {
    observer.disconnect();
    observer = null;
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  onClickRef = null;
}
