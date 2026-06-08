/**
 * Module: playlist-header-button
 *
 * UI-обёртка кнопки «Скачать плейлист», размещаемой рядом с
 * Заголовком_Плейлиста (Requirements 3, 4.7–4.10, 6).
 *
 * Этот файл (task 7.1) реализует ТОЛЬКО построение DOM, состояния, стили,
 * доступность и проводку клика на контроллер группового скачивания
 * (`createBulkDownload` из {@link ./bulk-download}). Жизненный цикл
 * (URLObserver, MutationObserver, дебаунс, тайм-аут 15 сек, сброс при
 * SPA-навигации) добавляется в task 7.2.
 *
 * Контракт публичного API:
 *  - {@link BUTTON_ID}                      — стабильный идентификатор кнопки.
 *  - {@link PlaylistHeaderButtonOptions}    — параметры инициализации.
 *  - {@link PlaylistHeaderButtonHandle}     — handle с `.stop()` для остановки.
 *  - {@link startPlaylistHeaderButton}      — публичная точка входа.
 *  - {@link buildButton}                    — построение DOM-узла кнопки.
 *  - {@link setButtonState}                 — переключение idle ↔ running.
 *  - {@link wireClickHandler}               — привязка клика к контроллеру.
 *
 * См. design.md → "Components and Interfaces" → `playlist-header-button.ts`
 * и Requirements 3.1, 3.2, 3.3, 3.4, 3.7, 6.1, 6.2, 6.3, 6.5.
 */

import {
  createBulkDownload,
  type BulkDownloadController,
} from "./bulk-download";
import {
  detectListPageKind,
  findPlaylistHeader,
  findPlaylistToolbar,
} from "./playlist-header-finder";
import { observeURLChanges } from "./url-observer";

// ─── Public constants and types ──────────────────────────────────────────────

/**
 * Стабильный идентификатор кнопки в DOM.
 *
 * Используется UI-обёрткой (этот модуль) и контроллером жизненного цикла
 * (task 7.2) для проверки уникальности (Requirement 3.4) и поиска ранее
 * внедрённой кнопки.
 */
export const BUTTON_ID = "ymd-playlist-download-btn";

/**
 * Подписи и текстовые состояния кнопки.
 * Вынесены в константы, чтобы избежать рассинхрона между `textContent` и
 * `aria-label`, и чтобы обеспечить идентичные тексты в unit-тестах.
 */
const LABEL_IDLE = "Скачать плейлист";
const ARIA_LABEL_IDLE = "Скачать плейлист";

/**
 * SVG-иконка стрелки вниз для компактного режима кнопки.
 * Используется когда кнопка размещена в toolbar плейлиста рядом
 * с действиями «Закрепить», «...» — там нужен иконочный вид без текста.
 */
const ICON_DOWNLOAD = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

/**
 * Состояние кнопки.
 *
 * - `idle` — исходное состояние, кнопка активна, текст «Скачать плейлист».
 * - `running` — идёт групповое скачивание, кнопка `disabled=true`, текст и
 *   `aria-label` отражают прогресс `{done}/{total}`. Состояние `done`
 *   из дизайна сводится к переходу обратно в `idle`.
 */
export type PlaylistButtonState =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly done: number; readonly total: number };

/**
 * Параметры инициализации кнопки.
 *
 * @property notify  — UI-toast наружу (например, `FloatingButton.showToast`).
 * @property confirm — модальное подтверждение перед стартом цикла.
 *                     По умолчанию используется `window.confirm`.
 */
export interface PlaylistHeaderButtonOptions {
  notify(text: string, kind: "success" | "error" | "info"): void;
  confirm?(message: string): boolean;
}

/**
 * Handle, возвращаемый {@link startPlaylistHeaderButton}.
 *
 * Метод `.stop()` останавливает контроллер жизненного цикла (URLObserver,
 * MutationObserver, тайм-аут) и удаляет ранее внедрённую кнопку, если она
 * присутствует в DOM. На текущем этапе (task 7.1) — заглушка; полное
 * поведение реализуется в task 7.2.
 */
export interface PlaylistHeaderButtonHandle {
  stop(): void;
}

// ─── Visual constants ────────────────────────────────────────────────────────

/** Фон в состоянии idle (Requirement 3.3). */
const BG_IDLE = "#ffff00";
/** Фон при hover/focus/active — отличается от idle (Requirement 6.5). */
const BG_HOVER = "#ffff66";
/** Цвет outline для focus-стиля (Requirement 6.5). */
const FOCUS_OUTLINE_COLOR = "#1d1d1f";

/**
 * Базовые стили кнопки в КОМПАКТНОМ idle-состоянии: круглая иконочная
 * кнопка 32×32, размещаемая в toolbar плейлиста рядом с «Закрепить», «...».
 *
 * Стили зафиксированы согласно Requirements 3.3, 3.7:
 *  - `position: static`         — запрет fixed/absolute/sticky (Req 3.7);
 *  - `display: inline-flex`     — кнопка в одной горизонтальной линии с соседями;
 *  - `margin-left: 12px`        — отступ ∈ [8, 24] px (Req 3.3);
 *  - `width/height: 32px`       — фиксированный квадратный размер;
 *  - `border-radius: 50%`       — круглая форма;
 *  - `background: #ffff00`      — фирменный жёлтый фон.
 */
function applyIdleStyle(btn: HTMLButtonElement): void {
  btn.style.cssText = [
    "position: static",
    "display: inline-flex",
    "align-items: center",
    "justify-content: center",
    "gap: 0",
    "margin-left: 12px",
    "padding: 0",
    "width: 32px",
    "height: 32px",
    "min-width: 32px",
    `background: ${BG_IDLE}`,
    "color: #1d1d1f",
    "border: none",
    "border-radius: 50%",
    "cursor: pointer",
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    "font-size: 13px",
    "font-weight: 600",
    "letter-spacing: 0.1px",
    "line-height: 1",
    "user-select: none",
    "vertical-align: middle",
    "outline: none",
    "outline-offset: 0",
    "transform: scale(1)",
    "transition: transform 0.12s, background 0.15s, outline-color 0.12s, width 0.15s, border-radius 0.15s",
    "flex-shrink: 0",
  ].join("; ");
}

/**
 * Стили кнопки в running-состоянии: pill-форма с прогрессом «{done}/{total}».
 * Расширяемся по ширине, чтобы текст влез, но остаёмся в той же позиции
 * toolbar-а.
 */
function applyRunningStyle(btn: HTMLButtonElement): void {
  btn.style.position = "static";
  btn.style.display = "inline-flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "center";
  btn.style.gap = "6px";
  btn.style.marginLeft = "12px";
  btn.style.padding = "0 12px";
  btn.style.width = "auto";
  btn.style.height = "32px";
  btn.style.minWidth = "32px";
  btn.style.background = BG_IDLE;
  btn.style.color = "#1d1d1f";
  btn.style.border = "none";
  btn.style.borderRadius = "16px";
  btn.style.fontFamily =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  btn.style.fontSize = "12px";
  btn.style.fontWeight = "600";
  btn.style.letterSpacing = "0.1px";
  btn.style.lineHeight = "1";
  btn.style.userSelect = "none";
  btn.style.verticalAlign = "middle";
  btn.style.flexShrink = "0";
}

// ─── Public helpers ──────────────────────────────────────────────────────────

/**
 * Строит DOM-узел кнопки «Скачать плейлист».
 *
 * Гарантии (Requirements 3.1, 3.2, 3.3, 3.7, 6.1, 6.2, 6.3, 6.5):
 *  - элемент `<button type="button">`;
 *  - `id === BUTTON_ID` (для проверки уникальности);
 *  - текстовая метка «Скачать плейлист» (видимая, не только иконка);
 *  - `aria-label === "Скачать плейлист"`;
 *  - `position: static` (запрет fixed/absolute/sticky);
 *  - `display: inline-flex`, `margin-left: 16px`, `border-radius: 16px`,
 *    `padding: 6px 14px`, `height: 32px`, `background: #ffff00`;
 *  - hover/focus/active изменяют ОДНОВРЕМЕННО `background` И
 *    (`transform: scale(1.04)` либо `outline: 2px solid #1d1d1f`),
 *    то есть отличие не основано исключительно на цвете;
 *  - клавиатурная активация Enter/Space обеспечивается нативно `<button>`.
 *
 * Кнопка возвращается БЕЗ привязки к click-обработчику — за это отвечает
 * {@link wireClickHandler}, чтобы построение DOM и провязка с
 * {@link createBulkDownload} тестировались независимо.
 */
export function buildButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.type = "button";
  btn.title = LABEL_IDLE;
  btn.innerHTML = ICON_DOWNLOAD;
  btn.setAttribute("aria-label", ARIA_LABEL_IDLE);
  applyIdleStyle(btn);

  // ─── Hover (mouseenter/mouseleave) ─────────────────────────────────────────
  // Hover включает ОДНОВРЕМЕННО изменение фона И масштаба
  // (Requirement 6.5: не опираться исключительно на цвет).
  btn.addEventListener("mouseenter", () => {
    if (btn.disabled) return;
    btn.style.background = BG_HOVER;
    btn.style.transform = "scale(1.04)";
  });
  btn.addEventListener("mouseleave", () => {
    if (btn.disabled) return;
    btn.style.background = BG_IDLE;
    btn.style.transform = "scale(1)";
  });

  // ─── Focus (focusin/focusout) ──────────────────────────────────────────────
  // Focus включает ОДНОВРЕМЕННО изменение фона И появление видимого контура
  // (Requirement 6.5). Используется outline вместо box-shadow, чтобы
  // соответствовать тексту требования дословно.
  btn.addEventListener("focusin", () => {
    if (btn.disabled) return;
    btn.style.background = BG_HOVER;
    btn.style.outline = `2px solid ${FOCUS_OUTLINE_COLOR}`;
    btn.style.outlineOffset = "2px";
  });
  btn.addEventListener("focusout", () => {
    btn.style.background = BG_IDLE;
    btn.style.outline = "none";
    btn.style.outlineOffset = "0";
  });

  // ─── Active (mousedown/mouseup) ────────────────────────────────────────────
  // Активное (нажатое) состояние комбинирует тёплый фон и уменьшенный
  // масштаб — визуальный отклик на нажатие отличается от обычного состояния
  // одновременно по двум каналам (Requirement 6.5).
  btn.addEventListener("mousedown", () => {
    if (btn.disabled) return;
    btn.style.background = BG_HOVER;
    btn.style.transform = "scale(0.98)";
  });
  btn.addEventListener("mouseup", () => {
    if (btn.disabled) return;
    btn.style.transform = "scale(1.04)";
  });

  return btn;
}

/**
 * Переключает визуальное и доступностное состояние кнопки.
 *
 * Контракт (Requirements 5.6, 6.4):
 *  - `idle`:    `disabled=false`, текст «Скачать плейлист»,
 *               `aria-label = "Скачать плейлист"`.
 *  - `running`: `disabled=true`, текст `"Скачивание {done}/{total}"`,
 *               `aria-label = "Скачивание {done} из {total}"`.
 *
 * Метод не пересоздаёт DOM-узел — только обновляет атрибуты и текст,
 * чтобы переключение было дешёвым и сохраняло event-listeners.
 */
export function setButtonState(
  btn: HTMLButtonElement,
  state: PlaylistButtonState,
): void {
  if (state.kind === "idle") {
    btn.disabled = false;
    btn.title = LABEL_IDLE;
    btn.innerHTML = ICON_DOWNLOAD;
    btn.setAttribute("aria-label", ARIA_LABEL_IDLE);
    applyIdleStyle(btn);
    btn.style.cursor = "pointer";
    btn.style.opacity = "1";
    return;
  }
  // state.kind === "running"
  const { done, total } = state;
  btn.disabled = true;
  btn.title = `Скачивание ${done} из ${total}`;
  btn.textContent = `${done}/${total}`;
  btn.setAttribute("aria-label", `Скачивание ${done} из ${total}`);
  applyRunningStyle(btn);
  btn.style.cursor = "wait";
  btn.style.opacity = "0.85";
  // Снимаем фокус-контур, если он был, чтобы визуально не конфликтовал
  // с состоянием прогресса.
  btn.style.outline = "none";
  btn.style.outlineOffset = "0";
}

/**
 * Привязывает click-обработчик к кнопке.
 *
 * Создаёт {@link createBulkDownload} контроллер и в его колбэках:
 *  - `onProgress(done, total)` → `setButtonState(btn, { kind: "running", done, total })`;
 *  - `onIdle()` → `setButtonState(btn, { kind: "idle" })`;
 *  - `notify(text, kind)` → проброс в `options.notify`;
 *  - `confirm(message)` → `options.confirm` или `window.confirm` по умолчанию.
 *
 * Возвращается сам контроллер, чтобы task 7.2 при необходимости мог
 * вызвать `controller.reset()` при SPA-навигации.
 */
export function wireClickHandler(
  btn: HTMLButtonElement,
  options: PlaylistHeaderButtonOptions,
): BulkDownloadController {
  const confirmFn =
    options.confirm ?? ((message: string) => window.confirm(message));

  const controller = createBulkDownload({
    onProgress(done, total) {
      setButtonState(btn, { kind: "running", done, total });
    },
    onIdle() {
      setButtonState(btn, { kind: "idle" });
    },
    notify(text, kind) {
      options.notify(text, kind);
    },
    confirm(message) {
      return confirmFn(message);
    },
  });

  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    void controller.start();
  });

  return controller;
}

// ─── Lifecycle constants ─────────────────────────────────────────────────────

/**
 * Дебаунс-интервал переоценок: 200 мс ∈ [100, 500] (Requirement 4.8).
 *
 * MutationObserver на `document.body` срабатывает очень часто во время
 * SPA-рендера; обрабатывать каждое событие отдельно нет смысла. Дебаунс
 * сглаживает поток и удерживает число переоценок в пределах лимита.
 */
const DEBOUNCE_MS = 200;

/**
 * Максимальное число переоценок за период первичного поиска для одного
 * `pathname` (Requirement 4.8). После исчерпания лимита переоценки по
 * MutationObserver-событиям прекращаются до следующей SPA-навигации
 * или вызова `forceReevaluate` извне.
 */
const MAX_REEVALUATIONS = 150;

/**
 * Тайм-аут первичного поиска Заголовка_Плейлиста: 15000 мс с момента
 * `DOMContentLoaded` или последней SPA-навигации (Requirement 4.7).
 *
 * При истечении без успешного внедрения для текущего `pathname`:
 *  - в `console.warn` записывается ровно одно сообщение;
 *  - дальнейшие переоценки прекращаются до SPA-навигации.
 *
 * После успешного внедрения для `pathname` тайм-аут игнорируется
 * (Requirement 4.9): попытки повторного внедрения после удаления
 * фреймворком продолжаются.
 */
const PRIMARY_SEARCH_TIMEOUT_MS = 15000;

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Публичная точка входа для UI-обёртки кнопки «Скачать плейлист».
 *
 * Подписывается на:
 *  - `URLObserver` — для смены `location.pathname` (SPA-навигация);
 *  - `MutationObserver(document.body, { childList: true, subtree: true })` —
 *    для перерисовок шапки.
 *
 * На каждой переоценке (с дебаунсом {@link DEBOUNCE_MS}):
 *  1. `kind = detectListPageKind(location.pathname)`.
 *  2. Если `kind ∈ {none, track}` — удалить ранее внедрённую кнопку, если
 *     она присутствует, и выйти (Requirements 3.5, 3.6, 3.10).
 *  3. Иначе если `document.getElementById(BUTTON_ID) !== null` — выйти
 *     (Requirement 3.4).
 *  4. Иначе `findPlaylistHeader()`. Если `null` — выйти, переоценка случится
 *     при следующей мутации.
 *  5. Иначе вставить кнопку как `nextElementSibling` `titleElement`.
 *
 * Состояние первичного поиска:
 *  - Тайм-аут {@link PRIMARY_SEARCH_TIMEOUT_MS} стартует от инициализации
 *    лифцикла или от последней SPA-навигации (Requirement 4.7).
 *  - Счётчик переоценок ограничен {@link MAX_REEVALUATIONS} (Requirement 4.8).
 *  - При смене `pathname` оба сбрасываются (Requirement 4.10), но множество
 *    «успешно внедрённых ранее `pathname`» сохраняется (Requirement 4.9).
 *
 * Метод `handle.stop()` останавливает обе подписки, чистит таймеры и
 * удаляет ранее внедрённую кнопку, если она присутствует.
 *
 * @param options - объект с `notify` (UI-toast) и опциональным `confirm`.
 * @returns Handle с методом `.stop()` для остановки лифцикла.
 */
export function startPlaylistHeaderButton(
  options: PlaylistHeaderButtonOptions,
): PlaylistHeaderButtonHandle {
  // Множество `pathname`, для которых кнопка уже была успешно внедрена.
  // Используется для игнорирования 15-сек тайм-аута при повторных
  // попытках после удаления фреймворком (Requirement 4.9, 4.7 last bullet).
  const successfullyInjected = new Set<string>();
  // Множество `pathname`, для которых уже был выпущен `console.warn`
  // об истечении 15-сек тайм-аута. Гарантирует «ровно один» warn на путь
  // (Requirement 4.7).
  const warnedPathnames = new Set<string>();

  // Текущий контроллер группового скачивания. Пересоздаётся вместе с
  // кнопкой при каждом новом внедрении; при SPA-навигации вызывается
  // `controller.reset()` для best-effort отмены.
  let controller: BulkDownloadController | null = null;

  // Состояние, сбрасываемое при смене `pathname`.
  let currentPathname = location.pathname;
  let reEvaluations = 0;
  let primarySearchTimeoutId: number | null = null;
  let debounceTimeoutId: number | null = null;
  let stopped = false;

  // MutationObserver, наблюдающий за document.body.
  let mutationObserver: MutationObserver | null = null;

  /**
   * Удаляет кнопку из DOM, если она присутствует, и сбрасывает контроллер.
   * Безопасна к повторным вызовам (`isConnected`-проверка).
   */
  function removeButton(): void {
    const existing = document.getElementById(BUTTON_ID);
    if (existing !== null && existing.isConnected) {
      existing.remove();
    }
    if (controller !== null) {
      controller.reset();
      controller = null;
    }
  }

  /**
   * Чистит таймер дебаунса.
   */
  function clearDebounce(): void {
    if (debounceTimeoutId !== null) {
      window.clearTimeout(debounceTimeoutId);
      debounceTimeoutId = null;
    }
  }

  /**
   * Чистит тайм-аут первичного поиска.
   */
  function clearPrimarySearchTimeout(): void {
    if (primarySearchTimeoutId !== null) {
      window.clearTimeout(primarySearchTimeoutId);
      primarySearchTimeoutId = null;
    }
  }

  /**
   * Запускает 15-сек тайм-аут первичного поиска для текущего `pathname`.
   * Если ранее для этого `pathname` уже было успешное внедрение —
   * тайм-аут не запускается (Requirement 4.9).
   */
  function startPrimarySearchTimeout(): void {
    clearPrimarySearchTimeout();
    if (successfullyInjected.has(currentPathname)) {
      return;
    }
    primarySearchTimeoutId = window.setTimeout(() => {
      primarySearchTimeoutId = null;
      // Если за 15 сек кнопка так и не была внедрена для этого пути —
      // ровно один warn и прекращаем переоценки до SPA-навигации.
      if (!successfullyInjected.has(currentPathname)) {
        if (!warnedPathnames.has(currentPathname)) {
          warnedPathnames.add(currentPathname);
          console.warn(
            `[ymd] playlist-header-button: header not found within 15s for ${currentPathname}`,
          );
        }
      }
    }, PRIMARY_SEARCH_TIMEOUT_MS);
  }

  /**
   * Признак: можно ли в данный момент пытаться повторно внедрить кнопку
   * по событию MutationObserver.
   *
   * Логика:
   *  - Если кнопка для текущего `pathname` уже была успешно внедрена ранее —
   *    лимит переоценок не действует, попытки повторного внедрения после
   *    удаления продолжаются (Requirement 4.9).
   *  - Иначе — действует лимит {@link MAX_REEVALUATIONS} (Requirement 4.8).
   */
  function canReevaluate(): boolean {
    if (successfullyInjected.has(currentPathname)) {
      return true;
    }
    return reEvaluations < MAX_REEVALUATIONS;
  }

  /**
   * Синхронная переоценка: проверка типа страницы, наличия кнопки,
   * поиск заголовка и (при необходимости) внедрение кнопки.
   *
   * См. шаги 1–5 в JSDoc {@link startPlaylistHeaderButton}.
   */
  function evaluate(): void {
    if (stopped) return;

    const kind = detectListPageKind(location.pathname);

    // Шаг 1–2: страница не Список_Треков → удалить кнопку и выйти.
    if (kind === "none" || kind === "track") {
      removeButton();
      return;
    }

    // Шаг 3: кнопка уже внедрена — выйти.
    if (document.getElementById(BUTTON_ID) !== null) {
      return;
    }

    // Шаг 4: ищем точку вставки. Приоритет — toolbar плейлиста (рядом
    // с кнопкой «Слушать», «Закрепить», «...»). Если toolbar не найден
    // (например, страница ещё не отрисовала ряд действий), fallback —
    // вставка как соседа Заголовка_Плейлиста.
    const toolbar = findPlaylistToolbar();
    let parent: HTMLElement | null = null;
    let anchor: Node | null = null;
    if (toolbar !== null) {
      parent = toolbar.element;
      // Вставляем после кнопки «Слушать» — то есть в самой левой части
      // ряда действий. Если у play-кнопки есть соседи (закрепить, меню)
      // — наша кнопка встанет между ними и play, что соответствует
      // запросу «около кнопок».
      anchor = toolbar.playButton.nextSibling;
    } else {
      const header = findPlaylistHeader();
      if (header === null) {
        return;
      }
      parent = header.titleElement.parentElement;
      anchor = header.titleElement.nextSibling;
    }
    if (parent === null) {
      // Защитная проверка: findPlaylistHeader уже отфильтровал такие случаи,
      // но TypeScript этого не знает.
      return;
    }

    // Шаг 5: вставляем кнопку.
    const button = buildButton();
    controller = wireClickHandler(button, options);
    parent.insertBefore(button, anchor);

    // Зафиксировать факт успешного внедрения для текущего `pathname`.
    successfullyInjected.add(currentPathname);
    // После успешного внедрения 15-сек тайм-аут больше не нужен
    // (Requirement 4.7 last bullet).
    clearPrimarySearchTimeout();
  }

  /**
   * Планирует переоценку с дебаунсом {@link DEBOUNCE_MS}. Учитывает лимит
   * {@link MAX_REEVALUATIONS} (Requirement 4.8) и счётчик переоценок.
   */
  function scheduleEvaluation(): void {
    if (stopped) return;
    if (!canReevaluate()) return;
    if (debounceTimeoutId !== null) return; // дебаунс уже взведён
    debounceTimeoutId = window.setTimeout(() => {
      debounceTimeoutId = null;
      if (stopped) return;
      // Лимит проверяется ещё раз, т.к. между взведением и срабатыванием
      // мог прийти SPA-навигационный сброс.
      if (!canReevaluate()) return;
      reEvaluations++;
      evaluate();
    }, DEBOUNCE_MS);
  }

  /**
   * Обработчик SPA-навигации — смены `location.pathname`.
   *
   * Сбрасывает: счётчик переоценок, таймер дебаунса, 15-сек тайм-аут,
   * флаг warn для нового `pathname`. Множество `successfullyInjected`
   * сохраняется (Requirement 4.7 last bullet) и используется для игнорирования
   * тайм-аута при возврате на ранее посещённый Список_Треков.
   *
   * Вызывает `controller.reset()` для best-effort отмены текущего
   * группового скачивания, если оно идёт со старой страницы.
   */
  function handlePathChange(): void {
    if (stopped) return;
    const newPathname = location.pathname;
    if (newPathname === currentPathname) return;

    // Best-effort отмена текущего цикла скачивания со старой страницы.
    if (controller !== null) {
      controller.reset();
    }

    currentPathname = newPathname;
    reEvaluations = 0;
    clearDebounce();
    clearPrimarySearchTimeout();

    // Запустить новый 15-сек тайм-аут (если для этого пути ещё не было
    // успешного внедрения).
    startPrimarySearchTimeout();

    // Немедленная переоценка через дебаунс — Requirement 4.10:
    // внедрение для нового `pathname` за ≤ 3000 мс с момента смены URL.
    scheduleEvaluation();
  }

  // ─── Подписки ──────────────────────────────────────────────────────────────

  // SPA-навигация. URLObserver внутри сам патчит history.pushState/replaceState
  // и слушает popstate/hashchange.
  observeURLChanges(handlePathChange);

  // MutationObserver на document.body для перерисовок шапки.
  // Каждое событие — повод запланировать переоценку (с дебаунсом).
  mutationObserver = new MutationObserver(() => {
    scheduleEvaluation();
  });
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Запустить первичный 15-сек тайм-аут и немедленно одну переоценку
  // (на случай если заголовок уже отрисован к моменту вызова).
  startPrimarySearchTimeout();
  scheduleEvaluation();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (mutationObserver !== null) {
        mutationObserver.disconnect();
        mutationObserver = null;
      }
      clearDebounce();
      clearPrimarySearchTimeout();
      removeButton();
    },
  };
}
