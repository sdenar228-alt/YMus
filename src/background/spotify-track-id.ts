// Чистые функции преобразования Spotify trackId ↔ Track_GID.
// Реализует Requirements 9.1–9.6, 19.1–19.4 (см. requirements.md);
// псевдокод фиксирован в design.md § G.
//
// Spotify-trackId — 22-символьная base62-строка с алфавитом
// "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".
// Track_GID — 32-символьная hex-строка нижнего регистра.
// Это та же 128-битная величина в двух разных представлениях; round-trip
// `gidToTrackId(trackIdToGid(t)) === t` и обратный `trackIdToGid(gidToTrackId(g)) === g`
// выполняются для всех валидных входов.
//
// Никаких импортов из chrome.* — функции полностью чистые и пригодны
// для unit- и property-тестирования.

import { SpotifyError } from "./spotify-errors";

// Алфавит base62, используемый Spotify. Порядок (цифры → заглавные → строчные)
// фиксирован: индекс символа в этой строке и есть его base62-значение.
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Таблица обратного перехода "символ → значение 0..61" для O(1)-индексации
// внутри trackIdToGid. Object.fromEntries даёт plain-object без прототипных
// сюрпризов; обращение через ALPHABET_INDEX[c] всегда определено для входов,
// прошедших валидацию регэкспом ниже.
const ALPHABET_INDEX: Record<string, number> = Object.fromEntries(
  Array.from(ALPHABET, (c, i) => [c, i]),
);

// Регэкспы валидации входа. Совпадают с теми, что описаны в requirements
// (R9.2, R9.6, R19.1).
const TRACK_ID_REGEX = /^[A-Za-z0-9]{22}$/;
const GID_REGEX = /^[0-9a-f]{32}$/;

/**
 * Преобразует 22-символьный base62 trackId в 32-символьный hex Track_GID
 * нижнего регистра.
 *
 * Validates: Requirements 9.1, 9.2, 9.4, 9.6, 19.1, 19.3.
 *
 * @throws SpotifyError("SPOTIFY_TRACK_ID_INVALID") если вход не соответствует
 *   формату `^[A-Za-z0-9]{22}$`.
 */
export function trackIdToGid(trackId: string): string {
  if (!TRACK_ID_REGEX.test(trackId)) {
    throw new SpotifyError(
      "SPOTIFY_TRACK_ID_INVALID",
      `Invalid trackId: ${trackId}`,
    );
  }
  // BigInt-арифметика с основанием 62: накапливаем число, проходя по
  // символам слева направо (старший разряд — первый символ).
  let acc = 0n;
  for (const c of trackId) {
    acc = acc * 62n + BigInt(ALPHABET_INDEX[c]);
  }
  // Нормализуем до 32 hex-символов нижнего регистра. padStart покрывает
  // случай маленьких чисел (ведущие нули в hex-представлении).
  return acc.toString(16).padStart(32, "0");
}

/**
 * Преобразует 32-символьный hex Track_GID в 22-символьный base62 trackId.
 *
 * Validates: Requirements 9.3, 9.5, 9.6, 19.2, 19.4.
 *
 * @throws SpotifyError("SPOTIFY_TRACK_ID_INVALID") если вход не соответствует
 *   формату `^[0-9a-f]{32}$`.
 */
export function gidToTrackId(gid: string): string {
  if (!GID_REGEX.test(gid)) {
    throw new SpotifyError(
      "SPOTIFY_TRACK_ID_INVALID",
      `Invalid gid: ${gid}`,
    );
  }
  // Парсим 128-битную величину из hex и раскладываем по основанию 62.
  // Деление с остатком даёт младшие разряды первыми, поэтому собираем в
  // out и реверсим в конце.
  let acc = BigInt("0x" + gid);
  const out: string[] = [];
  while (acc > 0n) {
    out.push(ALPHABET[Number(acc % 62n)]);
    acc = acc / 62n;
  }
  // Дополняем "0" слева до 22 символов: это соответствует ведущим нулям
  // в base62-представлении маленьких чисел и обеспечивает round-trip
  // `trackIdToGid(gidToTrackId(g)) === g` для gid с ведущими нулями.
  while (out.length < 22) out.push("0");
  return out.reverse().join("");
}
