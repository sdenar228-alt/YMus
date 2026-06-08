// Клиент канонических метаданных Spotify для одиночного трека (R5).
//
// Ровно один публичный путь — `fetchCanonicalTrackMeta(trackId, token, signal)`,
// который ходит в публичный Web API Spotify `GET /v1/tracks/{trackId}`,
// заменяет полученные из DOM значения `artist`/`title` каноническими и
// дополнительно сохраняет `album.name` и `duration_ms` как опциональные
// (Requirements 5.1, 5.2, 5.3).
//
// Особенности:
//   * Per-request `AbortController` с тайм-аутом 5000 мс (R21.1).
//     Внешний `signal` (от оркестратора) и внутренний таймер связываются
//     через ручную композицию: `AbortSignal.any` не используется, чтобы
//     не зависеть от его наличия в TS-`lib`/runtime'е (см. design § N).
//   * Маппинг HTTP → `SpotifyError`:
//       - 401/403 → invalidateSpotifyToken() + SPOTIFY_TOKEN_EXPIRED (R5.6, R4.5);
//       - 404 → SPOTIFY_METADATA_FAILED("Трек не найден…") (R5.4);
//       - прочее не-2xx → SPOTIFY_METADATA_FAILED("HTTP {status}") (R5.5).
//   * Тайм-аут / общая сетевая ошибка → SPOTIFY_METADATA_FAILED с
//     человекочитаемым `reason`. По R22.3 `reason` всегда непустая строка.
//
// Чистой логики (например, склейки артистов) здесь нет — это сетевой
// модуль, и его property-тестирование основано на моках `fetch`.

import { SpotifyError } from "./spotify-errors";
import { invalidateSpotifyToken } from "./spotify-token-capture";

/** Тайм-аут одного запроса к `api.spotify.com` (R21.1). */
const API_TIMEOUT_MS = 5000;

/** Базовый URL Web API Spotify; вынесен для читаемости и тестов. */
const SPOTIFY_TRACKS_API = "https://api.spotify.com/v1/tracks";

/**
 * Канонические метаданные одного трека Spotify (узкая форма того, что
 * отдаёт `/v1/tracks/{id}`; сюда попадают только поля, которыми мы
 * фактически пользуемся в пайплайне — имя файла + опциональные UI-поля).
 *
 * `albumTitle` и `durationMs` опциональны: их отсутствие в ответе
 * (в редких случаях для приватных/недоступных треков) не должно
 * блокировать пайплайн.
 */
export interface CanonicalTrackMeta {
  artist: string;
  title: string;
  albumTitle?: string;
  durationMs?: number;
}

/**
 * Узкое описание ожидаемой формы JSON-ответа Spotify Web API.
 * Все поля отмечены как опциональные/`unknown`, чтобы не падать на
 * неожиданном/обрезанном ответе — валидацию делаем явно ниже.
 */
interface SpotifyApiTrackResponse {
  name?: unknown;
  artists?: unknown;
  album?: { name?: unknown } | null;
  duration_ms?: unknown;
}

/**
 * Получить канонические метаданные трека из публичного Spotify Web API.
 *
 * @param trackId        — 22-символьная base62-строка (валидируется
 *                         выше по стеку — в `extractSpotifyTrackMeta`
 *                         и `trackIdToGid`); здесь используется как есть,
 *                         но `encodeURIComponent` страхует на случай
 *                         попадания нестандартных символов.
 * @param token          — Spotify_Access_Token (R4); кладётся в
 *                         заголовок `Authorization: Bearer …`.
 * @param externalSignal — необязательный сигнал отмены от оркестратора
 *                         (общий тайм-аут пайплайна / отмена по 401
 *                         другой стадии). Связывается с внутренним
 *                         5-секундным таймером.
 *
 * @throws SpotifyError("SPOTIFY_TOKEN_EXPIRED")   на HTTP 401/403.
 * @throws SpotifyError("SPOTIFY_METADATA_FAILED") на HTTP 404, прочих
 *         не-2xx, тайм-ауте или сетевой ошибке.
 */
export async function fetchCanonicalTrackMeta(
  trackId: string,
  token: string,
  externalSignal?: AbortSignal,
): Promise<CanonicalTrackMeta> {
  const url = `${SPOTIFY_TRACKS_API}/${encodeURIComponent(trackId)}`;

  // Собственный контроллер запроса. Через него же реагируем и на
  // внутренний таймер, и на abort внешнего сигнала, чтобы дать `fetch`
  // ровно один источник отмены.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  // Передаточный listener: при abort'е внешнего сигнала пробрасываем
  // отмену во внутренний контроллер. Регистрируем once: true, чтобы не
  // оставлять висячих подписок, если внешний сигнал переиспользуется.
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      // Внешний сигнал уже отменён — отменяем локально сразу же,
      // чтобы fetch ниже не успел даже стартовать.
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, {
        once: true,
      });
    }
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    // 401/403 — токен истёк или Web-плеер выкинут из сессии (R4.5, R5.6).
    // Инвалидируем кеш токена, чтобы следующий вызов `getSpotifyAccessToken`
    // дождался свежего перехвата.
    if (response.status === 401 || response.status === 403) {
      invalidateSpotifyToken();
      throw new SpotifyError(
        "SPOTIFY_TOKEN_EXPIRED",
        `Spotify Web API returned ${response.status}`,
      );
    }

    // 404 — конкретный трек недоступен в каталоге пользователя (R5.4).
    if (response.status === 404) {
      throw new SpotifyError(
        "SPOTIFY_METADATA_FAILED",
        "Трек не найден в каталоге Spotify",
      );
    }

    // Любой другой не-2xx статус — общая категория ошибок API (R5.5);
    // включаем HTTP-статус в `reason`, чтобы было что показать в логах.
    if (!response.ok) {
      throw new SpotifyError(
        "SPOTIFY_METADATA_FAILED",
        `HTTP ${response.status}`,
      );
    }

    // 2xx — парсим JSON. Любая ошибка на этом шаге (порченое тело,
    // не-JSON и т.д.) ловится общим catch ниже и превращается в
    // SPOTIFY_METADATA_FAILED.
    const data = (await response.json()) as SpotifyApiTrackResponse;

    // Склейка `artists[].name` через ", " (R5.2).
    // Безопасно работаем с произвольной формой массива: пропускаем
    // элементы без строкового `name`, чтобы один сбойный объект не
    // ломал всю строку артистов.
    const artistsRaw = Array.isArray(data?.artists)
      ? (data.artists as ReadonlyArray<unknown>)
      : [];
    const artistNames: string[] = [];
    for (const a of artistsRaw) {
      const name =
        a !== null && typeof a === "object" && "name" in a
          ? (a as { name?: unknown }).name
          : undefined;
      if (typeof name === "string" && name.length > 0) {
        artistNames.push(name);
      }
    }
    // Фолбэк "Unknown Artist" — защита от пустого/некорректного списка
    // артистов в ответе API. На практике для публичных треков такого не
    // бывает, но санитизация имени файла не должна падать на этом.
    const artist =
      artistNames.length > 0 ? artistNames.join(", ") : "Unknown Artist";

    // Канонический title (R5.2). Аналогичный фолбэк: если по какой-то
    // причине Spotify вернул пустое `name`, не блокируем пайплайн —
    // подменяем на детерминированный `spotify_track_{id}`.
    const apiTitle = typeof data?.name === "string" ? data.name : "";
    const title = apiTitle.length > 0 ? apiTitle : `spotify_track_${trackId}`;

    const result: CanonicalTrackMeta = { artist, title };

    // Опциональные поля сохраняем только если в ответе они валидной
    // формы (R5.3): пустые строки и неположительные длительности
    // отбрасываем, чтобы UI не показывал заглушки.
    const albumName =
      data?.album !== null &&
      data?.album !== undefined &&
      typeof data.album === "object" &&
      typeof data.album.name === "string"
        ? data.album.name
        : "";
    if (albumName.length > 0) {
      result.albumTitle = albumName;
    }

    if (typeof data?.duration_ms === "number" && data.duration_ms > 0) {
      result.durationMs = data.duration_ms;
    }

    return result;
  } catch (e) {
    // SpotifyError из веток выше — пробрасываем как есть, не теряя
    // исходный код/reason.
    if (e instanceof SpotifyError) throw e;

    // Аборт по нашему таймеру или по внешнему сигналу — это не
    // «случайная» сетевая ошибка, а ожидаемое поведение для R21.1.
    // Возвращаем понятный текст без подробностей DOM-исключения.
    if (controller.signal.aborted) {
      throw new SpotifyError(
        "SPOTIFY_METADATA_FAILED",
        "Превышено время ожидания ответа Spotify",
      );
    }

    // Любая другая сетевая ошибка fetch (TypeError "Failed to fetch",
    // DNS, разрыв соединения и т.п.) — общая категория R5.5, текст
    // оригинального исключения сохраняем в `reason` для диагностики.
    throw new SpotifyError(
      "SPOTIFY_METADATA_FAILED",
      `Network error: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    // Чистим локальные ресурсы независимо от исхода: таймер и подписку
    // на внешний сигнал. Без этого long-running оркестратор копил бы
    // мёртвые setTimeout и листенеры на одном AbortSignal.
    clearTimeout(timer);
    if (externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}
