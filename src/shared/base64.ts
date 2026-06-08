// Быстрая конвертация Uint8Array ↔ base64.
//
// Используется на границе Service Worker ↔ offscreen-документ: сообщения
// chrome.runtime.sendMessage сериализуются через JSON, и `Array<number>`
// длиной N байт превращается в ~7N символов JSON. Base64 даёт ~1.37N — в
// 5 раз компактнее и заметно быстрее парсится.

/**
 * Закодировать Uint8Array в base64 (без переносов строк).
 * Работает в SW и в страницах. Использует btoa с разбивкой на чанки —
 * прямой `btoa(String.fromCharCode(...bytes))` падает на больших массивах.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000; // 32k символов за раз — безопасный размер для apply().
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(
      null,
      slice as unknown as number[],
    );
  }
  return btoa(binary);
}

/**
 * Декодировать base64 в Uint8Array.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
