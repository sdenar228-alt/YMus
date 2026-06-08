// WAV LIST/INFO metadata writer — строит LIST/INFO чанк с текстовыми
// метаданными и собирает полный WAV-файл из PCM-данных.
//
// Поддерживаемые суб-чанки:
//   IART — исполнитель
//   INAM — название трека
//   IPRD — альбом
//   ICRD — год
//   ITRK — номер трека
//
// WAV LIST/INFO не поддерживает обложки — это ограничение формата.
// Все числа записываются в little-endian (стандарт RIFF).

export interface WavMeta {
  artist?: string;
  title?: string;
  album?: string;
  year?: string;
  trackNumber?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Encode string as null-terminated UTF-8 bytes, padded to even length. */
function nullTerminatedUtf8(s: string): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(s);
  // +1 for null terminator, then pad to even length
  const withNull = encoded.length + 1;
  const padded = withNull % 2 === 0 ? withNull : withNull + 1;
  const out = new Uint8Array(padded);
  out.set(encoded, 0);
  // remaining bytes are already 0 (null terminator + optional pad byte)
  return out;
}

/** Write a 32-bit unsigned integer in little-endian. */
function uint32LE(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

/** Write a 16-bit unsigned integer in little-endian. */
function uint16LE(n: number): Uint8Array {
  const out = new Uint8Array(2);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  return out;
}

// ─── Sub-chunk builder ────────────────────────────────────────────────────────

/**
 * Build a single INFO sub-chunk: 4-char ID + 4-byte size + null-terminated string.
 * Size field = length of the null-terminated (and padded) string data.
 */
function buildInfoSubChunk(chunkId: string, value: string): Uint8Array {
  const data = nullTerminatedUtf8(value);
  return concatBytes([
    asciiBytes(chunkId),  // 4 bytes
    uint32LE(data.length), // size of data (including null + pad)
    data,
  ]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a LIST/INFO chunk containing text metadata fields.
 * Returns the chunk bytes, or an empty Uint8Array if all fields are empty.
 */
export function buildWavListInfoChunk(meta: WavMeta): Uint8Array {
  const subChunks: Uint8Array[] = [];

  if (meta.artist && meta.artist.length > 0) {
    subChunks.push(buildInfoSubChunk("IART", meta.artist));
  }
  if (meta.title && meta.title.length > 0) {
    subChunks.push(buildInfoSubChunk("INAM", meta.title));
  }
  if (meta.album && meta.album.length > 0) {
    subChunks.push(buildInfoSubChunk("IPRD", meta.album));
  }
  if (meta.year && meta.year.length > 0) {
    subChunks.push(buildInfoSubChunk("ICRD", meta.year));
  }
  if (meta.trackNumber && meta.trackNumber.length > 0) {
    subChunks.push(buildInfoSubChunk("ITRK", meta.trackNumber));
  }

  if (subChunks.length === 0) {
    return new Uint8Array(0);
  }

  const infoType = asciiBytes("INFO");
  const subChunksBlob = concatBytes(subChunks);

  // LIST chunk: "LIST" + size (4 bytes) + "INFO" + sub-chunks
  // size = 4 (for "INFO") + sub-chunks total length
  const listSize = 4 + subChunksBlob.length;

  return concatBytes([
    asciiBytes("LIST"),
    uint32LE(listSize),
    infoType,
    subChunksBlob,
  ]);
}

/**
 * Build a complete WAV file from PCM data with optional LIST/INFO metadata.
 * Produces a valid 44-byte RIFF header + PCM data + optional LIST/INFO chunk.
 *
 * @param pcmData - Raw PCM sample bytes (interleaved channels, little-endian)
 * @param sampleRate - Sample rate in Hz (e.g. 44100)
 * @param channels - Number of audio channels (1 = mono, 2 = stereo)
 * @param bitsPerSample - Bits per sample (always 16)
 * @param meta - Optional metadata to embed as LIST/INFO chunk
 */
export function buildWavFile(
  pcmData: Uint8Array,
  sampleRate: number,
  channels: number,
  bitsPerSample: 16,
  meta?: WavMeta,
): Uint8Array {
  const listInfoChunk = meta ? buildWavListInfoChunk(meta) : new Uint8Array(0);

  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  // Total file size = 4 ("WAVE") + fmt chunk (24) + data chunk header (8) + pcmData + listInfo
  // RIFF size field = fileSize - 8 (excludes "RIFF" + size field itself)
  const dataChunkSize = pcmData.length;
  const riffSize = 4 + 24 + 8 + dataChunkSize + listInfoChunk.length;

  // ─── RIFF header (12 bytes) ─────────────────────────────────────────────────
  const riffHeader = concatBytes([
    asciiBytes("RIFF"),       // ChunkID
    uint32LE(riffSize),       // ChunkSize (file size - 8)
    asciiBytes("WAVE"),       // Format
  ]);

  // ─── fmt sub-chunk (24 bytes) ───────────────────────────────────────────────
  const fmtChunk = concatBytes([
    asciiBytes("fmt "),       // Subchunk1ID
    uint32LE(16),             // Subchunk1Size (16 for PCM)
    uint16LE(1),              // AudioFormat (1 = PCM)
    uint16LE(channels),       // NumChannels
    uint32LE(sampleRate),     // SampleRate
    uint32LE(byteRate),       // ByteRate
    uint16LE(blockAlign),     // BlockAlign
    uint16LE(bitsPerSample),  // BitsPerSample
  ]);

  // ─── data sub-chunk (8 + N bytes) ──────────────────────────────────────────
  const dataChunkHeader = concatBytes([
    asciiBytes("data"),       // Subchunk2ID
    uint32LE(dataChunkSize),  // Subchunk2Size
  ]);

  return concatBytes([
    riffHeader,
    fmtChunk,
    dataChunkHeader,
    pcmData,
    listInfoChunk,
  ]);
}
