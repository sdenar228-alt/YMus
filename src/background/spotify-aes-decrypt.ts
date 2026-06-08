// Чистая часть AES-128-CTR-расшифровки для Spotify-пайплайна.
// Реализует Requirements 10.1, 10.5, 18.1–18.4 (см. requirements.md)
// и соответствует разделам I, J, K документа design.md.
//
// В этом модуле находятся ТОЛЬКО синхронные чистые функции и константы:
// фиксированный IV, длина Spotify-Vorbis-префикса, сравнение сигнатуры
// `OggS`, snip-prefix и `validateDecryption`. Сетевую/WebCrypto-часть
// (`decryptSpotifyAudio`) добавит задача 3.8 — здесь её нет, чтобы
// чистые функции можно было импортировать в unit- и property-тесты
// без зависимости от глобального `crypto.subtle`.

/**
 * Фиксированный 16-байтовый IV (counter-блок) для Spotify AES-128-CTR.
 *
 * Шестнадцатеричное значение: `0x72e067fbddcbcf77ebe8bc643f630d93`.
 * Используется как начальное состояние counter-блока; счётчик
 * инкрементируется на 1 для каждого следующего 16-байтового блока
 * шифротекста (см. design § I и Requirements 10.1, 10.2).
 *
 * Validates: Requirement 10.1, 18.1.
 */
export const AES_CTR_IV: Uint8Array = new Uint8Array([
  0x72, 0xe0, 0x67, 0xfb, 0xdd, 0xcb, 0xcf, 0x77,
  0xeb, 0xe8, 0xbc, 0x64, 0x3f, 0x63, 0x0d, 0x93,
]);

/**
 * Длина фиксированного Spotify-Vorbis-префикса в байтах.
 *
 * По librespot для форматов `OGG_VORBIS_*` к началу зашифрованного буфера
 * дописан служебный префикс длиной 167 байт, который не является частью
 * Ogg-стрима и подлежит удалению ПОСЛЕ расшифровки (Requirement 10.5).
 *
 * Если эмпирически окажется, что Web-Player-пайплайн отдаёт префикс
 * другого размера, точное значение нужно уточнить по бинарным дампам
 * (зафиксировано в design § J как Phase-2 risk).
 */
export const SPOTIFY_VORBIS_PREFIX_LEN = 167;

// ASCII-сигнатура начала Ogg-страницы: "OggS" → 0x4F 0x67 0x67 0x53.
// `as const` фиксирует литеральный кортеж и предохраняет от случайного
// мутирования значений на месте.
const OGGS = [0x4f, 0x67, 0x67, 0x53] as const;

/**
 * Проверяет, что в буфере `buf` начиная со смещения `offset` лежит
 * 4-байтовая ASCII-сигнатура `OggS`.
 *
 * Если до конца буфера не хватает 4 байт — возвращает `false`, без
 * исключений и без выхода за границы.
 *
 * Экспортируется отдельно: используется и в `stripSpotifyVorbisPrefix`,
 * и в `validateDecryption`, и (по плану task 2.8) в property-тестах,
 * которые специально проверяют наличие/отсутствие сигнатуры на разных
 * смещениях. Делать функцию публичной дешевле, чем дублировать.
 */
export function startsWithOggS(buf: Uint8Array, offset: number): boolean {
  if (buf.length < offset + 4) return false;
  return (
    buf[offset] === OGGS[0] &&
    buf[offset + 1] === OGGS[1] &&
    buf[offset + 2] === OGGS[2] &&
    buf[offset + 3] === OGGS[3]
  );
}

/**
 * Результат `stripSpotifyVorbisPrefix`.
 *
 * `prefixLen` — фактически снятая длина префикса (0, если префикс не
 * обнаружен либо сигнатура `OggS` лежит сразу на offset 0). Это значение
 * передаётся дальше в `validateDecryption`, чтобы корректно учесть его
 * в проверке длины (см. design § K).
 */
export interface StripSpotifyVorbisPrefixResult {
  bytes: Uint8Array;
  prefixLen: 0 | typeof SPOTIFY_VORBIS_PREFIX_LEN;
}

/**
 * Снимает фиксированный Spotify-Vorbis-префикс с начала расшифрованного
 * буфера, если он там есть.
 *
 * Алгоритм (Requirement 10.5, design § J):
 * 1. Если буфер начинается с `OggS` на offset 0 — префикса нет, отдаём
 *    исходный буфер (`prefixLen: 0`).
 * 2. Иначе если `OggS` лежит на offset `SPOTIFY_VORBIS_PREFIX_LEN` (167) —
 *    отрезаем префикс через `subarray` (без копирования) и возвращаем
 *    `prefixLen: 167`.
 * 3. Если ни на 0, ни на 167 сигнатуры нет — возвращаем буфер как есть
 *    с `prefixLen: 0`. Дальше `validateDecryption` зафейлит проверку
 *    магии и вызывающий код корректно вернёт `SPOTIFY_DECRYPT_FAILED`
 *    (Requirements 10.6, 18.4).
 *
 * Функция чистая: не модифицирует входной буфер; возвращаемые `bytes`
 * либо равны `decrypted`, либо являются `decrypted.subarray(167)` —
 * вьюшкой над тем же ArrayBuffer без побайтового копирования.
 *
 * Validates: Requirement 10.5.
 */
export function stripSpotifyVorbisPrefix(
  decrypted: Uint8Array,
): StripSpotifyVorbisPrefixResult {
  if (startsWithOggS(decrypted, 0)) {
    return { bytes: decrypted, prefixLen: 0 };
  }
  if (startsWithOggS(decrypted, SPOTIFY_VORBIS_PREFIX_LEN)) {
    return {
      bytes: decrypted.subarray(SPOTIFY_VORBIS_PREFIX_LEN),
      prefixLen: SPOTIFY_VORBIS_PREFIX_LEN,
    };
  }
  // Ни 0, ни 167: префикс не обнаружен. Не пытаемся ничего вырезать —
  // отдаём исходный буфер; решение принимает `validateDecryption`.
  return { bytes: decrypted, prefixLen: 0 };
}

/**
 * Результат `validateDecryption` — discriminated union с обязательным
 * непустым `reason` в ветке провала (Requirement 18.4, R22.3).
 */
export type ValidateDecryptionResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Проверяет, что расшифрованный буфер действительно похож на валидный
 * Ogg Vorbis-стрим Spotify (Requirement 18.2–18.4, design § K).
 *
 * Параметры:
 * - `decrypted` — буфер ПОСЛЕ применения `stripSpotifyVorbisPrefix`,
 *   то есть уже без служебного префикса (если он был).
 * - `expectedEncryptedLength` — длина буфера, фактически скачанного с
 *   CDN (это `Content-Length` ответа CDN ДО снятия префикса). AES-CTR
 *   сохраняет длину побайтово, поэтому сразу после расшифровки длина
 *   равна этому значению; после снятия префикса ожидаемая длина равна
 *   `expectedEncryptedLength - prefixLen`.
 * - `prefixLen` — длина префикса, фактически снятая
 *   `stripSpotifyVorbisPrefix` (0 либо 167).
 *
 * Возвращает `{ valid: true }`, если выполнены все три проверки:
 *  (1) `decrypted.length === expectedEncryptedLength - prefixLen`,
 *  (2) первые 4 байта — ASCII `OggS`,
 *  (3) сигнатура `OggS` встречается в буфере минимум 2 раза.
 * В противном случае возвращает `{ valid: false, reason }`, где `reason`
 * — непустая человеко-читаемая строка, описывающая, какая именно
 * проверка не прошла.
 *
 * Validates: Requirements 18.2, 18.3, 18.4.
 */
export function validateDecryption(
  decrypted: Uint8Array,
  expectedEncryptedLength: number,
  prefixLen: 0 | typeof SPOTIFY_VORBIS_PREFIX_LEN,
): ValidateDecryptionResult {
  // (1) Длина после снятия префикса (Requirement 18.3).
  // expectedAfterStrip может уйти в отрицательные значения, если на
  // вход прилетели заведомо некорректные значения (например,
  // expectedEncryptedLength === 0 при prefixLen === 167). В таком случае
  // первое же сравнение всё равно зафейлится — это нас устраивает,
  // отдельная ветка не нужна.
  const expectedAfterStrip = expectedEncryptedLength - prefixLen;
  if (decrypted.length !== expectedAfterStrip) {
    return {
      valid: false,
      reason:
        `Length mismatch: expected ${expectedAfterStrip} bytes ` +
        `(${expectedEncryptedLength} − ${prefixLen}), got ${decrypted.length}`,
    };
  }

  // (2) Магия `OggS` на offset 0 (Requirement 18.4).
  if (!startsWithOggS(decrypted, 0)) {
    return { valid: false, reason: "Buffer does not start with OggS magic" };
  }

  // (3) Минимум 2 Ogg-страницы (Requirement 18.4).
  // Сразу выходим, как только насчитали 2 — для больших аудиофайлов
  // (десятки МБ) полный проход избыточен.
  let count = 0;
  for (let i = 0; i + 4 <= decrypted.length; i++) {
    if (
      decrypted[i] === 0x4f &&
      decrypted[i + 1] === 0x67 &&
      decrypted[i + 2] === 0x67 &&
      decrypted[i + 3] === 0x53
    ) {
      count++;
      if (count >= 2) break;
    }
  }
  if (count < 2) {
    return { valid: false, reason: "Fewer than 2 OggS pages detected" };
  }

  return { valid: true };
}

import { SpotifyError } from "./spotify-errors";

/**
 * Расшифровать AES-128-CTR-зашифрованный буфер Spotify.
 *
 * Использует фиксированный IV (см. AES_CTR_IV) и параметр length: 64
 * для WebCrypto AES-CTR (см. design § I — length:64 безопасно покрывает
 * все реальные размеры Spotify-файлов и совпадает по семантике с librespot).
 *
 * @param encrypted — зашифрованный буфер с CDN (R7).
 * @param keyBytes  — 16-байтовый ключ от audio-keys (R8).
 * @returns         — расшифрованный буфер той же длины (R18.5).
 *
 * Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.6.
 *
 * @throws SpotifyError("SPOTIFY_DECRYPT_FAILED") если WebCrypto бросил
 *   OperationError или иное исключение.
 */
export async function decryptSpotifyAudio(
  encrypted: Uint8Array,
  keyBytes: Uint8Array,
): Promise<Uint8Array> {
  try {
    // Жёсткая проверка длины ключа: WebCrypto при некорректной длине бросит
    // не самое читаемое исключение; явное сообщение упростит диагностику
    // (audio-keys по контракту R8.4 уже отдаёт ровно 16 байт, но ошибочный
    // вход на этом уровне всё равно безопаснее ловить здесь).
    if (keyBytes.length !== 16) {
      throw new SpotifyError(
        "SPOTIFY_DECRYPT_FAILED",
        `Invalid AES key length: expected 16 bytes, got ${keyBytes.length}`,
      );
    }
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-CTR" },
      /* extractable */ false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt(
      // length: 64 — младшие 64 бита counter инкрементируются как счётчик,
      // старшие 64 бита остаются фиксированным nonce. См. design § I.
      { name: "AES-CTR", counter: AES_CTR_IV, length: 64 },
      cryptoKey,
      encrypted,
    );
    return new Uint8Array(plain);
  } catch (e) {
    // SpotifyError (например, из проверки длины ключа выше) пробрасываем
    // как есть, чтобы не терять исходный код/reason.
    if (e instanceof SpotifyError) throw e;
    // Любое другое исключение WebCrypto (OperationError, InvalidAccessError,
    // DataError и т.п.) — превращаем в SPOTIFY_DECRYPT_FAILED с включением
    // текста исходного исключения в reason для диагностики (R10.6).
    throw new SpotifyError(
      "SPOTIFY_DECRYPT_FAILED",
      `Не удалось расшифровать аудио: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
