// Кнопка скачивания текущего трека.
//
// Стратегия размещения (как у playlist-header-button):
//   1. Приоритет — встроить кнопку в плеер-бар Яндекс Музыки СЛЕВА от
//      кнопки «Текст песни» (обычный плеер), компактным иконочным видом
//      32×32. Если кнопки текста нет (режим «Моя Волна») — кнопка ставится
//      рядом с регулятором громкости.
//   2. Fallback — `position: fixed` в правом нижнем углу со сдвигом
//      левее регулятора громкости, если плеер-бар ещё не отрисован.
//
// Жизненный цикл — на той же архитектуре, что у `playlist-header-button`:
// MutationObserver на `document.body` + дебаунс + переинъекция при
// удалении React-фреймворком + URLObserver на SPA-навигацию.
//
// Состояния идентичны Track_Button из `track-row-injector.ts`:
//   - idle    — жёлтая иконка стрелки вниз;
//   - loading — спиннер;
//   - success — зелёный фон + белая галочка (1500–2000 мс);
//   - error   — красный фон + белая иконка (1500 мс).

import { observeURLChanges } from "./url-observer";
import { observePlayerContainer } from "./player-observer";
import {
  startProgressRing,
  clearProgressRing,
  type ProgressRingHandle,
} from "./progress-ring";

const BUTTON_ID = "ymd-floating-btn";
const TOAST_ID = "ymd-floating-toast";
const STATE_ATTR = "data-ymd-state";
/** Маркер, показывающий что кнопка встроена в плеер-бар (а не fixed). */
const EMBEDDED_ATTR = "data-ymd-embedded";

export type FloatingButtonState = "idle" | "loading" | "success" | "error";

export interface FloatingButton {
  setState: (state: FloatingButtonState, label?: string) => void;
  showToast: (text: string, kind: "success" | "error" | "info") => void;
  /** Underlying DOM element. Exposed so the caller can drive a real
   *  progress ring on it (see `setProgressRingPct`). */
  getElement: () => HTMLButtonElement | null;
}

// ─── Иконки и таблица состояний ──────────────────────────────────────────────

const ICON_DOWNLOAD = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
const ICON_LOADING = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="animation: ymd-spin 1s linear infinite;" aria-hidden="true"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>`;
const ICON_CHECK_WHITE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
const ICON_ERROR_WHITE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

interface FloatingStateAttrs {
  ariaLabel: string;
  background: string;
  iconColor: string;
  icon: string;
}

/**
 * Таблица атрибутов состояний — единый источник правды для визуального
 * представления кнопки. Содержит фон, цвет иконки, aria-label и саму
 * SVG-иконку.
 */
const STATE_ATTRS: Record<FloatingButtonState, FloatingStateAttrs> = {
  idle: {
    ariaLabel: "Скачать трек",
    background: "#ffff00",
    iconColor: "#1d1d1f",
    icon: ICON_DOWNLOAD,
  },
  loading: {
    ariaLabel: "Скачивание трека",
    background: "rgba(255, 255, 0, 0.08)",
    iconColor: "#ffff00",
    // No spinner — the conic progress ring around the icon (see
    // ./progress-ring.ts) provides the loading affordance instead.
    icon: ICON_DOWNLOAD,
  },
  success: {
    ariaLabel: "Трек скачан",
    background: "#34c759",
    iconColor: "#ffffff",
    icon: ICON_CHECK_WHITE,
  },
  error: {
    ariaLabel: "Ошибка скачивания",
    background: "#ff453a",
    iconColor: "#ffffff",
    icon: ICON_ERROR_WHITE,
  },
};

const SUCCESS_DURATION_MS = 1700;
const ERROR_DURATION_MS = 1500;

/**
 * Запланированные таймеры возврата кнопки в idle. Ключ — DOM-узел кнопки;
 * значение — handle setTimeout. При новом вызове setButtonState либо при
 * пересоздании кнопки предыдущий таймер очищается через clearTimeout.
 */
const buttonTimers = new WeakMap<HTMLButtonElement, number>();

function ensureKeyframes(): void {
  if (document.getElementById("ymd-keyframes") !== null) return;
  const style = document.createElement("style");
  style.id = "ymd-keyframes";
  style.textContent = `
    @keyframes ymd-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);
}

// ─── Стили ───────────────────────────────────────────────────────────────────

/**
 * Стиль для embedded режима — кнопка в плеер-баре. Компактная круглая
 * 32×32 рядом с регулятором громкости. Принудительно `pointer-events: auto`
 * и высокий z-index, чтобы клик гарантированно достигал нашего обработчика
 * (Яндекс Музыка иногда перекрывает зону баром-делегатом).
 */
function applyEmbeddedStyle(btn: HTMLButtonElement): void {
  btn.style.cssText = [
    "position: relative",
    "z-index: 10",
    "padding: 0",
    "width: 32px",
    "height: 32px",
    "min-width: 32px",
    "margin: 0 6px",
    "background: #ffff00",
    "color: #1d1d1f",
    "border: none",
    "border-radius: 50%",
    "cursor: pointer",
    "pointer-events: auto",
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    "transition: transform 0.12s, background 0.15s",
    "user-select: none",
    "display: inline-flex",
    "align-items: center",
    "justify-content: center",
    "vertical-align: middle",
    "flex-shrink: 0",
    "box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18)",
  ].join("; ");
}

/**
 * Стиль для floating (fixed) режима — fallback, когда плеер-бар не найден.
 * Сдвинут левее, чтобы НЕ накрывать регулятор громкости.
 */
function applyFloatingStyle(btn: HTMLButtonElement): void {
  btn.style.cssText = [
    "position: fixed",
    "bottom: 110px",
    "right: 220px",
    "z-index: 2147483647",
    "padding: 0",
    "width: 36px",
    "height: 36px",
    "min-width: 36px",
    "background: #ffff00",
    "color: #1d1d1f",
    "border: none",
    "border-radius: 50%",
    "cursor: pointer",
    "pointer-events: auto",
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    "box-shadow: 0 2px 6px rgba(0, 0, 0, 0.22)",
    "transition: transform 0.12s, background 0.15s",
    "user-select: none",
    "display: flex",
    "align-items: center",
    "justify-content: center",
  ].join("; ");
}

// ─── Построение и состояние ──────────────────────────────────────────────────

function ensureIconSpan(btn: HTMLButtonElement): HTMLSpanElement {
  let span = btn.querySelector("span.ymd-icon") as HTMLSpanElement | null;
  if (span === null) {
    span = document.createElement("span");
    span.className = "ymd-icon";
    span.style.display = "inline-flex";
    span.style.alignItems = "center";
    span.style.justifyContent = "center";
    btn.appendChild(span);
  }
  return span;
}

/**
 * Применить визуальное состояние к кнопке: фон, цвет иконки, иконку,
 * aria-label, data-ymd-state. Не планирует таймер возврата в idle.
 */
function applyState(btn: HTMLButtonElement, state: FloatingButtonState): void {
  const attrs = STATE_ATTRS[state];
  btn.dataset.state = state;
  btn.setAttribute(STATE_ATTR, state);
  btn.setAttribute("aria-label", attrs.ariaLabel);
  btn.title = attrs.ariaLabel;
  btn.style.background = attrs.background;
  btn.style.color = attrs.iconColor;

  const span = ensureIconSpan(btn);
  span.style.color = attrs.iconColor;
  span.innerHTML = attrs.icon;
}

function clearPendingTimer(btn: HTMLButtonElement): void {
  const handle = buttonTimers.get(btn);
  if (handle !== undefined) {
    window.clearTimeout(handle);
    buttonTimers.delete(btn);
  }
}

/**
 * Меняет состояние кнопки. Для loading/success/error планируется таймер
 * автоматического возврата в idle (как у track-row кнопки).
 */
/** Per-floating-button ring controller. We only ever have one floating
 * button live, but a WeakMap keeps the cleanup symmetric with track-row. */
const ringHandles = new WeakMap<HTMLButtonElement, ProgressRingHandle>();

function setButtonState(
  btn: HTMLButtonElement,
  state: FloatingButtonState,
  _label?: string,
): void {
  clearPendingTimer(btn);

  if (state === "idle") {
    const prev = ringHandles.get(btn);
    if (prev !== undefined) {
      prev.abort();
      ringHandles.delete(btn);
    }
    clearProgressRing(btn);
    btn.disabled = false;
    applyState(btn, "idle");
    btn.style.cursor = "pointer";
    btn.style.opacity = "1";
    return;
  }

  if (state === "loading") {
    btn.disabled = true;
    applyState(btn, "loading");
    btn.style.cursor = "wait";
    btn.style.opacity = "0.95";
    // Replace the legacy spinner with a conic progress ring sweeping
    // pseudo-progress until the real success/error response arrives.
    const prev = ringHandles.get(btn);
    if (prev !== undefined) prev.abort();
    ringHandles.set(btn, startProgressRing(btn));
    return;
  }

  if (state === "success") {
    const handle = ringHandles.get(btn);
    if (handle !== undefined) {
      handle.complete();
      ringHandles.delete(btn);
    }
    btn.disabled = false;
    applyState(btn, "success");
    btn.style.cursor = "pointer";
    btn.style.opacity = "1";
    const timerHandle = window.setTimeout(() => {
      buttonTimers.delete(btn);
      if (!btn.isConnected) return;
      clearProgressRing(btn);
      applyState(btn, "idle");
      btn.style.cursor = "pointer";
      btn.style.opacity = "1";
      btn.disabled = false;
    }, SUCCESS_DURATION_MS);
    buttonTimers.set(btn, timerHandle);
    return;
  }

  // error
  const handle = ringHandles.get(btn);
  if (handle !== undefined) {
    handle.abort();
    ringHandles.delete(btn);
  }
  clearProgressRing(btn);
  btn.disabled = false;
  applyState(btn, "error");
  btn.style.cursor = "pointer";
  btn.style.opacity = "1";
  const timerHandle = window.setTimeout(() => {
    buttonTimers.delete(btn);
    if (!btn.isConnected) return;
    applyState(btn, "idle");
    btn.style.cursor = "pointer";
    btn.style.opacity = "1";
    btn.disabled = false;
  }, ERROR_DURATION_MS);
  buttonTimers.set(btn, timerHandle);
}

function buildButton(onClick: () => void): HTMLButtonElement {
  ensureKeyframes();
  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.type = "button";
  applyFloatingStyle(btn);
  applyState(btn, "idle");

  // Hover/active эффекты только в idle, чтобы не затирать success/error фон.
  btn.addEventListener("mouseenter", () => {
    if (btn.disabled) return;
    if (btn.dataset.state === "idle") btn.style.background = "#ffff66";
    btn.style.transform = "scale(1.06)";
  });
  btn.addEventListener("mouseleave", () => {
    if (btn.disabled) return;
    if (btn.dataset.state === "idle") btn.style.background = "#ffff00";
    btn.style.transform = "scale(1)";
  });
  btn.addEventListener("mousedown", () => {
    if (btn.disabled) return;
    btn.style.transform = "scale(0.96)";
  });
  btn.addEventListener("mouseup", () => {
    if (btn.disabled) return;
    btn.style.transform = "scale(1.06)";
  });

  // Click — с stopPropagation, чтобы Я.Музыка не перехватила событие
  // через делегатов на родительских контейнерах плеер-бара.
  btn.addEventListener(
    "click",
    (event) => {
      event.stopPropagation();
      if (btn.disabled) return;
      onClick();
    },
    true,
  );

  return btn;
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function ensureToastContainer(): HTMLElement {
  let toast = document.getElementById(TOAST_ID);
  if (toast !== null) return toast;
  toast = document.createElement("div");
  toast.id = TOAST_ID;
  toast.style.cssText = [
    "position: fixed",
    "bottom: 158px",
    "right: 22px",
    "z-index: 2147483647",
    "padding: 8px 12px",
    "background: #1d1d1f",
    "color: #fff",
    "border-radius: 8px",
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    "font-size: 12px",
    "font-weight: 500",
    "max-width: 280px",
    "line-height: 1.4",
    "box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25)",
    "opacity: 0",
    "transform: translateY(6px)",
    "transition: opacity 0.18s, transform 0.18s",
    "pointer-events: none",
  ].join("; ");
  document.body.appendChild(toast);
  return toast;
}

function showToastImpl(text: string, kind: "success" | "error" | "info"): void {
  const toast = ensureToastContainer();
  toast.textContent = text;
  const colors: Record<"success" | "error" | "info", string> = {
    success: "#34c759",
    error: "#ff453a",
    info: "#1d1d1f",
  };
  toast.style.background = colors[kind];
  toast.style.opacity = "1";
  toast.style.transform = "translateY(0)";
  window.setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(6px)";
  }, 4000);
}

// ─── Поиск точки вставки в плеер-баре ───────────────────────────────────────

const VOLUME_BUTTON_HINTS: readonly string[] = [
  "громк",
  "звук",
  "volume",
  "mute",
];

/**
 * Подсказки для поиска кнопки «Текст песни» в правом кластере плеер-бара
 * обычного плеера. В режиме «Моя Волна» этой кнопки нет — тогда происходит
 * откат к размещению рядом с регулятором громкости.
 */
const LYRICS_BUTTON_HINTS: readonly string[] = [
  "текст",
  "lyrics",
];

/** Максимальная ширина кнопки-иконки «Тс». Пункт меню «Показать текст
 *  песни» гораздо шире — так отсекаем его. */
const MAX_LYRICS_BUTTON_WIDTH = 90;

/** Селектор контейнеров выпадающего меню/попапа/диалога. Кнопку текста,
 *  лежащую внутри такого контейнера (пункт «Показать текст песни» в меню
 *  «…» режима «Моя Волна»), использовать нельзя. */
const MENU_CONTAINER_SELECTOR =
  '[role="menu"], [role="menuitem"], [role="dialog"], [role="listbox"], [aria-modal="true"]';

/**
 * Ищет в плеер-баре кнопку «Текст песни» (иконка «Тс» в правом кластере
 * обычного плеера).
 *
 * Чтобы не зацепить посторонние кнопки (переключатель вокала в «Моей Волне»,
 * центральные кнопки воспроизведения, лайк, «…», а также пункт меню
 * «Показать текст песни» внутри «…»), отбор делается строго:
 *   1. по человекочитаемой подсказке `aria-label`/`title` со словами
 *      «текст»/«lyrics» (классы/`data-test-id` Яндекса англоязычны и шумны —
 *      их НЕ используем, иначе в «Моей Волне» ловится ложное совпадение);
 *   2. кнопка должна находиться в ПРАВОЙ части плеер-бара (центр правее 55%
 *      ширины) — там, где находится правый кластер управления;
 *   3. кнопка должна быть компактной иконкой (узкой), а НЕ широким пунктом
 *      выпадающего меню «Показать текст песни»;
 *   4. кнопка не должна лежать внутри меню/попапа/диалога;
 *   5. правее кандидата должна быть ещё хотя бы одна кнопка. Настоящая «Тс»
 *      в обычном плеере не крайняя (за ней очередь/громкость).
 * Возвращается самая левая подходящая кнопка правого кластера — это и есть
 * кнопка текста, слева от которой нужно поставить «Скачать».
 */
function findLyricsButton(playerEl: Element): HTMLElement | null {
  const playerRect = playerEl.getBoundingClientRect();
  if (playerRect.width === 0) return null;
  const rightZoneStart = playerRect.left + playerRect.width * 0.55;

  // Собираем все видимые кнопки бара с их прямоугольниками.
  const visible: Array<{ el: HTMLButtonElement; rect: DOMRect }> = [];
  for (const candidate of Array.from(playerEl.querySelectorAll("button"))) {
    if (!(candidate instanceof HTMLButtonElement)) continue;
    const rect = candidate.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    visible.push({ el: candidate, rect });
  }

  let best: HTMLElement | null = null;
  let bestLeft = Number.POSITIVE_INFINITY;

  for (const { el, rect } of visible) {
    const center = rect.left + rect.width / 2;
    if (center < rightZoneStart) continue; // только правый кластер

    // Только компактная иконка-кнопка, не широкий пункт меню.
    if (rect.width > MAX_LYRICS_BUTTON_WIDTH) continue;

    // Не из выпадающего меню/попапа (пункт «Показать текст песни» в «…»).
    if (el.closest(MENU_CONTAINER_SELECTOR) !== null) continue;

    const label = (
      el.getAttribute("aria-label") ??
      el.getAttribute("title") ??
      ""
    ).toLowerCase();
    if (label.length === 0) continue;
    if (!LYRICS_BUTTON_HINTS.some((hint) => label.includes(hint))) continue;

    // Кандидат не должен быть крайним правым (за «Тс» всегда идут другие
    // кнопки; крайняя правая в «Моей Волне» — это «…»).
    const hasButtonToRight = visible.some(
      (other) => other.el !== el && other.rect.left > rect.right - 4,
    );
    if (!hasButtonToRight) continue;

    if (rect.left < bestLeft) {
      bestLeft = rect.left;
      best = el;
    }
  }
  return best;
}

/**
 * Ищет в плеер-баре кнопку регулировки звука/громкости. Возвращает
 * первую видимую `<button>` с подходящим `aria-label`/`title`/иконкой.
 */
function findVolumeButton(playerEl: Element): HTMLElement | null {
  const buttons = playerEl.querySelectorAll("button");
  for (const candidate of Array.from(buttons)) {
    if (!(candidate instanceof HTMLButtonElement)) continue;
    const rect = candidate.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    // Пропускаем пункты выпадающего меню (например «Настройки звука» в «…»).
    if (candidate.closest(MENU_CONTAINER_SELECTOR) !== null) continue;
    const label = (
      candidate.getAttribute("aria-label") ??
      candidate.getAttribute("title") ??
      ""
    ).toLowerCase();
    if (label.length === 0) continue;
    if (VOLUME_BUTTON_HINTS.some((hint) => label.includes(hint))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Проверяет, является ли элемент слайдером громкости (или его обёрткой):
 * сам слайдер, контейнер со слайдером внутри, `input[type=range]` либо
 * элемент с «слайдерным» классом/aria-label.
 */
function isVolumeSliderEl(el: Element, volumeBtn: Element): boolean {
  if (el === volumeBtn) return false;
  if (el.getAttribute("role") === "slider") return true;
  if (el.querySelector('[role="slider"], input[type="range"]') !== null) {
    return true;
  }
  const label = (el.getAttribute("aria-label") ?? "").toLowerCase();
  if (label.includes("громк") || label.includes("volume")) return true;
  const cls = (el.getAttribute("class") ?? "").toLowerCase();
  if (cls.includes("slider") || cls.includes("volume")) return true;
  return false;
}

/**
 * Определяет, куда вставлять кнопку скачивания относительно регулятора
 * громкости.
 *
 * В режиме «Моя Волна» (и в обычном плеере новой Я.Музыки) кнопка громкости
 * лежит в отдельной обёртке вместе со всплывающим слайдером, который
 * позиционируется ОТНОСИТЕЛЬНО этой обёртки. Если вставить нашу кнопку
 * ВНУТРЬ обёртки, она расширяет её, и popup-слайдер (громкости или скорости)
 * всплывает поверх кнопки скачивания. Поэтому, когда обёртка содержит
 * слайдер, вставляем кнопку ПЕРЕД обёрткой — вне контекста позиционирования
 * попапа. Иначе — прежнее поведение (перед самой кнопкой громкости).
 */
function resolveVolumeInsertion(
  volumeBtn: HTMLElement,
): { container: Element; reference: Element } | null {
  const wrapper = volumeBtn.parentElement;
  if (wrapper === null) return null;

  const wrapperHasSlider = Array.from(wrapper.children).some((child) =>
    isVolumeSliderEl(child, volumeBtn),
  );
  if (wrapperHasSlider && wrapper.parentElement !== null) {
    return { container: wrapper.parentElement, reference: wrapper };
  }
  return { container: wrapper, reference: volumeBtn };
}

// ─── Жизненный цикл ─────────────────────────────────────────────────────────

const DEBOUNCE_MS = 250;
let onClickRef: (() => void) | null = null;
let evaluateScheduled = false;

/**
 * Синхронная переоценка: гарантирует, что кнопка существует и встроена
 * в плеер-бар (с откатом к fixed-режиму, если плеер-бар не найден).
 */
function evaluate(): void {
  if (onClickRef === null) return;

  let btn = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;

  // Если кнопка пропала — пересоздаём как floating; следующая итерация
  // попробует встроить её в плеер-бар.
  if (btn === null) {
    btn = buildButton(onClickRef);
    document.body.appendChild(btn);
  }

  // Пробуем найти плеер-бар и точку вставки.
  const player = findPlayerSync();
  if (player === null) {
    // Плеер ещё не отрисован — оставляем floating-режим.
    return;
  }

  // Приоритет — обычный плеер: вставляем СЛЕВА от кнопки «Текст песни».
  // Если её нет (режим «Моя Волна») — откат к размещению у громкости.
  let insertion: { container: Element; reference: Element } | null = null;
  const lyricsBtn = findLyricsButton(player);
  if (lyricsBtn !== null && lyricsBtn.parentElement !== null) {
    insertion = { container: lyricsBtn.parentElement, reference: lyricsBtn };
  } else {
    const volumeBtn = findVolumeButton(player);
    if (volumeBtn === null) return;
    insertion = resolveVolumeInsertion(volumeBtn);
  }
  if (insertion === null) return;

  // Если кнопка уже стоит ровно на нужном месте — ничего не делаем
  // (избегаем лишних перемещений каждые 3 сек и дёрганья при ховере).
  if (
    btn.getAttribute(EMBEDDED_ATTR) === "1" &&
    btn.isConnected &&
    btn.parentElement === insertion.container &&
    btn.nextElementSibling === insertion.reference
  ) {
    return;
  }

  // Сохраняем текущее состояние, чтобы переинъекция не сбросила его в idle.
  const currentState =
    (btn.dataset.state as FloatingButtonState | undefined) ?? "idle";

  // Снимаем floating-стиль, надеваем embedded-стиль, вставляем рядом с
  // выбранной точкой (слева от кнопки текста либо у регулятора громкости).
  // При смене режима (обычный плеер ⇄ Моя Волна) кнопка переедет на
  // корректную позицию, т.к. insertion пересчитывается каждый раз.
  applyEmbeddedStyle(btn);
  btn.setAttribute(EMBEDDED_ATTR, "1");
  insertion.container.insertBefore(btn, insertion.reference);
  applyState(btn, currentState);
}

const PLAYER_CONTAINER_SELECTORS: readonly string[] = [
  '[class*="PlayerBarDesktop"]',
  '[class*="PlayerBar_root"]',
  '[class*="Player_root"]',
  '[class*="PlayerControls"]',
  '[class*="player-bar"]',
  '[data-test="player-bar"]',
  '[data-test-id*="player"]',
  ".player-controls__track-controls",
  ".player-controls",
  "footer",
];

function findPlayerSync(): Element | null {
  for (const selector of PLAYER_CONTAINER_SELECTORS) {
    try {
      const el = document.querySelector(selector);
      if (el !== null) return el;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function scheduleEvaluation(): void {
  if (evaluateScheduled) return;
  evaluateScheduled = true;
  window.setTimeout(() => {
    evaluateScheduled = false;
    try {
      evaluate();
    } catch (e) {
      console.error("[ymd][floating] evaluate", e);
    }
  }, DEBOUNCE_MS);
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function ensureFloatingButton(onClick: () => void): FloatingButton {
  onClickRef = onClick;

  let btn = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
  if (btn === null) {
    btn = buildButton(onClick);
    document.body.appendChild(btn);
  }

  // Запустить попытку встраивания, как только появится плеер-бар.
  observePlayerContainer(() => {
    scheduleEvaluation();
  });

  return {
    setState: (state, label) => {
      const current = document.getElementById(BUTTON_ID) as
        | HTMLButtonElement
        | null;
      if (current !== null) setButtonState(current, state, label);
    },
    showToast: showToastImpl,
    getElement: () =>
      document.getElementById(BUTTON_ID) as HTMLButtonElement | null,
  };
}

/**
 * Запускает long-running guard:
 *   - MutationObserver на `document.body` — переинъекция при удалении
 *     кнопки React-фреймворком;
 *   - URLObserver — переоценка при SPA-навигации;
 *   - setInterval — safety net на 3 секунды.
 */
export function startFloatingButtonGuard(onClick: () => void): void {
  onClickRef = onClick;

  const observer = new MutationObserver(() => {
    scheduleEvaluation();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  observeURLChanges(() => {
    scheduleEvaluation();
  });

  window.setInterval(() => {
    scheduleEvaluation();
  }, 3000);
}
