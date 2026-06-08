// Чистая функция санитизации имени файла для Spotify-пайплайна.
// Реализует Requirements 12.1–12.5, 17.1–17.3 (см. requirements.md).
//
// Никаких импортов из chrome.* — функция полностью независима от
// инфраструктуры расширения и пригодна для unit- и property-тестирования.

// Запрещённые в файловых системах Windows/macOS/Linux символы
// (Requirement 12.2): \ / : * ? " < > |
// При построении регэкспа экранируем только обязательные метасимволы
// regex-синтаксиса; остальные пишем как есть.
const FORBIDDEN_CHARS_REGEX = /[\\/:*?"<>|]/g;

// Максимальная длина имени файла без расширения ".mp3"
// (Requirement 12.3, Requirement 17.2 — "длина без расширения ≤ 200").
const MAX_NAME_LENGTH = 200;

// Расширение результирующего файла (Requirement 12.1).
const MP3_EXTENSION = ".mp3";

/**
 * Санитизирует одну компоненту имени (artist или title):
 * 1. Заменяет все вхождения запрещённых символов на "_" (Requirement 12.2).
 * 2. Обрезает только крайние пробелы; пробелы в середине строки сохраняются
 *    bit-to-bit (Requirement 12.4).
 *
 * Не подставляет никаких placeholder-значений — пустая строка на выходе
 * означает "после санитизации компонента не осталось ничего полезного";
 * вызывающий код решает, использовать ли fallback `spotify_track_{trackId}`.
 */
function sanitizeComponent(value: string): string {
  // Сначала режем запрещённые символы: после замены могут появиться/исчезнуть
  // только символы "_", остальное содержимое не меняется (Requirement 12.4).
  const replaced = value.replace(FORBIDDEN_CHARS_REGEX, "_");
  // Затем тримим только края — середину строки не трогаем, чтобы сохранить
  // ровно тот порядок разрешённых символов, который пришёл на вход.
  return replaced.trim();
}

/**
 * Формирует безопасное имя файла для скачиваемого трека Spotify.
 *
 * Алгоритм (Requirements 12.1–12.5, 17.1–17.3):
 * 1. Обрабатываем `artist` и `title` через `sanitizeComponent`.
 * 2. Если обе компоненты пустые после санитизации — возвращаем
 *    `spotify_track_{trackId}.mp3` без обрезки `trackId` (Requirement 12.5).
 * 3. Иначе склеиваем шаблоном `"{artist} - {title}"`. Если одна из компонент
 *    пуста — берём непустую без разделителя ` - `, чтобы не оставлять висящих
 *    дефисов в имени файла.
 * 4. Если получившаяся строка длиннее 200 символов — отрезаем хвост
 *    (`slice(0, 200)`). Обрезка всегда идёт с конца, что гарантирует
 *    идемпотентность: повторная санитизация имени, разобранного обратно
 *    на (artist, title), даёт тот же результат (Requirement 17.3).
 * 5. Добавляем расширение `.mp3` (Requirement 12.1).
 *
 * Инварианты выхода:
 * - Не содержит ни одного из символов `\ / : * ? " < > |`
 *   (Requirement 12.2, 17.2).
 * - Заканчивается на `.mp3` (Requirement 12.1, 17.2).
 * - Длина без расширения `.mp3` не превышает 200 символов
 *   (Requirement 12.3, 17.2).
 * - Все символы исходных `artist`/`title`, не входящие в множество запрещённых,
 *   присутствуют в результате в исходном порядке с учётом обрезки
 *   (Requirement 12.4, 17.2).
 *
 * Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 17.1, 17.2, 17.3.
 */
export function sanitizeSpotifyFilename(
  artist: string,
  title: string,
  trackId: string,
): string {
  const sanitizedArtist = sanitizeComponent(artist);
  const sanitizedTitle = sanitizeComponent(title);

  // Requirement 12.5 — обе компоненты пусты после санитизации:
  // возвращаем fallback-имя без обрезки trackId.
  if (sanitizedArtist.length === 0 && sanitizedTitle.length === 0) {
    return `spotify_track_${trackId}${MP3_EXTENSION}`;
  }

  // Склейка по шаблону "{artist} - {title}" (Requirement 12.1).
  // Если ровно одна из компонент пуста — исключаем разделитель ` - `,
  // чтобы не получить висящий дефис в имени файла.
  let baseName: string;
  if (sanitizedArtist.length === 0) {
    baseName = sanitizedTitle;
  } else if (sanitizedTitle.length === 0) {
    baseName = sanitizedArtist;
  } else {
    baseName = `${sanitizedArtist} - ${sanitizedTitle}`;
  }

  // Requirement 12.3, 17.2: обрезаем длину без расширения до 200 символов.
  // Обрезка строго с конца (slice(0, MAX_NAME_LENGTH)) — это даёт
  // идемпотентность Requirement 17.3: parse(out) → re-sanitize даст ту же
  // строку, потому что отрезать нечего, что бы не было уже отрезано.
  const truncated =
    baseName.length > MAX_NAME_LENGTH
      ? baseName.slice(0, MAX_NAME_LENGTH)
      : baseName;

  return `${truncated}${MP3_EXTENSION}`;
}
