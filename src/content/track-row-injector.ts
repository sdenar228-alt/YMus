// Кнопки скачивания для строк треков, встроенные в DOM как соседи лайка.
//
// Подход:
//   - Находим в строке трека панель действий (там, где живёт лайк).
//   - Создаём <button> с теми же CSS-классами, что у соседних кнопок.
//   - Внутрь кладём SVG-иконку «скачать» (стрелка вниз).
//   - Кнопка появляется СЛЕВА от лайка, выглядит как нативный элемент UI.
//   - Помечаем кнопку атрибутом data-ymd-injected — повторно не вставляем.
//   - При исчезновении строки (виртуализация) кнопка уходит вместе с ней.
//   - MutationObserver + setInterval — пересканируем регулярно.

import {
  startProgressRing,
  clearProgressRing,
  type ProgressRingHandle,
} from "./progress-ring";

const ROW_BIND_ATTR = "data-ymd-bound";
export const INJECTED_ATTR = "data-ymd-injected";
export const STATE_ATTR = "data-ymd-state";

const TRACK_ROW_SELECTORS: readonly string[] = [
  "[class*='Track_root']",
  "[class*='TrackRow']",
  "[class*='trackItem']",
  "[class*='d-track']",
  "[class*='CommonTrack_root']",
  ".d-track",
];

let onClickRef: ((trackId: string, btn: HTMLButtonElement) => void) | null =
  null;
let nextRowId = 0;

const ICON_DOWNLOAD = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
export const ICON_DOWNLOAD_SMALL = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
export const ICON_LOADING_SPINNER = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="animation: ymd-spin 1s linear infinite;"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>`;
export const ICON_CHECK_WHITE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const ICON_ERROR_WHITE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

/**
 * Возможные состояния Track_Button.
 *
 * idle    — исходное состояние: жёлтая кнопка со стрелкой загрузки.
 * loading — переходное состояние во время скачивания: спиннер.
 * success — кнопка после успешного скачивания: зелёный фон + белая галочка.
 * error   — кнопка после неуспешного скачивания: красный фон + белая иконка.
 */
export type TrackButtonState = "idle" | "loading" | "success" | "error";

interface TrackButtonStateAttributes {
  ariaLabel: string;
  background: string;
  iconColor: string;
  ignoreClicks: boolean;
}

/**
 * Таблица атрибутов состояний Track_Button.
 *
 * Источник: дизайн-документ "ui-feedback-improvements", раздел Data Models.
 * Используется в flashOverlayButton/applyState; ariaLabel удовлетворяет
 * Requirement 6.4 (обновление aria-label при смене состояния).
 */
export const TRACK_BUTTON_STATES: Record<
  TrackButtonState,
  TrackButtonStateAttributes
> = {
  idle: {
    ariaLabel: "Скачать трек",
    background: "#ffff00",
    iconColor: "#1d1d1f",
    ignoreClicks: false,
  },
  loading: {
    ariaLabel: "Скачивание трека",
    // Dark transparent backdrop so the yellow conic ring + percent text
    // (drawn by progress-ring.ts) read clearly. Matches VK's loading
    // visual: no fill, just the ring.
    background: "rgba(255, 255, 0, 0.08)",
    iconColor: "#ffff00",
    ignoreClicks: false,
  },
  success: {
    ariaLabel: "Трек скачан",
    background: "#34c759",
    iconColor: "#ffffff",
    ignoreClicks: true,
  },
  error: {
    ariaLabel: "Ошибка скачивания трека",
    background: "#ff453a",
    iconColor: "#ffffff",
    ignoreClicks: false,
  },
};

const SUCCESS_DURATION_MIN_MS = 1500;
const SUCCESS_DURATION_MAX_MS = 2000;
const SUCCESS_DURATION_DEFAULT_MS = 1700;
const LOADING_DURATION_MS = 1000;
const ERROR_DURATION_MS = 1500;

/**
 * Запланированные таймеры возврата кнопки в idle.
 * Ключ — DOM-узел кнопки; значение — handle setTimeout.
 * При новом вызове flashOverlayButton либо при пересоздании кнопки
 * предыдущий таймер очищается через clearTimeout (Requirement 1.9).
 */
const buttonTimers = new WeakMap<HTMLButtonElement, number>();

function extractTrackIdFromRow(row: Element): string | null {
  const albumTrackLink = row.querySelector(
    'a[href*="/album/"][href*="/track/"]',
  );
  if (albumTrackLink !== null) {
    const href =
      (albumTrackLink as HTMLAnchorElement).getAttribute("href") ?? "";
    const m = href.match(/\/album\/(\d+)\/track\/(\d+)/);
    if (m !== null) return m[2];
  }

  const trackLink = row.querySelector('a[href*="/track/"]');
  if (trackLink !== null) {
    const href = (trackLink as HTMLAnchorElement).getAttribute("href") ?? "";
    const m = href.match(/\/track\/(\d+)/);
    if (m !== null) return m[1];
  }

  for (const attr of [
    "data-trackid",
    "data-track-id",
    "data-id",
    "data-test-id",
  ]) {
    const value = row.getAttribute(attr);
    if (value !== null && /^\d+$/.test(value)) return value;
    const child = row.querySelector(`[${attr}]`);
    if (child !== null) {
      const childValue = child.getAttribute(attr) ?? "";
      if (/^\d+$/.test(childValue)) return childValue;
    }
  }

  return null;
}

/**
 * Найти контейнер кнопок справа в строке трека (где живут корзинка, лайк, «...»).
 *
 * Стратегия: ищем все кнопки в строке, фильтруем play (она слева), и
 * берём родителя самой левой из оставшихся — это и есть action-панель.
 */
export function findActionsContainer(row: Element): {
  container: HTMLElement;
  firstChild: Element;
  sampleBtn: HTMLElement;
} | null {
  const allButtons = Array.from(row.querySelectorAll("button"));
  if (allButtons.length === 0) return null;

  // Берём rect трека чтобы понять "левую" и "правую" части.
  const rowRect = row.getBoundingClientRect();
  const rowMid = rowRect.left + rowRect.width / 2;

  // Кнопки правой части (action-панель: лайк, корзинка, «...»).
  const rightButtons = allButtons.filter((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left > rowMid;
  });
  if (rightButtons.length === 0) return null;

  // Сортируем слева-направо.
  rightButtons.sort(
    (a, b) =>
      a.getBoundingClientRect().left - b.getBoundingClientRect().left,
  );

  const sampleBtn = rightButtons[0];
  const parent = sampleBtn.parentElement;
  if (parent === null) return null;

  // Ищем общий контейнер для всех правых кнопок: поднимаемся пока все они
  // не окажутся среди потомков одного предка.
  let container: HTMLElement = parent;
  for (let i = 0; i < 4; i++) {
    const parentEl = container.parentElement;
    if (parentEl === null) break;
    const allInside = rightButtons.every((b) => parentEl.contains(b));
    if (!allInside) break;
    // Проверим что parentEl — flex/inline-flex с >= 2 детьми.
    const cs = window.getComputedStyle(parentEl);
    const isFlex = cs.display === "flex" || cs.display === "inline-flex";
    if (isFlex && parentEl.children.length >= 2) {
      container = parentEl;
      break;
    }
    // Иначе поднимаемся ещё выше.
    container = parentEl;
  }

  // firstChild контейнера — то, перед чем мы встанем.
  const firstChild = container.firstElementChild;
  if (firstChild === null) return null;

  return { container, firstChild, sampleBtn };
}

/**
 * Создаёт жёлтую кнопку скачивания, которая подстраивается по размеру
 * под соседние action-кнопки (лайк, шаринг, «...»), но остаётся жёлтой.
 * Копирует className у соседней кнопки для размера/отступов, но перебивает
 * цвет на #ffff00.
 */
function buildButton(trackId: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("data-ymd-track-id", trackId);
  btn.setAttribute(INJECTED_ATTR, "1");
  btn.setAttribute(STATE_ATTR, "idle");
  btn.setAttribute("aria-label", TRACK_BUTTON_STATES.idle.ariaLabel);
  btn.title = TRACK_BUTTON_STATES.idle.ariaLabel;

  btn.innerHTML = `<span style="display:inline-flex;align-items:center;justify-content:center;color:${TRACK_BUTTON_STATES.idle.iconColor};">${ICON_DOWNLOAD_SMALL}</span>`;

  btn.addEventListener("click", (event) => {
    // Игнорируем клики, когда кнопка в success-состоянии (Requirement 1.8):
    // повторное скачивание не запускается до возврата в idle.
    const currentState = btn.getAttribute(STATE_ATTR);
    if (
      currentState !== null &&
      currentState in TRACK_BUTTON_STATES &&
      TRACK_BUTTON_STATES[currentState as TrackButtonState].ignoreClicks
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const id = btn.getAttribute("data-ymd-track-id");
    if (id !== null && onClickRef !== null) onClickRef(id, btn);
  });

  return btn;
}

function injectIntoRow(row: Element): void {
  if (row.querySelector(`[${INJECTED_ATTR}="1"]`) !== null) return;

  const trackId = extractTrackIdFromRow(row);
  if (trackId === null) return;

  const found = findActionsContainer(row);
  if (found === null) return;

  const { container, firstChild, sampleBtn } = found;
  const btn = buildButton(trackId);

  // Размер фиксированный — компактный, не перекрывает обложку.
  const size = 20;

  btn.style.width = `${size}px`;
  btn.style.height = `${size}px`;
  btn.style.minWidth = `${size}px`;
  btn.style.padding = "0";
  btn.style.background = TRACK_BUTTON_STATES.idle.background;
  btn.style.color = TRACK_BUTTON_STATES.idle.iconColor;
  btn.style.border = "none";
  btn.style.borderRadius = "50%";
  btn.style.cursor = "pointer";
  btn.style.display = "inline-flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "center";
  btn.style.verticalAlign = "middle";
  btn.style.flexShrink = "0";
  btn.style.alignSelf = "center";
  btn.style.marginRight = "8px";
  btn.style.boxShadow = "0 1px 2px rgba(0, 0, 0, 0.2)";
  btn.style.transition = "background 0.12s, transform 0.1s";

  btn.addEventListener("mouseenter", () => {
    // Hover-эффект применяем только в idle, чтобы не затирать
    // зелёный фон success-состояния и красный фон error-состояния.
    if (btn.getAttribute(STATE_ATTR) === "idle") {
      btn.style.background = "#ffff66";
    }
    btn.style.transform = "scale(1.08)";
  });
  btn.addEventListener("mouseleave", () => {
    if (btn.getAttribute(STATE_ATTR) === "idle") {
      btn.style.background = TRACK_BUTTON_STATES.idle.background;
    }
    btn.style.transform = "scale(1)";
  });

  // Вставляем в самое начало панели действий.
  container.insertBefore(btn, firstChild);

  if (row.getAttribute(ROW_BIND_ATTR) === null) {
    row.setAttribute(ROW_BIND_ATTR, `r${nextRowId++}`);
  }
}

function scanAndInject(): void {
  const seen = new Set<Element>();
  for (const selector of TRACK_ROW_SELECTORS) {
    let rows: NodeListOf<Element>;
    try {
      rows = document.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const row of Array.from(rows)) {
      if (seen.has(row)) continue;
      seen.add(row);
      injectIntoRow(row);
    }
  }
}

export function startTrackRowInjector(
  onClick: (trackId: string, btn: HTMLButtonElement) => void,
): void {
  onClickRef = onClick;
  scanAndInject();

  let scanDebounce = 0;
  const observer = new MutationObserver(() => {
    if (scanDebounce !== 0) return;
    scanDebounce = window.setTimeout(() => {
      scanDebounce = 0;
      scanAndInject();
    }, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Safety net: раз в 2 секунды на случай если виртуализация
  // создала новые ряды без срабатывания observer-а.
  window.setInterval(() => scanAndInject(), 2000);
}

/**
 * Возвращает span-обёртку иконки внутри кнопки (создаёт при отсутствии).
 */
function ensureIconSpan(btn: HTMLButtonElement): HTMLSpanElement {
  let span = btn.querySelector("span");
  if (span === null) {
    span = document.createElement("span");
    span.style.display = "inline-flex";
    span.style.alignItems = "center";
    span.style.justifyContent = "center";
    btn.appendChild(span);
  }
  return span as HTMLSpanElement;
}

/**
 * Применить визуальное состояние к кнопке: фон, цвет иконки, иконку,
 * aria-label, data-ymd-state. Не планирует таймер возврата в idle.
 */
function applyState(
  btn: HTMLButtonElement,
  state: TrackButtonState,
  iconHtml: string,
): void {
  const attrs = TRACK_BUTTON_STATES[state];
  btn.setAttribute(STATE_ATTR, state);
  btn.setAttribute("aria-label", attrs.ariaLabel);
  btn.title = attrs.ariaLabel;
  btn.style.background = attrs.background;
  btn.style.color = attrs.iconColor;

  const span = ensureIconSpan(btn);
  span.style.color = attrs.iconColor;
  span.innerHTML = iconHtml;
}

/**
 * Очистить запланированный таймер возврата в idle, если он есть
 * (Requirement 1.9: при пересоздании кнопки или новом вызове
 * flashOverlayButton предыдущий таймер должен быть отменён).
 */
function clearPendingTimer(btn: HTMLButtonElement): void {
  const handle = buttonTimers.get(btn);
  if (handle !== undefined) {
    window.clearTimeout(handle);
    buttonTimers.delete(btn);
  }
}

function clampSuccessDuration(durationMs: number): number {
  if (durationMs < SUCCESS_DURATION_MIN_MS) return SUCCESS_DURATION_MIN_MS;
  if (durationMs > SUCCESS_DURATION_MAX_MS) return SUCCESS_DURATION_MAX_MS;
  return durationMs;
}

/**
 * Временное визуальное состояние кнопки (после клика).
 *
 * loading — спиннер, через ~1 секунду возвращается idle.
 * success — зелёный фон + белая галочка, держится 1500–2000 мс
 *   (по умолчанию 1700), aria-label = "Трек скачан", клики игнорируются.
 *   После истечения интервала кнопка возвращается в idle (Requirement 1.4).
 * error   — красный фон + белая иконка ошибки, держится 1500 мс.
 *
 * Запланированный таймер хранится в WeakMap; при повторном вызове
 * flashOverlayButton предыдущий таймер очищается через clearTimeout.
 * В callback таймера выполняется проверка isConnected — если кнопка
 * удалена из DOM, callback ничего не делает (Requirement 1.9).
 *
 * @param btn        Кнопка скачивания трека.
 * @param state      Желаемое состояние.
 * @param durationMs Желаемая длительность для success-состояния.
 *                   Клампится в [1500, 2000]. Для loading/error игнорируется.
 */
/**
 * Per-button progress-ring controller. Created when loading begins and
 * either `complete()`'d on success or `abort()`'d on error/idle. We keep
 * the controllers on a WeakMap keyed by the button so re-entrant calls
 * don't leak timers.
 */
const ringHandles = new WeakMap<HTMLButtonElement, ProgressRingHandle>();

function flashOverlayButton(
  btn: HTMLButtonElement,
  state: "loading" | "success" | "error",
  durationMs: number = SUCCESS_DURATION_DEFAULT_MS,
): void {
  // Любой новый вызов отменяет ранее запланированный возврат в idle.
  clearPendingTimer(btn);

  if (state === "loading") {
    // Show the download icon (NOT a spinner) and start the conic ring
    // around it. Pseudo-progress sweeps to 90% over ~8 seconds; the real
    // success/error transition below jumps to 100% or hides the ring.
    applyState(btn, "loading", ICON_DOWNLOAD_SMALL);
    const prev = ringHandles.get(btn);
    if (prev !== undefined) prev.abort();
    const handle = startProgressRing(btn);
    ringHandles.set(btn, handle);
    const fallbackTimer = window.setTimeout(() => {
      buttonTimers.delete(btn);
      if (!btn.isConnected) return;
      // По истечении loading-таймера всегда возвращаемся в idle —
      // даже если фактическое скачивание ещё идёт. Если в этот момент
      // придёт success/error, он перебьёт idle новым вызовом.
      const h = ringHandles.get(btn);
      if (h !== undefined) {
        h.abort();
        ringHandles.delete(btn);
      }
      clearProgressRing(btn);
      applyState(btn, "idle", ICON_DOWNLOAD_SMALL);
    }, LOADING_DURATION_MS);
    buttonTimers.set(btn, fallbackTimer);
    return;
  }

  if (state === "success") {
    // Snap the ring to 100%, then swap icon to the green check.
    const handle = ringHandles.get(btn);
    if (handle !== undefined) {
      handle.complete();
      ringHandles.delete(btn);
    }
    applyState(btn, "success", ICON_CHECK_WHITE);
    const successDuration = clampSuccessDuration(durationMs);
    const successTimer = window.setTimeout(() => {
      buttonTimers.delete(btn);
      if (!btn.isConnected) return;
      clearProgressRing(btn);
      applyState(btn, "idle", ICON_DOWNLOAD_SMALL);
    }, successDuration);
    buttonTimers.set(btn, successTimer);
    return;
  }

  // error
  const handle = ringHandles.get(btn);
  if (handle !== undefined) {
    handle.abort();
    ringHandles.delete(btn);
  }
  clearProgressRing(btn);
  applyState(btn, "error", ICON_ERROR_WHITE);
  const errorTimer = window.setTimeout(() => {
    buttonTimers.delete(btn);
    if (!btn.isConnected) return;
    applyState(btn, "idle", ICON_DOWNLOAD_SMALL);
  }, ERROR_DURATION_MS);
  buttonTimers.set(btn, errorTimer);
}

export { flashOverlayButton };
