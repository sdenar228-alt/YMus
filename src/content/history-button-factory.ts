/**
 * Module: history-button-factory
 *
 * Фабрика кнопок скачивания по дате для страницы истории прослушиваний.
 * Создаёт Date_Download_Button с управлением состоянием и визуальной
 * обратной связью.
 *
 * Requirements: 2.2, 2.5, 6.1, 6.2, 6.3, 6.4, 6.5
 */

import { startProgressRing, clearProgressRing, type ProgressRingHandle } from "./progress-ring";

// ─── Types ───────────────────────────────────────────────────────────────────

export type DateButtonState = "idle" | "loading" | "progress" | "success" | "error";

export interface DateButton {
  element: HTMLButtonElement;
  setState(state: DateButtonState, progressText?: string): void;
}

// ─── Visual constants ────────────────────────────────────────────────────────

const BG_IDLE = "#ffff00";
const BG_SUCCESS = "#4caf50";
const BG_ERROR = "#f44336";

const ICON_DOWNLOAD = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

const ICON_CHECK = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

const SUCCESS_TIMEOUT_MS = 2000;
const ERROR_TIMEOUT_MS = 3000;

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Создаёт Date_Download_Button с aria-label, включающим текст даты.
 *
 * Кнопка: жёлтый фон #ffff00, 20px round, download icon.
 * Поддерживает состояния: idle, loading, progress, success, error.
 * В состояниях loading и progress кнопка non-clickable (disabled).
 * После success возврат в idle через 2s, после error — через 3s.
 */
export function createDateButton(dateText: string): DateButton {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ymd-date-download-btn";
  btn.setAttribute("aria-label", `Скачать треки за ${dateText}`);
  btn.innerHTML = ICON_DOWNLOAD;

  applyBaseStyle(btn);
  applyIdleVisuals(btn);

  let resetTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let ringHandle: ProgressRingHandle | null = null;

  function clearResetTimeout(): void {
    if (resetTimeoutId !== null) {
      clearTimeout(resetTimeoutId);
      resetTimeoutId = null;
    }
  }

  function stopRing(): void {
    if (ringHandle !== null) {
      ringHandle.abort();
      ringHandle = null;
    }
    clearProgressRing(btn);
  }

  function setState(state: DateButtonState, progressText?: string): void {
    clearResetTimeout();

    switch (state) {
      case "idle":
        stopRing();
        btn.disabled = false;
        btn.innerHTML = ICON_DOWNLOAD;
        applyIdleVisuals(btn);
        btn.setAttribute("aria-label", `Скачать треки за ${dateText}`);
        break;

      case "loading":
        // Show download icon + conic progress ring (was a CSS spinner).
        // Dark transparent backdrop so the yellow ring + percent text
        // read clearly on top, matching VK's loading visual.
        btn.disabled = true;
        btn.innerHTML = ICON_DOWNLOAD;
        btn.style.background = "rgba(255, 255, 0, 0.08)";
        btn.style.color = "#ffff00";
        btn.style.cursor = "wait";
        btn.setAttribute("aria-label", `Загрузка треков за ${dateText}`);
        if (ringHandle !== null) ringHandle.abort();
        ringHandle = startProgressRing(btn);
        break;

      case "progress":
        // Progress state shows count text instead of an icon. The ring
        // stays active to keep the visual continuity from "loading".
        btn.disabled = true;
        btn.style.background = "rgba(255, 255, 0, 0.08)";
        btn.style.color = "#ffff00";
        btn.style.cursor = "wait";
        if (progressText) {
          btn.textContent = progressText;
          btn.style.width = "auto";
          btn.style.padding = "0 6px";
          btn.style.fontSize = "10px";
          btn.style.fontWeight = "600";
          btn.setAttribute("aria-label", `Скачивание ${progressText} за ${dateText}`);
        }
        if (ringHandle === null) ringHandle = startProgressRing(btn);
        break;

      case "success":
        if (ringHandle !== null) {
          ringHandle.complete();
          ringHandle = null;
        }
        btn.disabled = false;
        btn.innerHTML = ICON_CHECK;
        btn.style.background = BG_SUCCESS;
        btn.style.cursor = "default";
        btn.setAttribute("aria-label", `Скачивание завершено за ${dateText}`);
        resetTimeoutId = setTimeout(() => {
          setState("idle");
        }, SUCCESS_TIMEOUT_MS);
        break;

      case "error":
        stopRing();
        btn.disabled = false;
        btn.style.background = BG_ERROR;
        btn.style.cursor = "default";
        btn.innerHTML = ICON_DOWNLOAD;
        btn.setAttribute("aria-label", `Ошибка скачивания за ${dateText}`);
        resetTimeoutId = setTimeout(() => {
          setState("idle");
        }, ERROR_TIMEOUT_MS);
        break;
    }
  }

  return { element: btn, setState };
}

// ─── Style helpers ───────────────────────────────────────────────────────────

function applyBaseStyle(btn: HTMLButtonElement): void {
  btn.style.cssText = [
    "position: static",
    "display: inline-flex",
    "align-items: center",
    "justify-content: center",
    "margin-left: 8px",
    "padding: 0",
    "width: 20px",
    "height: 20px",
    "min-width: 20px",
    "border: none",
    "border-radius: 50%",
    "vertical-align: middle",
    "user-select: none",
    "outline: none",
    "flex-shrink: 0",
    "transition: background 0.15s, transform 0.12s",
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    "font-size: 10px",
    "line-height: 1",
  ].join("; ");
}

function applyIdleVisuals(btn: HTMLButtonElement): void {
  btn.style.background = BG_IDLE;
  btn.style.cursor = "pointer";
  btn.style.color = "#1d1d1f";
}
