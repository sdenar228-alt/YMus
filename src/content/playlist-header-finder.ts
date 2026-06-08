/**
 * Module: playlist-header-finder
 *
 * Содержит классификатор типа Страницы_Списка_Треков по `location.pathname`.
 * Используется UI-обёрткой `playlist-header-button.ts` для определения,
 * нужно ли вообще внедрять кнопку «Скачать плейлист» на текущей странице.
 *
 * См. design.md → "Property 5: detectListPageKind корректно классифицирует pathname"
 * и Requirements 4.1–4.5.
 */

/**
 * Тип страницы со списком треков, определённый по `location.pathname`.
 *
 * - `album`             — страница альбома `/album/{id}`
 * - `playlist-classic`  — классический плейлист `/users/{owner}/playlists/{kind}`
 * - `playlist-uuid`     — кастомный плейлист `/playlists/{uuid}` (опц. префикс `lk.`)
 * - `likes`             — коллекция «Мне нравится» (`/library/likes` или `…/likes`)
 * - `chart`             — чарт (`/chart` или `/chart/…`)
 * - `track`             — страница отдельного трека `/album/{id}/track/{id}`
 *                        (НЕ Страница_Списка_Треков, кнопка не внедряется)
 * - `none`              — любой другой pathname
 */
export type ListPageKind =
  | "album"
  | "playlist-classic"
  | "playlist-uuid"
  | "likes"
  | "chart"
  | "track"
  | "none";

// ВАЖНО: порядок проверок имеет значение.
// `track` (`/album/{id}/track/{id}`) должен проверяться РАНЬШЕ `album`,
// иначе путь к отдельному треку ошибочно классифицируется как альбом.
const TRACK_RE = /^\/album\/\d+\/track\/\d+\/?$/;
const ALBUM_RE = /^\/album\/\d+\/?$/;
const PLAYLIST_CLASSIC_RE = /^\/users\/[^/]+\/playlists\/\d+\/?$/;
// UUID допускает опциональный префикс `lk.` (используется Яндекс Музыкой
// для пользовательских "избранных" плейлистов с UUID-идентификатором).
const PLAYLIST_UUID_RE = /^\/playlists\/(?:lk\.)?[0-9a-f-]{8,}\/?$/;
const LIBRARY_LIKES_RE = /^\/library\/likes(?:\/.*)?$/;
const ENDS_WITH_LIKES_RE = /\/likes\/?$/;
const CHART_RE = /^\/chart(?:\/.*)?$/;

/**
 * Классифицирует `pathname` (часть URL без схемы, хоста и query/hash)
 * как один из вариантов {@link ListPageKind}.
 *
 * Контракт (см. requirements.md §4.1–4.5 и design.md Property 5):
 * - `^/album/\d+/track/\d+/?$`            → `"track"`
 * - `^/album/\d+/?$`                       → `"album"`
 * - `^/users/[^/]+/playlists/\d+/?$`       → `"playlist-classic"`
 * - `^/playlists/(?:lk\.)?[0-9a-f-]{8,}/?$` → `"playlist-uuid"`
 * - `^/library/likes(?:/.*)?$` или путь, оканчивающийся на `/likes` → `"likes"`
 * - `^/chart(?:/.*)?$`                     → `"chart"`
 * - иначе                                  → `"none"`
 *
 * @param pathname - значение `location.pathname` (например, `"/album/123"`).
 * @returns Тип страницы списка треков.
 */
export function detectListPageKind(pathname: string): ListPageKind {
  if (TRACK_RE.test(pathname)) {
    return "track";
  }
  if (ALBUM_RE.test(pathname)) {
    return "album";
  }
  if (PLAYLIST_CLASSIC_RE.test(pathname)) {
    return "playlist-classic";
  }
  if (PLAYLIST_UUID_RE.test(pathname)) {
    return "playlist-uuid";
  }
  if (LIBRARY_LIKES_RE.test(pathname) || ENDS_WITH_LIKES_RE.test(pathname)) {
    return "likes";
  }
  if (CHART_RE.test(pathname)) {
    return "chart";
  }
  return "none";
}

/**
 * Результат поиска Заголовка_Плейлиста на текущей странице Яндекс Музыки.
 *
 * См. design.md → Components and Interfaces → `playlist-header-finder.ts`
 * и Requirement 4.6.
 */
export interface PlaylistHeaderResult {
  /** Родительский контейнер заголовка — точка вставки кнопки как соседа. */
  element: HTMLElement;
  /** Сам DOM-элемент с текстом заголовка (`h1` или элемент с классом). */
  titleElement: HTMLElement;
  /** CSS-селектор, по которому был найден `titleElement` (для диагностики). */
  matchedSelector: string;
}

/**
 * Упорядоченный список из 8 CSS-селекторов для поиска Заголовка_Плейлиста.
 *
 * Порядок имеет значение (Requirement 4.6): первый селектор, возвращающий
 * хотя бы один видимый элемент с непустым `textContent.trim()`, выигрывает.
 *
 * Список фиксирован и не должен расширяться без обновления requirements.md
 * (там указано «не более 8 селекторов»).
 */
const HEADER_SELECTORS: readonly string[] = [
  "[class*='PageHeaderTitle']",
  "[class*='PlaylistTitle']",
  "[class*='AlbumTitle']",
  "[class*='PlaylistHeader'] h1",
  "[class*='PageHeader'] h1",
  "main h1",
  "header h1",
  "h1",
];

/**
 * Проверяет, что элемент видим в смысле Requirement 4.6:
 * `offsetParent !== null` ИЛИ `getBoundingClientRect().height > 0`.
 *
 * Первое условие отсекает скрытые через `display: none` поддеревья,
 * второе — корректно работает для `position: fixed` и `<body>`,
 * у которых `offsetParent === null` даже при видимости.
 */
function isVisible(element: HTMLElement): boolean {
  if (element.offsetParent !== null) {
    return true;
  }
  return element.getBoundingClientRect().height > 0;
}

/**
 * Результат поиска панели действий плейлиста (toolbar) — горизонтальная
 * группа кнопок «Слушать», «Закрепить», «...» под заголовком.
 */
export interface PlaylistToolbarResult {
  /** Сам контейнер toolbar (родитель кнопок «Слушать» и пр.). */
  element: HTMLElement;
  /** Кнопка «Слушать», по которой был найден контейнер (для диагностики). */
  playButton: HTMLButtonElement;
}

/** Тексты, которые соответствуют главной play-кнопке плейлиста на разных локалях. */
const PLAY_BUTTON_LABELS: readonly string[] = [
  "Слушать",
  "Listen",
  "Play",
  "Воспроизвести",
];

/**
 * Ищет toolbar плейлиста — горизонтальную группу с главной play-кнопкой
 * и сопутствующими действиями (закрепить, меню «...»).
 *
 * Стратегия:
 *  1. Перебрать все `<button>` в документе.
 *  2. Найти первую видимую кнопку, текст которой начинается с одного из
 *     {@link PLAY_BUTTON_LABELS} (поддержка локалей и иконочных кнопок,
 *     где текст хранится в `aria-label`).
 *  3. Подняться к её `parentElement` — это и есть toolbar.
 *
 * Используется UI-обёрткой кнопки «Скачать плейлист» как приоритетная точка
 * вставки рядом с другими действиями. Если toolbar не найден — fallback
 * на {@link findPlaylistHeader}.
 */
export function findPlaylistToolbar(): PlaylistToolbarResult | null {
  const buttons = document.querySelectorAll("button");
  for (const candidate of Array.from(buttons)) {
    if (!(candidate instanceof HTMLButtonElement)) continue;
    if (!isVisible(candidate)) continue;
    const text = (candidate.textContent ?? "").trim();
    const ariaLabel = (candidate.getAttribute("aria-label") ?? "").trim();
    const matchesText = PLAY_BUTTON_LABELS.some((label) =>
      text.startsWith(label),
    );
    const matchesAria = PLAY_BUTTON_LABELS.some((label) =>
      ariaLabel.startsWith(label),
    );
    if (!matchesText && !matchesAria) continue;
    const parent = candidate.parentElement;
    if (parent === null) continue;
    return { element: parent, playButton: candidate };
  }
  return null;
}

/**
 * Ищет Заголовок_Плейлиста в текущем `document` по упорядоченному списку
 * селекторов и возвращает первый видимый элемент с непустым текстом.
 *
 * Контракт (Requirement 4.6 и design Property 6):
 * - Перебирать {@link HEADER_SELECTORS} в порядке объявления.
 * - Для каждого селектора брать первый возвращённый `HTMLElement`,
 *   у которого `(textContent ?? "").trim().length > 0` И элемент видим
 *   (`offsetParent !== null` или `getBoundingClientRect().height > 0`).
 * - Возвращать `{ element: titleElement.parentElement, titleElement, matchedSelector }`.
 * - Если у найденного `titleElement` нет `parentElement` — пропустить
 *   (вставить кнопку как соседа невозможно) и продолжить поиск.
 * - Если ни один селектор не дал подходящий элемент — вернуть `null`.
 *
 * @returns Результат поиска или `null`, если заголовок не обнаружен.
 */
export function findPlaylistHeader(): PlaylistHeaderResult | null {
  for (const selector of HEADER_SELECTORS) {
    const candidates = document.querySelectorAll(selector);
    for (const candidate of Array.from(candidates)) {
      if (!(candidate instanceof HTMLElement)) {
        continue;
      }
      const text = (candidate.textContent ?? "").trim();
      if (text.length === 0) {
        continue;
      }
      if (!isVisible(candidate)) {
        continue;
      }
      const parent = candidate.parentElement;
      if (parent === null) {
        continue;
      }
      return {
        element: parent,
        titleElement: candidate,
        matchedSelector: selector,
      };
    }
  }
  return null;
}
