// Класс ошибки Spotify-пайплайна скачивания одиночных треков в MP3.
//
// Все ошибки, бросаемые модулями Spotify-пайплайна (token capture, metadata,
// storage-resolve, audio-keys, CDN-fetch, AES-decrypt, transcode, downloads),
// представлены экземплярами `SpotifyError`. Оркестратор (`spotify-download-handler`)
// ловит их и преобразует в `{ success: false, errorCode, reason }` ответа
// `SpotifyDownloadResponse` (см. Requirement 22.1, 22.3).
//
// Поле `reason` гарантированно непустая строка: пустые/whitespace-only значения
// блокируются runtime-assert в конструкторе.

import type { SpotifyErrorCode } from "../shared/spotify-types";

export class SpotifyError extends Error {
  public readonly code: SpotifyErrorCode;
  public readonly reason: string;

  constructor(code: SpotifyErrorCode, reason: string) {
    // Runtime-assert: reason должен быть непустой строкой (R22.3).
    // Пустая или whitespace-only причина — программная ошибка вызывающего кода,
    // её нельзя пропустить молча, иначе пользователь получит пустой toast.
    if (typeof reason !== "string" || reason.trim().length === 0) {
      throw new Error(
        `SpotifyError: reason must be a non-empty string (code=${code})`,
      );
    }
    super(`[${code}] ${reason}`);
    this.name = "SpotifyError";
    this.code = code;
    this.reason = reason;
    // Восстанавливаем цепочку прототипов, иначе `instanceof SpotifyError`
    // не работает после транспиляции в ES5-таргет (см. error-classifier.ts).
    Object.setPrototypeOf(this, SpotifyError.prototype);
  }
}
