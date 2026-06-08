// ID3v2.3 writer — добавляет теги (артист, название, альбом, обложка)
// в начало MP3-файла.
//
// Реализация поддерживает только нужные нам кадры:
//   TIT2 — название трека
//   TPE1 — исполнитель
//   TALB — альбом
//   TYER — год
//   TRCK — номер трека
//   APIC — обложка (PNG/JPEG)
//
// Текстовые кадры записываются в UTF-16 с BOM (encoding=1) для поддержки
// кириллицы и любых других символов.

const TAG_VERSION_MAJOR = 3;
const TAG_VERSION_MINOR = 0;

function utf16leBytesWithBom(s: string): Uint8Array {
  const out = new Uint8Array(2 + s.length * 2);
  // BOM little-endian.
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out[2 + i * 2] = code & 0xff;
    out[2 + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return out;
}

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Размер в "synchsafe int" — формат ID3 для размера тега. 4 байта по 7 бит.
 */
function synchsafeInt(n: number): Uint8Array {
  return new Uint8Array([
    (n >> 21) & 0x7f,
    (n >> 14) & 0x7f,
    (n >> 7) & 0x7f,
    n & 0x7f,
  ]);
}

/**
 * Обычный 32-bit big-endian — для размера фрейма в ID3v2.3 (для
 * совместимости с большинством плееров).
 */
function uint32BE(n: number): Uint8Array {
  return new Uint8Array([
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]);
}

function buildTextFrame(frameId: string, text: string): Uint8Array {
  const payload = concatBytes([
    new Uint8Array([0x01]), // encoding = UTF-16 with BOM
    utf16leBytesWithBom(text),
  ]);
  const header = concatBytes([
    asciiBytes(frameId), // 4 bytes
    uint32BE(payload.length), // size
    new Uint8Array([0x00, 0x00]), // flags
  ]);
  return concatBytes([header, payload]);
}

function buildApicFrame(
  imageBytes: Uint8Array,
  mime: "image/jpeg" | "image/png",
): Uint8Array {
  // payload:
  //   1 byte encoding (0x03 = UTF-8 для description)
  //   <mime>\0
  //   1 byte picture type (0x03 = front cover)
  //   <description>\0  (UTF-8, пустое)
  //   <image bytes>
  const mimeBytes = asciiBytes(mime);
  const payload = concatBytes([
    new Uint8Array([0x03]), // encoding UTF-8
    mimeBytes,
    new Uint8Array([0x00]), // null terminator for mime
    new Uint8Array([0x03]), // picture type: front cover
    new Uint8Array([0x00]), // description (empty) terminator
    imageBytes,
  ]);
  const header = concatBytes([
    asciiBytes("APIC"),
    uint32BE(payload.length),
    new Uint8Array([0x00, 0x00]),
  ]);
  return concatBytes([header, payload]);
}

export interface Id3Meta {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  trackNumber?: string;
  cover?: { bytes: Uint8Array; mime: "image/jpeg" | "image/png" };
}

/**
 * Строит полный ID3v2.3 тег.
 */
export function buildId3v23Tag(meta: Id3Meta): Uint8Array {
  const frames: Uint8Array[] = [];

  if (typeof meta.title === "string" && meta.title.length > 0) {
    frames.push(buildTextFrame("TIT2", meta.title));
  }
  if (typeof meta.artist === "string" && meta.artist.length > 0) {
    frames.push(buildTextFrame("TPE1", meta.artist));
  }
  if (typeof meta.album === "string" && meta.album.length > 0) {
    frames.push(buildTextFrame("TALB", meta.album));
  }
  if (typeof meta.year === "string" && meta.year.length > 0) {
    frames.push(buildTextFrame("TYER", meta.year));
  }
  if (typeof meta.trackNumber === "string" && meta.trackNumber.length > 0) {
    frames.push(buildTextFrame("TRCK", meta.trackNumber));
  }
  if (meta.cover !== undefined) {
    frames.push(buildApicFrame(meta.cover.bytes, meta.cover.mime));
  }

  const framesBlob = concatBytes(frames);

  // ID3 header:
  //   "ID3" + version (2 bytes) + flags (1 byte) + size (4 bytes synchsafe)
  const header = concatBytes([
    asciiBytes("ID3"),
    new Uint8Array([TAG_VERSION_MAJOR, TAG_VERSION_MINOR]),
    new Uint8Array([0x00]), // flags
    synchsafeInt(framesBlob.length),
  ]);

  return concatBytes([header, framesBlob]);
}

/**
 * Скачивает обложку из URL, возвращает байты + mime.
 * Возвращает null если не удалось.
 */
export async function fetchCover(
  coverUri: string,
  size: number = 600,
): Promise<{ bytes: Uint8Array; mime: "image/jpeg" | "image/png" } | null> {
  if (typeof coverUri !== "string" || coverUri.length === 0) return null;
  // Yandex coverUri выглядит как "avatars.yandex.net/get-music-content/...../%%"
  // %% заменяется на размер, например "600x600".
  const url = "https://" + coverUri.replace("%%", `${size}x${size}`);
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const mime: "image/jpeg" | "image/png" = url.toLowerCase().endsWith(".png")
      ? "image/png"
      : "image/jpeg";
    return { bytes, mime };
  } catch {
    return null;
  }
}

/**
 * Склеивает ID3 тег и MP3-данные в один Blob.
 */
export function appendTagToMp3(
  tag: Uint8Array,
  mp3: Uint8Array,
): Uint8Array {
  return concatBytes([tag, mp3]);
}
