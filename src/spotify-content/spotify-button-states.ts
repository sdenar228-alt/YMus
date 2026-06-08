// Per-button DOM state machine для кнопки скачивания на open.spotify.com.
//
// Контракт:
//   - Чистый DOM-модуль: никаких `chrome.*`, никакой работы с сообщениями
//     и storage. Только DOM-классы кнопки + setTimeout-based transitions.
//   - Состояние конкретной кнопки хранится исключительно в её CSS-классах
//     (`ymus-loading` / `ymus-success` / `ymus-error`) и CSS-переменной
//     `--ymus-pct`. Глобального state-контейнера нет — параллельные
//     скачивания живут независимо (R14.3, R14.5).
//   - Стили инжектируются один раз через `injectSpotifyButtonStyles()`;
//     повторные вызовы — no-op.
//   - Структурно стили скопированы из `vk-track-injector.ts`, акцентный
//     цвет заменён на Spotify green `#1ed760` (R15.6).
//
// Допустимые переходы:
//   idle → loading(percent) → success ↘ idle  (R15.1, R15.3)
//   idle → loading(percent) → error  ↘ idle  (R15.1, R15.4)
//
// Для авто-отката `success → idle` (1700 мс) и `error → idle` (1500 мс)
// используется WeakMap-карта таймеров на кнопку, чтобы повторные
// переходы корректно отменяли предыдущий ожидающий откат.

const STYLE_ELEMENT_ID = "ymus-spotify-styles";

const SUCCESS_REVERT_MS = 1700;
const ERROR_REVERT_MS = 1500;

// Карта `button → timeoutId` для отмены ранее запланированных откатов.
// WeakMap позволяет GC собирать запись, когда сама кнопка удалена из DOM
// и больше нигде не удерживается.
const revertTimers: WeakMap<HTMLElement, ReturnType<typeof setTimeout>> = new WeakMap();

const ICON_DOWNLOAD_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">' +
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
  '<polyline points="7 10 12 15 17 10"/>' +
  '<line x1="12" y1="15" x2="12" y2="3"/></svg>';

const ICON_CHECK_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">' +
  '<polyline points="20 6 9 17 4 12"/></svg>';

/**
 * Создаёт пустой `<button>` со стандартной структурой (icon / check / pct)
 * и применённым idle-классом. Экспортируется для использования из
 * `spotify-track-injector.ts` и `spotify-now-playing-injector.ts` —
 * чтобы стиль и DOM-контракт были едины.
 *
 * Возвращённый элемент **не** добавляется в дерево — это задача вызывающего.
 */
export function createSpotifyDownloadButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ymus-spotify-dl-btn";
  btn.setAttribute("aria-label", "Скачать трек");
  btn.title = "Скачать";
  // Три слота, наложенные в один центр: idle-иконка, success-чек,
  // loading-проценты. Видимость переключается классом состояния на самой
  // кнопке — ровно один из трёх детей виден в любой момент.
  btn.innerHTML =
    `<span class="ymus-spotify-dl-icon">${ICON_DOWNLOAD_SVG}</span>` +
    `<span class="ymus-spotify-dl-check">${ICON_CHECK_SVG}</span>` +
    '<span class="ymus-spotify-dl-pct">0%</span>';
  return btn;
}

/**
 * Идемпотентно инжектирует `<style>` со стилями кнопки в `document.head`.
 * Повторные вызовы — no-op. Безопасно вызывать из любого entry-point
 * перед первой инъекцией кнопки (R15.6, R16.2).
 */
export function injectSpotifyButtonStyles(): void {
  // Дедупликация по стабильному id: после soft-reload SPA-страницы
  // расширение может вызвать инъектор повторно — второй <style> нам не нужен.
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) return;

  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
    /* Кнопка скачивания. Размещение задаёт вызывающий код (track-row
     * или now-playing bar): по умолчанию кнопка позиционируется как
     * inline-flex круг 28×28. Структура DOM совпадает с VK-инъекцией:
     * один <button>, внутри три абсолютно спозиционированных span'а
     * (.ymus-spotify-dl-icon, .ymus-spotify-dl-check, .ymus-spotify-dl-pct). */
    .ymus-spotify-dl-btn {
      width: 28px;
      height: 28px;
      min-width: 28px;
      padding: 0;
      margin: 0;
      background: transparent;
      color: #b3b3b3;
      border: none;
      border-radius: 50%;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      position: relative;
      transition: color 0.15s, background 0.15s;
      opacity: 1;
      z-index: 1;
      pointer-events: auto;
      /* Степень заполнения кольца (0..100). Записывается через
       * setDownloadButtonProgress / setButtonLoading. */
      --ymus-pct: 0;
    }
    .ymus-spotify-dl-btn:hover {
      color: #1ed760 !important;
      background: rgba(30, 215, 96, 0.12) !important;
    }
    /* Все три слота лежат в одном центре. Видимость переключается классом
     * состояния на кнопке. Используется visibility (а не display), чтобы
     * исключить возможность каскадного перетекания макета. */
    .ymus-spotify-dl-btn :is(.ymus-spotify-dl-icon, .ymus-spotify-dl-check, .ymus-spotify-dl-pct) {
      position: absolute;
      inset: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      z-index: 1;
      visibility: hidden;
      pointer-events: none;
    }
    /* Idle (нет state-класса): видна только иконка скачивания. */
    .ymus-spotify-dl-btn .ymus-spotify-dl-icon { visibility: visible; }
    /* Loading: процент виден, иконка скрыта. */
    .ymus-spotify-dl-btn.ymus-loading .ymus-spotify-dl-icon { visibility: hidden; }
    .ymus-spotify-dl-btn.ymus-loading .ymus-spotify-dl-pct { visibility: visible; }
    /* В индетерминатном loading скрываем процент и показываем иконку,
     * над которой крутится кольцо ::before (см. ниже). */
    .ymus-spotify-dl-btn.ymus-loading.ymus-indeterminate .ymus-spotify-dl-pct { visibility: hidden; }
    .ymus-spotify-dl-btn.ymus-loading.ymus-indeterminate .ymus-spotify-dl-icon { visibility: visible; }
    /* Success: видна галочка. */
    .ymus-spotify-dl-btn.ymus-success .ymus-spotify-dl-icon { visibility: hidden; }
    .ymus-spotify-dl-btn.ymus-success .ymus-spotify-dl-check { visibility: visible; }
    /* Error: возвращаем идл-иконку, но красим её красным (см. ниже). */
    .ymus-spotify-dl-btn.ymus-error .ymus-spotify-dl-icon { visibility: visible; }
    .ymus-spotify-dl-btn.ymus-error .ymus-spotify-dl-check { visibility: hidden; }
    .ymus-spotify-dl-btn.ymus-error .ymus-spotify-dl-pct { visibility: hidden; }

    .ymus-spotify-dl-pct {
      font-size: 9px;
      font-weight: 700;
      font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1;
      letter-spacing: -0.3px;
      color: inherit;
    }
    /* Кольцо прогресса. Рисуется через conic-gradient, управляемый
     * --ymus-pct. По умолчанию скрыто (opacity: 0); включается при
     * добавлении класса .ymus-loading. Маска вырезает середину, чтобы
     * толщина кольца была ~2.5px и под ним читался процент. */
    .ymus-spotify-dl-btn::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 50%;
      pointer-events: none;
      background: conic-gradient(
        #1ed760 calc(var(--ymus-pct) * 1%),
        rgba(30, 215, 96, 0.18) calc(var(--ymus-pct) * 1%) 100%
      );
      mask: radial-gradient(circle, transparent 11px, #000 12px);
      -webkit-mask: radial-gradient(circle, transparent 11px, #000 12px);
      opacity: 0;
      transition: opacity 0.15s;
    }
    .ymus-spotify-dl-btn.ymus-loading::before {
      opacity: 1;
    }
    /* Индетерминатный loading — четвертная заливка вращается по кругу,
     * чтобы дать пользователю обратную связь, когда CDN не отдал
     * Content-Length и реальный процент посчитать нельзя (R7.6). */
    .ymus-spotify-dl-btn.ymus-loading.ymus-indeterminate::before {
      background: conic-gradient(
        #1ed760 0%,
        #1ed760 25%,
        rgba(30, 215, 96, 0.18) 25% 100%
      );
      animation: ymus-spotify-spin 0.9s linear infinite;
    }
    @keyframes ymus-spotify-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }

    /* Loading state — Spotify-green кольцо и текст. Никакого вращения
     * самой кнопки (детерминатная ветка): проценты должны читаться. */
    .ymus-spotify-dl-btn.ymus-loading {
      opacity: 1 !important;
      color: #1ed760 !important;
      background: rgba(30, 215, 96, 0.10) !important;
    }
    /* Success — зелёная галочка с тем же акцентным цветом Spotify. */
    .ymus-spotify-dl-btn.ymus-success {
      opacity: 1 !important;
      color: #1ed760 !important;
      background: rgba(30, 215, 96, 0.18) !important;
    }
    /* Error — красная иконка скачивания. */
    .ymus-spotify-dl-btn.ymus-error {
      opacity: 1 !important;
      color: #e64646 !important;
      background: rgba(230, 70, 70, 0.12) !important;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Привести кнопку к idle-состоянию: убрать все state-классы и сбросить
 * прогресс. Также отменяет любой запланированный авто-откат, чтобы он
 * не сработал поверх нового состояния.
 */
export function setButtonIdle(btn: HTMLElement): void {
  cancelPendingRevert(btn);
  btn.classList.remove("ymus-loading", "ymus-success", "ymus-error", "ymus-indeterminate");
  btn.style.setProperty("--ymus-pct", "0");
  const label = btn.querySelector<HTMLElement>(".ymus-spotify-dl-pct");
  if (label !== null) label.textContent = "0%";
}

/**
 * Перевести кнопку в состояние loading с заданным процентом (0..100).
 * При `percent === null` показывается индетерминатный спиннер.
 *
 * Любой ожидающий success/error → idle откат отменяется, поскольку
 * новый клик/реквест начинается «с нуля».
 */
export function setButtonLoading(btn: HTMLElement, percent: number | null): void {
  cancelPendingRevert(btn);
  // Снимаем все «терминальные» состояния и фиксируем loading.
  btn.classList.remove("ymus-success", "ymus-error");
  btn.classList.add("ymus-loading");
  applyProgress(btn, percent);
}

/**
 * Перевести кнопку в состояние success на 1700 мс, после чего
 * автоматически вернуть её к idle (R15.3). Повторный вызов сбрасывает
 * предыдущий таймер.
 */
export function setButtonSuccess(btn: HTMLElement): void {
  cancelPendingRevert(btn);
  btn.classList.remove("ymus-loading", "ymus-error", "ymus-indeterminate");
  btn.classList.add("ymus-success");
  // Кольцо прогресса больше не нужно — обнулим, чтобы при следующем
  // loading старт был «с нуля» без видимого мерцания.
  btn.style.setProperty("--ymus-pct", "0");
  scheduleRevert(btn, SUCCESS_REVERT_MS);
}

/**
 * Перевести кнопку в состояние error на 1500 мс, после чего
 * автоматически вернуть её к idle (R15.4). Изменение состояния
 * выполняется независимо от показа toast — вызывающий код может
 * показывать toast параллельно (R15.4, R15.5).
 */
export function setButtonError(btn: HTMLElement): void {
  cancelPendingRevert(btn);
  btn.classList.remove("ymus-loading", "ymus-success", "ymus-indeterminate");
  btn.classList.add("ymus-error");
  btn.style.setProperty("--ymus-pct", "0");
  scheduleRevert(btn, ERROR_REVERT_MS);
}

/**
 * Обновить прогресс на кнопке, **не меняя** её состояния. Если кнопка
 * сейчас не в loading — вызов корректно отрисует значение, но визуально
 * оно проявится только при следующем переходе в loading. Это сделано,
 * чтобы поздние SPOTIFY_DOWNLOAD_PROGRESS-сообщения не «перебивали»
 * уже выставленный success/error (R15.2).
 *
 * `percent === null` — индетерминатный режим (см. `setButtonLoading`).
 * Числовое значение клампится в `[0, 100]`.
 */
export function setDownloadButtonProgress(
  btn: HTMLElement,
  percent: number | null,
): void {
  applyProgress(btn, percent);
}

// ---------- internal helpers ----------

/**
 * Записывает прогресс в `--ymus-pct` и текст метки. При `null`
 * включает класс `.ymus-indeterminate` (вращающееся кольцо без процента).
 * Эта функция намеренно не трогает классы success/error, чтобы
 * progress-сообщения, пришедшие после терминального состояния, не
 * сбрасывали его.
 */
function applyProgress(btn: HTMLElement, percent: number | null): void {
  if (percent === null) {
    btn.classList.add("ymus-indeterminate");
    // Сохраняем условные 25% в переменной, чтобы кольцо имело видимый
    // сегмент даже если CSS-анимация по какой-то причине не сработает.
    btn.style.setProperty("--ymus-pct", "25");
    const label = btn.querySelector<HTMLElement>(".ymus-spotify-dl-pct");
    if (label !== null) label.textContent = "";
    return;
  }
  // Числовой прогресс — детерминатное кольцо, индетерминатный класс снимаем.
  btn.classList.remove("ymus-indeterminate");
  let pct = Math.round(percent);
  if (!Number.isFinite(pct)) pct = 0;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  btn.style.setProperty("--ymus-pct", String(pct));
  const label = btn.querySelector<HTMLElement>(".ymus-spotify-dl-pct");
  if (label !== null) label.textContent = `${pct}%`;
}

/**
 * Отменяет ранее запланированный авто-откат (success/error → idle), если он
 * был. Идемпотентна — допустимо вызывать на кнопке без активного таймера.
 */
function cancelPendingRevert(btn: HTMLElement): void {
  const timer = revertTimers.get(btn);
  if (timer !== undefined) {
    clearTimeout(timer);
    revertTimers.delete(btn);
  }
}

/**
 * Планирует откат кнопки в idle через `delayMs`. Перед планированием
 * отменяет предыдущий таймер этой же кнопки (на случай, если success
 * был быстро перекрыт error или повторным success).
 */
function scheduleRevert(btn: HTMLElement, delayMs: number): void {
  cancelPendingRevert(btn);
  const timer = setTimeout(() => {
    revertTimers.delete(btn);
    // Откат идёт только если кнопка всё ещё в терминальном состоянии.
    // Если за это время её перевели в loading (новый клик), уважаем
    // новое состояние и idle не выставляем.
    if (
      btn.classList.contains("ymus-success") ||
      btn.classList.contains("ymus-error")
    ) {
      btn.classList.remove("ymus-success", "ymus-error", "ymus-indeterminate");
      btn.style.setProperty("--ymus-pct", "0");
      const label = btn.querySelector<HTMLElement>(".ymus-spotify-dl-pct");
      if (label !== null) label.textContent = "0%";
    }
  }, delayMs);
  revertTimers.set(btn, timer);
}
