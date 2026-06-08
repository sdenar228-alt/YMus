// Резолвинг CDN-ссылки для уже выбранного Spotify_File_Id.
// Реализует Requirements 7.1, 7.2, 7.7, 7.9 и 21.3, 21.6 (см. requirements.md
// и design.md § C / § L). Это второй сетевой шаг после metadata-эндпоинта:
// зная `fileId`, мы спрашиваем у regional storage-resolve конкретный URL
// на CDN, по которому фактически лежит зашифрованный Ogg-файл.
//
// Особенности:
//   * Поддомен `gewt.spc-arn.spotify.com` зафиксирован константой и при
//     необходимости заменяется в одном месте (R7.1: «конкретный поддомен —
//     например, gewt.spc-arn.spotify.com — определяется на этапе design»).
//   * Тайм-аут 5 000 мс через локальный AbortController; вызывающий может
//     дополнительно передать свой `externalSignal`, и его abort также
//     проводится в `fetch` (паттерн повторяет vk-api-client / message-router).
//   * 401/403 → `invalidateSpotifyToken()` + `SPOTIFY_TOKEN_EXPIRED`
//     (R7.9, R4.5). Любой иной non-2xx статус и/или пустой `cdnurl` →
//     `SPOTIFY_STORAGE_RESOLVE_FAILED` с непустой `reason`, содержащей
//     HTTP-статус (R7.7, R22.3).

import { SpotifyError } from "./spotify-errors";
import {
  getSpotifyClientToken,
  invalidateSpotifyToken,
} from "./spotify-token-capture";

// ─── Константы ─────────────────────────────────────────────────────────────

/**
 * Региональный поддомен storage-resolve, зафиксированный по результатам
 * анализа сетевых запросов Web-плеера (R7.1, design § C).
 *
 * Если в будущем потребуется сменить регион (например, на `gae2.spc-fra`
 * для европейских пользователей) — правится только эта константа.
 * Никаких runtime-выборов поддомена в этой итерации не делается.
 */
const SPC_HOST = "https://gewt.spc-arn.spotify.com";

/** Тайм-аут одиночного REST-запроса storage-resolve (R21.3). */
const STORAGE_RESOLVE_TIMEOUT_MS = 5000;

/**
 * Фиксированные query-параметры запроса storage-resolve.
 * `version=10000000`, `product=9`, `platform=39`, `alt=json` —
 * значения, наблюдаемые у Web-плеера; `alt=json` гарантирует, что
 * ответ придёт в JSON (а не в protobuf).
 */
const STORAGE_RESOLVE_QUERY =
  "version=10000000&product=9&platform=39&alt=json";

// ─── Типы ответа ───────────────────────────────────────────────────────────

/**
 * Ожидаемая форма JSON-ответа storage-resolve.
 *
 * В реальности Spotify может вернуть и другие поля (например, `result`,
 * `fileid`), но нам интересен только `cdnurl` — массив CDN-ссылок,
 * первой из которых пользуется Web-плеер. Поле объявлено как опциональное,
 * чтобы тип отражал runtime-валидацию ниже: мы НЕ полагаемся на его
 * наличие на типовом уровне и проверяем явно.
 */
interface StorageResolveResponse {
  cdnurl?: unknown;
}

// ─── Внутренние утилиты ────────────────────────────────────────────────────

/**
 * Достаёт первый непустой URL из массива `cdnurl` ответа.
 * Возвращает `null`, если массив отсутствует, не является массивом,
 * пуст, либо первый элемент не является непустой строкой.
 *
 * Извлечение в отдельную функцию упрощает unit-тестирование без сетевой
 * части и избавляет основной поток от вложенных проверок.
 */
function pickFirstCdnUrl(parsed: StorageResolveResponse): string | null {
  const arr = parsed.cdnurl;
  if (!Array.isArray(arr)) return null;
  if (arr.length === 0) return null;
  const first = arr[0];
  if (typeof first !== "string") return null;
  const trimmed = first.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

/**
 * Проксирует abort внешнего сигнала на локальный контроллер.
 *
 * Возвращает функцию-«отписчик», которую обязательно нужно вызвать
 * после завершения запроса, иначе листенер останется висеть до тех
 * пор, пока внешний сигнал не освободится (часто — до конца сессии SW).
 *
 * Вынесено в отдельную утилиту, потому что по плану тот же паттерн
 * применяется во всех сетевых модулях Spotify-пайплайна (metadata,
 * storage-resolve, audio-keys, cdn-fetch).
 */
function forwardAbort(
  external: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (external === undefined) return () => {};
  if (external.aborted) {
    controller.abort(external.reason);
    return () => {};
  }
  const onAbort = (): void => {
    controller.abort(external.reason);
  };
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
}

// ─── Публичный API ─────────────────────────────────────────────────────────

/**
 * Запросить CDN-URL для зашифрованного Ogg-файла, соответствующего
 * заданному `fileId`.
 *
 * Шаги:
 *   1. GET `${SPC_HOST}/audio/v1/file/{fileId}?version=10000000&product=9&platform=39&alt=json`
 *      с заголовком `Authorization: Bearer {token}` (R7.1).
 *   2. На 401/403 — инвалидировать кеш токена и бросить
 *      `SPOTIFY_TOKEN_EXPIRED` (R7.9, R4.5).
 *   3. На любой иной non-2xx (или сетевую ошибку, или таймаут) — бросить
 *      `SPOTIFY_STORAGE_RESOLVE_FAILED` с HTTP-статусом в `reason` (R7.7).
 *   4. Распарсить JSON, взять `cdnurl[0]` (R7.2). Если массив пуст или
 *      первая запись не валидна — `SPOTIFY_STORAGE_RESOLVE_FAILED`.
 *
 * @param fileId         — 40-символьная hex-строка Spotify_File_Id.
 * @param token          — Bearer-токен из `getSpotifyAccessToken`.
 * @param externalSignal — опциональный AbortSignal оркестратора.
 *
 * Validates: Requirements 7.1, 7.2, 7.7, 7.9, 21.3, 21.6.
 */
export async function resolveCdnUrl(
  fileId: string,
  token: string,
  externalSignal?: AbortSignal,
): Promise<string> {
  // Локальный контроллер: к нему привязаны и таймер, и проксирование
  // abort'а от внешнего сигнала. На любом из путей завершения вызывается
  // `clearTimeout` и `unsubscribe`, чтобы не утекали листенеры.
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new Error("storage-resolve timeout")),
    STORAGE_RESOLVE_TIMEOUT_MS,
  );
  const unsubscribe = forwardAbort(externalSignal, controller);

  const url = `${SPC_HOST}/audio/v1/file/${fileId}?${STORAGE_RESOLVE_QUERY}`;

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    const clientToken = getSpotifyClientToken();
    if (clientToken !== null) {
      headers["client-token"] = clientToken;
    }
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    // 401/403 — токен протух: инвалидируем кеш и сообщаем оркестратору
    // отдельным кодом. Это поведение симметрично всем остальным
    // Spotify-эндпоинтам, кроме audio-keys на 403 (там 403 = DRM, R8.3).
    if (response.status === 401 || response.status === 403) {
      invalidateSpotifyToken();
      throw new SpotifyError(
        "SPOTIFY_TOKEN_EXPIRED",
        "Сессия Spotify истекла, обновите страницу open.spotify.com",
      );
    }

    if (response.status !== 200) {
      throw new SpotifyError(
        "SPOTIFY_STORAGE_RESOLVE_FAILED",
        `HTTP ${response.status}`,
      );
    }

    // Парсим JSON. Сам по себе `response.json()` бросает SyntaxError на
    // невалидном теле — ловим и нормализуем до SPOTIFY_STORAGE_RESOLVE_FAILED.
    let parsed: StorageResolveResponse;
    try {
      parsed = (await response.json()) as StorageResolveResponse;
    } catch (e) {
      throw new SpotifyError(
        "SPOTIFY_STORAGE_RESOLVE_FAILED",
        `Невалидный JSON storage-resolve (HTTP 200): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    const cdnUrl = pickFirstCdnUrl(parsed);
    if (cdnUrl === null) {
      throw new SpotifyError(
        "SPOTIFY_STORAGE_RESOLVE_FAILED",
        "Empty cdnurl array (HTTP 200)",
      );
    }
    return cdnUrl;
  } catch (e) {
    // SpotifyError проброшен из веток выше — отдаём как есть.
    if (e instanceof SpotifyError) throw e;
    // AbortError (как от таймера, так и от внешнего сигнала) → таймаут.
    // Сообщение reason всегда непустое (R22.3).
    if (e instanceof Error && e.name === "AbortError") {
      throw new SpotifyError(
        "SPOTIFY_STORAGE_RESOLVE_FAILED",
        "Превышено время ожидания storage-resolve (5000 мс)",
      );
    }
    // Прочая сетевая ошибка (TypeError при DNS-сбое и т.д.).
    throw new SpotifyError(
      "SPOTIFY_STORAGE_RESOLVE_FAILED",
      `Сетевая ошибка storage-resolve: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  } finally {
    clearTimeout(timeoutId);
    unsubscribe();
  }
}
