// Перехват Spotify_Access_Token из заголовка `Authorization: Bearer …`
// сетевых запросов Web-плеера (см. design.md § E «Token capture details»).
//
// Стратегия — пассивная: мы подписываемся на
// `chrome.webRequest.onBeforeSendHeaders` с фильтром по эндпоинтам Spotify
// и читаем заголовок `Authorization`. Никаких собственных запросов на
// страницу мы не отправляем — токен появляется естественным образом, как
// только Web-плеер делает любой XHR (heartbeat, autoplay-suggestions,
// pubsub и т.д.).
//
// Хранение — только in-memory (R4.9): запись в `chrome.storage.*`
// намеренно не делается, потому что токен — не наш и сохранять его на
// диск нет ни смысла, ни прав. При выгрузке SW (естественное поведение
// MV3) кеш обнуляется автоматически вместе с памятью SW.
//
// Все состояния держатся в module-level переменных, listener идемпотентен
// (повторный вызов `startSpotifyTokenCapture` не приводит к двойной
// регистрации).

import type { SpotifyTokenCacheEntry } from "../shared/spotify-types";
import { SpotifyError } from "./spotify-errors";

// ─── Константы ─────────────────────────────────────────────────────────────

/** TTL сохранённого токена — 30 минут (R4.3). */
const TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * Дедлайн ожидания первого перехвата на cold-start (R4.7).
 * Если за это время Web-плеер не сделал ни одного запроса с
 * `Authorization`, бросаем `SPOTIFY_TOKEN_UNAVAILABLE`.
 */
const COLD_START_WAIT_MS = 2000;

/**
 * Фильтр URL для подписки на `onBeforeSendHeaders` (R4.1).
 *
 * Покрывает официальный Web API, внутренний spclient и все региональные
 * поддомены storage-resolve. Chrome не поддерживает `*` в середине хоста
 * (только в начале — `*.spotify.com`), поэтому используем один общий
 * wildcard, который ловит любые поддомены *.spotify.com (включая
 * `gewt.spc-arn.spotify.com` для storage-resolve, `spclient.wg.spotify.com`
 * и т. д.). API-домен `api.spotify.com` тоже попадает под этот же
 * паттерн, поэтому отдельная запись не нужна.
 */
const URL_FILTERS: ReadonlyArray<string> = [
  "https://*.spotify.com/*",
  // pathfinder GraphQL живёт на api-partner.spotify.com (это subdomain
  // *.spotify.com — попадает под верхний фильтр, но явно дублируем для
  // ясности). Также захватываем sniff с api.spotify.com для подсчёта.
];

// ─── Состояние модуля (in-memory only) ─────────────────────────────────────

/** Кеш последнего перехваченного токена; `null` означает «нет токена». */
let cached: SpotifyTokenCacheEntry | null = null;

/** Кеш перехваченного `client-token` (для запросов к `spclient.wg`). */
let cachedClientToken: string | null = null;

/**
 * Реальный spclient-хост, которым пользуется Web-плеер этой сессии.
 * Spotify балансирует между региональными инстансами (gew4-spclient,
 * gae2-spclient, gewt.spc-arn и т. д.), и generic-alias `spclient.wg`
 * может отвечать 404 на запросы метадаты, в то время как региональный
 * хост — 200. Захватываем первый увиденный поддомен `*-spclient.spotify.com`
 * или `spclient.*.spotify.com` из URL запросов Web-плеера.
 */
let cachedSpclientHost: string | null = null;

/**
 * Очередь ожидающих первого перехвата на cold-start.
 * Каждый callback вызывается ровно один раз — либо при перехвате токена,
 * либо при истечении дедлайна (через локальный setTimeout вызывающего).
 */
const waiters: Array<(token: string) => void> = [];

// ─── Внутренние утилиты ────────────────────────────────────────────────────

/** Проверка свежести записи кеша по TTL (R4.3 / R4.4). */
function isFresh(entry: SpotifyTokenCacheEntry, now: number): boolean {
  return now - entry.capturedAt < TOKEN_TTL_MS;
}

/**
 * Сохраняет перехваченный токен и будит всех ожидающих (cold-start).
 * Внутренняя функция — вызывается из listener'а и из `seedSpotifyToken`.
 */
function setSpotifyToken(token: string): void {
  const isNew = cached === null || cached.token !== token;
  cached = { token, capturedAt: Date.now() };
  if (isNew) {
    console.info(
      `[ymd][spotify][token] captured fresh Bearer token (${token.length} chars, suffix=…${token.slice(-6)})`,
    );
  }
  // Снимаем снимок очереди, чтобы waiter'ы, которые сами пере-добавятся
  // (теоретически), не зацикливали уведомление.
  const queue = waiters.slice();
  waiters.length = 0;
  if (queue.length > 0) {
    console.info(
      `[ymd][spotify][token] resolving ${queue.length} waiter(s)`,
    );
  }
  for (const cb of queue) {
    try {
      cb(token);
    } catch {
      // Ошибка в одном waiter'е не должна ломать остальные.
    }
  }
}

// ─── Публичный API ─────────────────────────────────────────────────────────

/**
 * Сбрасывает кешированный токен (R4.5, R4.8).
 *
 * Вызывается из других модулей пайплайна при HTTP 401/403 ответах
 * Spotify-эндпоинтов. Особый случай — 403 от `audio-keys` интерпретируется
 * как DRM (R8.3), поэтому вызывающие НЕ должны инвалидировать токен в
 * этом конкретном случае; это ответственность вызывающего кода.
 *
 * После инвалидации следующий вызов `getSpotifyAccessToken` снова ждёт
 * перехвата (или проваливается с `SPOTIFY_TOKEN_UNAVAILABLE`).
 */
export function invalidateSpotifyToken(): void {
  cached = null;
}

/**
 * Возвращает кешированный `client-token`, если он был перехвачен.
 *
 * `client-token` — отдельный заголовок Spotify, который Web-плеер шлёт
 * на запросы к `spclient.wg.spotify.com` вместе с `Authorization`.
 * Многие эндпоинты `spclient` (включая `metadata/4/track`) **не**
 * отвечают без него (HTTP 404/401). Захватываем его пассивно и
 * подставляем во все наши запросы к spclient.
 */
export function getSpotifyClientToken(): string | null {
  return cachedClientToken;
}

/**
 * Возвращает региональный spclient-хост, замеченный у Web-плеера. Если
 * ничего не перехватили — `null`, и вызывающий код использует generic
 * `spclient.wg.spotify.com`.
 */
export function getSpotifySpclientHost(): string | null {
  return cachedSpclientHost;
}

/**
 * Ждёт появления `client-token` до `timeoutMs` миллисекунд. Возвращает
 * токен или `null`, если за дедлайн не появился. В отличие от
 * `getSpotifyAccessToken`, не бросает исключения — вызывающий код
 * сам решает, как реагировать на `null` (некоторые spclient-эндпоинты
 * могут работать без client-token).
 */
export async function waitForSpotifyClientToken(
  timeoutMs = 1500,
  externalSignal?: AbortSignal,
): Promise<string | null> {
  if (cachedClientToken !== null) return cachedClientToken;
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(timer);
      if (externalSignal !== undefined) {
        externalSignal.removeEventListener("abort", onAbort);
      }
      resolve(value);
    };
    const onAbort = (): void => finish(cachedClientToken);
    const timer = setTimeout(() => finish(cachedClientToken), timeoutMs);
    // Простой polling каждые 100 мс — listener сам пишет в cache,
    // так что нам достаточно периодически проверять.
    const poller = setInterval(() => {
      if (cachedClientToken !== null) finish(cachedClientToken);
    }, 100);
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) {
        finish(cachedClientToken);
      } else {
        externalSignal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

/**
 * Возвращает свежий Spotify_Access_Token (R4.3, R4.7).
 *
 * Поведение:
 *   1. Если в кеше есть валидный (TTL не истёк) токен — возвращает его
 *      синхронно через resolved Promise.
 *   2. Если кеш пуст или просрочен — ждёт следующего перехвата с
 *      дедлайном `COLD_START_WAIT_MS` (2000 мс).
 *   3. По истечении дедлайна — бросает
 *      `SpotifyError("SPOTIFY_TOKEN_UNAVAILABLE", …)` с человекочитаемым
 *      сообщением (R4.7).
 *
 * Опциональный `signal` позволяет вызывающему отменить ожидание раньше
 * дедлайна (например, при общем тайм-ауте оркестратора). При отмене
 * возвращается `signal.reason`, если он задан, иначе — экземпляр
 * `SpotifyError("SPOTIFY_TOKEN_UNAVAILABLE", …)` для единообразной
 * классификации в оркестраторе.
 */
export function getSpotifyAccessToken(signal?: AbortSignal): Promise<string> {
  const now = Date.now();
  if (cached !== null && isFresh(cached, now)) {
    return Promise.resolve(cached.token);
  }
  // Кеш пуст или просрочен — ждём первого перехвата.
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const removeWaiter = (): void => {
      const idx = waiters.indexOf(onCapture);
      if (idx >= 0) waiters.splice(idx, 1);
    };

    const onCapture = (token: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      resolve(token);
    };

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      removeWaiter();
      clearTimeout(timer);
      // `signal.reason` доступен в Node 18+/современных браузерах; если
      // его нет — fallback на собственную ошибку.
      const reason =
        signal !== undefined && signal.reason !== undefined
          ? signal.reason
          : new SpotifyError(
              "SPOTIFY_TOKEN_UNAVAILABLE",
              "Ожидание Spotify-токена прервано",
            );
      reject(reason);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      removeWaiter();
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      reject(
        new SpotifyError(
          "SPOTIFY_TOKEN_UNAVAILABLE",
          "Откройте вкладку open.spotify.com или запустите воспроизведение любого трека, чтобы расширение получило токен",
        ),
      );
    }, COLD_START_WAIT_MS);

    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    waiters.push(onCapture);
  });
}

/**
 * Принудительно записывает токен в кеш (test-only / Phase 2 page-bridge).
 *
 * Используется:
 *   * в unit/property-тестах для детерминированного предзаполнения кеша
 *     без эмуляции `chrome.webRequest`;
 *   * в Phase 2 как путь от `spotify-page-bridge.ts` (MAIN-world
 *     monkey-patch `window.fetch`) к background SW: bridge пересылает
 *     перехваченное значение через `chrome.runtime.sendMessage`, и
 *     приёмник в SW вызывает эту функцию.
 *
 * Пустые / whitespace-only токены игнорируются (защита от мусора).
 */
export function seedSpotifyToken(token: string): void {
  if (typeof token !== "string") return;
  const trimmed = token.trim();
  if (trimmed.length === 0) return;
  setSpotifyToken(trimmed);
}

// ─── webRequest listener ───────────────────────────────────────────────────

/**
 * Listener `chrome.webRequest.onBeforeSendHeaders`. Объявлен на module
 * level, чтобы `hasListener`/`addListener`/`removeListener` оперировали
 * одной и той же ссылкой и регистрация была идемпотентной.
 */
function onSpotifyAuthorization(
  details: chrome.webRequest.WebRequestHeadersDetails,
): void {
  totalIntercepted++;

  // ── DIAG: лог первых 30 уникальных URL-путей, чтобы найти metadata-endpoint
  // (Spotify в 2024-2025 ушёл на pathfinder/GraphQL — generic
  // `metadata/4/track` отдаёт 404 для веб-сессий). Логируем только новые
  // pathnames, чтобы не спамить.
  try {
    const u = new URL(details.url);
    const key = `${u.hostname}${u.pathname}`;
    if (!sniffSeen.has(key) && sniffSeen.size < 60) {
      sniffSeen.add(key);
      console.info(
        `[ymd][spotify][sniff] ${details.method} ${u.hostname}${u.pathname}${u.search.slice(0, 80)}`,
      );
    }
  } catch {
    /* ignore */
  }

  // Параллельно с заголовками захватываем региональный spclient-хост.
  // Web-плеер балансирует между несколькими (gew4-spclient, gae2-spclient,
  // ...), и generic `spclient.wg.spotify.com` может отвечать 404 на наши
  // запросы; региональный — 200.
  try {
    const u = new URL(details.url);
    if (
      cachedSpclientHost === null &&
      /^([a-z0-9]+-)?spclient\.(?:[a-z0-9-]+\.)?spotify\.com$/i.test(u.hostname)
    ) {
      cachedSpclientHost = u.hostname;
      console.info(
        `[ymd][spotify][token] captured spclient host: ${cachedSpclientHost}`,
      );
    }
  } catch {
    /* ignore */
  }

  const headers = details.requestHeaders;
  if (headers === undefined) {
    withoutAuth++;
    if (totalIntercepted % 25 === 0) {
      console.warn(
        `[ymd][spotify][token] intercepted ${totalIntercepted} requests, ${withoutAuth} without Authorization (extraHeaders may not be applied?)`,
      );
    }
    return;
  }
  let sawAuth = false;
  for (const h of headers) {
    const lname = h.name.toLowerCase();
    if (lname === "authorization") {
      if (typeof h.value !== "string") continue;
      if (!h.value.startsWith("Bearer ")) continue;
      const token = h.value.slice(7).trim();
      if (token.length > 0) {
        setSpotifyToken(token);
        sawAuth = true;
      }
    } else if (lname === "client-token") {
      // Web-плеер шлёт этот заголовок на запросы к spclient.wg вместе с
      // Authorization. Многие spclient-эндпоинты отвечают 404 без него.
      if (typeof h.value === "string" && h.value.length > 0) {
        if (cachedClientToken !== h.value) {
          cachedClientToken = h.value;
          console.info(
            `[ymd][spotify][token] captured client-token (${h.value.length} chars, suffix=…${h.value.slice(-6)})`,
          );
        }
      }
    }
  }
  if (sawAuth) return;
  withoutAuth++;
  if (totalIntercepted % 25 === 0) {
    console.warn(
      `[ymd][spotify][token] intercepted ${totalIntercepted} requests, ${withoutAuth} without Authorization. Last URL=${details.url}`,
    );
  }
}

let totalIntercepted = 0;
let withoutAuth = 0;
const sniffSeen = new Set<string>();

/**
 * Регистрирует listener на `onBeforeSendHeaders` (R4.1).
 *
 * Вызывается один раз при старте SW (см. задачу 4.2 — `background.ts`).
 * Идемпотентно: повторный вызов не приводит к двойной регистрации, т.к.
 * мы проверяем `hasListener` для одной и той же ссылки на функцию.
 *
 * Безопасно для jsdom-окружения тестов: если `chrome.webRequest`
 * недоступен (jsdom-тесты, Node), функция тихо завершится без побочных
 * эффектов — кеш и `seedSpotifyToken` продолжат работать, что и нужно
 * для unit-тестов.
 */
export function startSpotifyTokenCapture(): void {
  if (typeof chrome === "undefined") return;
  // Узкая защита от частичного полифила `chrome.*` в тестовом окружении:
  // некоторые моки определяют `chrome` без `webRequest`.
  const wr = (chrome as { webRequest?: typeof chrome.webRequest }).webRequest;
  if (wr === undefined || wr.onBeforeSendHeaders === undefined) return;

  if (wr.onBeforeSendHeaders.hasListener(onSpotifyAuthorization)) return;

  // `extraHeaders` обязателен для получения «защищённых» заголовков, в
  // том числе `Authorization`, в MV3-режиме. Без этого флага значение
  // заголовка может быть выдано нулевым/отсутствующим.
  try {
    wr.onBeforeSendHeaders.addListener(
      onSpotifyAuthorization,
      { urls: [...URL_FILTERS], types: ["xmlhttprequest"] },
      ["requestHeaders", "extraHeaders"],
    );
    console.info(
      `[ymd][spotify][token] webRequest listener installed for ${URL_FILTERS.join(", ")}`,
    );
  } catch (err) {
    console.error(
      "[ymd][spotify][token] failed to install webRequest listener:",
      err,
    );
    throw err;
  }
}
