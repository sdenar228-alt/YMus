// Button state configuration for the download button.
//
// Maps a `ButtonState` to its UI configuration (`ButtonStateConfig`):
//   - idle: ожидание, кнопка неактивна для нажатия
//   - loading: получение URL в процессе
//   - active: URL получен, можно скачать
//   - error: ошибка, разрешён повтор (clickable)
//   - disabled: трек недоступен (DRM/AUTH), повтор бесполезен
//
// `errorMessage` пробрасывается ТОЛЬКО для состояния "error".
//
// Requirements: 3.1, 3.3, 3.4, 7.1, 7.4

import type { ButtonState, ButtonStateConfig } from "../shared/types";

export function getButtonConfig(
  state: ButtonState,
  errorMessage?: string,
): ButtonStateConfig {
  switch (state) {
    case "idle":
      return { state, label: "Скачать", clickable: false };
    case "loading":
      return { state, label: "Загрузка...", clickable: false };
    case "active":
      return { state, label: "Скачать", clickable: true };
    case "error":
      return { state, label: "Ошибка", clickable: true, errorMessage };
    case "disabled":
      return { state, label: "Недоступно", clickable: false };
  }
}
