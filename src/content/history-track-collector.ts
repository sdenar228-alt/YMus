/**
 * Module: history-track-collector
 *
 * Собирает track ID для заданной даты из __STATE_SNAPSHOT__ (indexesMap),
 * который Яндекс.Музыка вшивает в HTML при SSR.
 *
 * Формат ключей indexesMap:
 *   "{dateIdx}_{groupIdx}_{trackIdx}_{trackId}:{albumId}" → number
 *   "{dateIdx}_{groupIdx}_user:onyourwave" → number (плейлисты «Моя волна»)
 *
 * dateIdx соответствует порядку дат в DOM (0 = сегодня, 1 = вчера, ...).
 *
 * Requirements: 3.1, 3.2, 3.3, 3.5
 */

/** Селектор, идентифицирующий Date_Header элемент */
const DATE_HEADER_SELECTOR = "h2[data-date-anchor]";

/** Селектор для кнопок скачивания треков, внедрённых расширением */
const TRACK_BUTTON_SELECTOR = "button[data-ymd-track-id]";

/** Regex для извлечения track ID из href="/track/{id}" */
const TRACK_HREF_RE = /^\/track\/(\d+)$/;

/**
 * Парсит indexesMap из инлайн-скрипта __STATE_SNAPSHOT__ на странице.
 * Возвращает Map<dateIdx, trackId[]> — все треки по индексу даты.
 */
function parseIndexesMapFromPage(): Map<number, string[]> | null {
  const scripts = document.querySelectorAll("script");
  for (const s of scripts) {
    const t = s.textContent || "";
    const start = t.indexOf('"indexesMap":{');
    if (start === -1) continue;

    // Проверяем что это не пустой объект
    if (t.charAt(start + 14) === "}") continue;

    // Находим конец объекта indexesMap
    let braceCount = 0;
    const mapStart = start + 13;
    let mapEnd = mapStart;
    for (let i = mapStart; i < t.length && i < mapStart + 200000; i++) {
      if (t[i] === "{") braceCount++;
      if (t[i] === "}") {
        braceCount--;
        if (braceCount === 0) {
          mapEnd = i + 1;
          break;
        }
      }
    }

    try {
      const map = JSON.parse(t.substring(mapStart, mapEnd)) as Record<string, number>;
      const result = new Map<number, string[]>();

      for (const key of Object.keys(map)) {
        // Формат: "0_0_3_148216549:40661655" → dateIdx=0, trackId=148216549
        const m = key.match(/^(\d+)_\d+_\d+_(\d+):/);
        if (!m) continue;
        const dateIdx = parseInt(m[1], 10);
        const trackId = m[2];

        if (!result.has(dateIdx)) {
          result.set(dateIdx, []);
        }
        result.get(dateIdx)!.push(trackId);
      }

      // Возвращаем только если нашли хоть что-то
      if (result.size > 0) return result;
    } catch {
      // JSON parse error — пробуем следующий скрипт
    }
  }

  return null;
}

/**
 * Определяет dateIdx для данного dateHeader, основываясь на порядке
 * h2[data-date-anchor] элементов в DOM (0 = первая дата = сегодня).
 */
function getDateIndex(dateHeader: Element): number {
  const allHeaders = document.querySelectorAll(DATE_HEADER_SELECTOR);
  for (let i = 0; i < allHeaders.length; i++) {
    if (allHeaders[i] === dateHeader) return i;
  }
  return -1;
}

/**
 * Собирает уникальные track ID из DOM-секции, принадлежащей данному dateHeader.
 * NOTE: из-за виртуализации может вернуть только видимые треки (~24).
 * Для полного списка используйте collectTrackIdsFromState().
 *
 * @param dateHeader — DOM-элемент заголовка даты (h2[data-date-anchor])
 * @returns readonly массив track ID строк, в DOM-порядке, без дупликатов
 */
export function collectTrackIds(dateHeader: Element): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  // Try dedicated day container first (production Yandex Music layout)
  const dayContainer = dateHeader.closest("div[data-intersection-property-id]");

  if (dayContainer) {
    const trackButtons = dayContainer.querySelectorAll(TRACK_BUTTON_SELECTOR);
    for (let i = 0; i < trackButtons.length; i++) {
      const trackId = trackButtons[i].getAttribute("data-ymd-track-id");
      if (trackId && !seen.has(trackId)) {
        seen.add(trackId);
        result.push(trackId);
      }
    }

    if (result.length === 0) {
      const anchors = dayContainer.querySelectorAll("a[href]");
      for (let i = 0; i < anchors.length; i++) {
        const href = anchors[i].getAttribute("href");
        if (!href) continue;
        const match = TRACK_HREF_RE.exec(href);
        if (!match) continue;
        const trackId = match[1];
        if (!seen.has(trackId)) {
          seen.add(trackId);
          result.push(trackId);
        }
      }
    }

    return result;
  }

  // Fallback: walk siblings from dateHeader until next date header or end of parent
  let sibling = dateHeader.nextElementSibling;
  while (sibling) {
    if (sibling.classList.contains("d-history__date-header")
      || sibling.matches(DATE_HEADER_SELECTOR)) {
      break;
    }

    // Check for track buttons
    const trackButtons = sibling.querySelectorAll(TRACK_BUTTON_SELECTOR);
    for (let i = 0; i < trackButtons.length; i++) {
      const trackId = trackButtons[i].getAttribute("data-ymd-track-id");
      if (trackId && !seen.has(trackId)) {
        seen.add(trackId);
        result.push(trackId);
      }
    }

    // Check anchors
    const anchors = sibling.querySelectorAll("a[href]");
    for (let i = 0; i < anchors.length; i++) {
      const href = anchors[i].getAttribute("href");
      if (!href) continue;
      const match = TRACK_HREF_RE.exec(href);
      if (!match) continue;
      const trackId = match[1];
      if (!seen.has(trackId)) {
        seen.add(trackId);
        result.push(trackId);
      }
    }

    sibling = sibling.nextElementSibling;
  }

  return result;
}

/**
 * Извлекает ВСЕ track ID для заданной даты из __STATE_SNAPSHOT__ → indexesMap.
 * Это обходит виртуализацию DOM — indexesMap содержит полный список треков.
 *
 * Если indexesMap не найден или пуст — fallback на DOM (частичный).
 *
 * @param dateHeader — элемент h2[data-date-anchor] для целевой даты
 * @returns массив trackId для всех треков этой даты
 */
export function collectTrackIdsFromState(dateHeader: Element): readonly string[] {
  const dateIdx = getDateIndex(dateHeader);
  if (dateIdx === -1) {
    return collectTrackIds(dateHeader);
  }

  const indexesMap = parseIndexesMapFromPage();
  if (!indexesMap) {
    console.warn("[ymd][history] indexesMap not found in __STATE_SNAPSHOT__, falling back to DOM");
    return collectTrackIds(dateHeader);
  }

  const tracks = indexesMap.get(dateIdx);
  if (!tracks || tracks.length === 0) {
    console.warn("[ymd][history] No tracks for dateIdx", dateIdx, "in indexesMap, falling back to DOM");
    return collectTrackIds(dateHeader);
  }

  // Дедупликация (один трек мог быть прослушан несколько раз)
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of tracks) {
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }

  console.info(`[ymd][history] Found ${unique.length} tracks for dateIdx=${dateIdx} from __STATE_SNAPSHOT__`);
  return unique;
}
