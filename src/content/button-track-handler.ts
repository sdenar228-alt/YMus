// Feature: yandex-music-downloader
// Requirements: 3.2, 7.2
//
// Обработчик события смены трека для кнопки скачивания.
// При смене трека кнопка возвращается в состояние "idle",
// а ранее показанное сообщение об ошибке очищается.

import type { ButtonState } from "../shared/types";

/**
 * Сбрасывает состояние кнопки скачивания при смене трека.
 *
 * @param setState Функция, устанавливающая новое состояние кнопки.
 * @param clearError Функция, очищающая текущее сообщение об ошибке.
 */
export function onTrackChanged(
  setState: (s: ButtonState) => void,
  clearError: () => void,
): void {
  setState("idle");
  clearError();
}
