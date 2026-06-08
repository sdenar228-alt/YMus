// DOM integration for the download button.
//
// Two responsibilities:
//   1. `injectDownloadButton(container)` — создаёт <button class="ym-download-btn">
//      и вставляет его сразу после контейнера плеера.
//   2. `updateButtonUI(button, config)` — синхронизирует визуальное состояние
//      кнопки с переданным `ButtonStateConfig`: текст, disabled, data-state.
//      Для состояния "error" с непустым `errorMessage` рядом отображается
//      <span class="ym-download-error"> с текстом ошибки; для остальных
//      состояний этот span удаляется, если был ранее создан.
//
// Requirements: 3.1, 3.3, 3.4, 7.1

import type { ButtonStateConfig } from "../shared/types";

const BUTTON_INLINE_STYLE = [
  "padding: 6px 12px",
  "margin-left: 8px",
  "background: #ffff00",
  "color: #000",
  "border: none",
  "border-radius: 4px",
  "cursor: pointer",
  "font-size: 13px",
  "font-family: inherit",
].join("; ");

const ERROR_SPAN_INLINE_STYLE = [
  "margin-left: 8px",
  "color: #c00",
  "font-size: 12px",
  "font-family: inherit",
].join("; ");

const ERROR_SPAN_CLASS = "ym-download-error";

/**
 * Создаёт кнопку скачивания и вставляет её сразу после `container`.
 *
 * Возвращает созданный <button>. Не выполняет повторных попыток вставки —
 * это ответственность вызывающей стороны (MutationObserver).
 */
export function injectDownloadButton(container: Element): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "ym-download-btn";
  button.dataset.state = "idle";
  button.textContent = "Скачать";
  button.setAttribute("style", BUTTON_INLINE_STYLE);

  const inserted = container.insertAdjacentElement("afterend", button);
  if (inserted === null) {
    container.parentElement?.appendChild(button);
  }

  return button;
}

/**
 * Синхронизирует визуальное состояние кнопки с переданной конфигурацией.
 *
 * - `textContent` ← `config.label`
 * - `disabled` ← `!config.clickable`
 * - `dataset.state` ← `config.state`
 *
 * Для состояния `"error"` с непустым `errorMessage` рядом с кнопкой
 * создаётся (или обновляется) <span class="ym-download-error"> с текстом
 * ошибки. Для всех остальных состояний этот span удаляется, если он был
 * добавлен ранее.
 */
export function updateButtonUI(
  button: HTMLButtonElement,
  config: ButtonStateConfig,
): void {
  button.textContent = config.label;
  button.disabled = !config.clickable;
  button.dataset.state = config.state;

  const existingErrorSpan = findErrorSpan(button);

  if (config.state === "error" && config.errorMessage) {
    if (existingErrorSpan !== null) {
      existingErrorSpan.textContent = config.errorMessage;
    } else {
      const span = document.createElement("span");
      span.className = ERROR_SPAN_CLASS;
      span.textContent = config.errorMessage;
      span.setAttribute("style", ERROR_SPAN_INLINE_STYLE);
      button.insertAdjacentElement("afterend", span);
    }
    return;
  }

  if (existingErrorSpan !== null) {
    existingErrorSpan.remove();
  }
}

function findErrorSpan(button: HTMLButtonElement): HTMLElement | null {
  const sibling = button.nextElementSibling;
  if (
    sibling instanceof HTMLElement &&
    sibling.classList.contains(ERROR_SPAN_CLASS)
  ) {
    return sibling;
  }
  return null;
}
