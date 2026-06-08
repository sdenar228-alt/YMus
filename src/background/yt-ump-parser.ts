// UMP framing + Protocol Buffers varint readers used by the SABR
// downloader. Ported byte-for-byte from the legacy 22 May build
// (`YMus/yt-page-bridge.js` + `yt-sabr-downloader.ts`) so the SABR
// replay flow has identical parsing semantics.

/** Single UMP part returned by `parseUmpParts`. */
export interface UmpPart {
  type: number;
  data: Uint8Array;
}

/**
 * Read a UMP varint at `offset`. UMP uses a 1–5 byte length prefix encoded
 * in the high bits of the first byte (similar to UTF-8).
 *
 * Returns `[value, bytesConsumed]`. `[0, 0]` when the buffer is truncated
 * mid-varint. `[0, 1]` when the first byte's high bits are illegal — the
 * caller advances 1 byte and keeps walking instead of throwing.
 */
export function readUmpVarInt(buf: Uint8Array, offset: number): [number, number] {
  if (offset >= buf.byteLength) return [0, offset];
  const b0 = buf[offset];
  let extraBytes: number;
  if (b0 < 0x80) extraBytes = 0;
  else if (b0 < 0xc0) extraBytes = 1;
  else if (b0 < 0xe0) extraBytes = 2;
  else if (b0 < 0xf0) extraBytes = 3;
  else if (b0 < 0xf8) extraBytes = 4;
  else return [0, offset];
  if (offset + extraBytes + 1 > buf.byteLength) return [0, offset];
  let value: number;
  if (extraBytes === 0) {
    value = b0 & 0x7f;
  } else if (extraBytes === 1) {
    value = (buf[offset + 1] << 6) | (b0 & 0x3f);
  } else if (extraBytes === 2) {
    value = ((buf[offset + 1] | (buf[offset + 2] << 8)) << 5) | (b0 & 0x1f);
  } else if (extraBytes === 3) {
    value =
      ((buf[offset + 1] |
        (buf[offset + 2] << 8) |
        (buf[offset + 3] << 16)) <<
        4) |
      (b0 & 0x0f);
  } else {
    value =
      (buf[offset + 1] |
        (buf[offset + 2] << 8) |
        (buf[offset + 3] << 16) |
        (buf[offset + 4] << 24)) >>>
      0;
  }
  return [value, offset + extraBytes + 1];
}

/**
 * Read a Protocol Buffers varint (7-bit continuation) at `offset`.
 * Returns `[value, newOffset]`. The reader is capped at 10 continuation
 * bytes so a malformed body cannot loop forever.
 *
 * Note: this implementation handles 64-bit values by splitting the result
 * into low/high halves and reassembling as a JS number — the legacy
 * `yt-sabr-downloader` uses this for fields like `tfdt.baseMediaDecodeTime`
 * where values can exceed 2^32 for long videos.
 */
export function readProtoVarInt(buf: Uint8Array, offset: number): [number, number] {
  let resultLow = 0;
  let resultHigh = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset < buf.byteLength && bytesRead < 10) {
    const b = buf[offset++];
    bytesRead++;
    if (shift < 28) {
      resultLow |= (b & 0x7f) << shift;
    } else if (shift < 32) {
      resultLow |= (b & 0x7f) << shift;
      resultHigh |= (b & 0x7f) >>> (32 - shift);
    } else {
      resultHigh |= (b & 0x7f) << (shift - 32);
    }
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  const low = resultLow >>> 0;
  const high = resultHigh >>> 0;
  return [high * 0x1_0000_0000 + low, offset];
}

/**
 * Parse a YouTube UMP byte stream into a flat list of typed parts.
 *
 * UMP framing:
 *   - frame `type`: UMP varint
 *   - frame `size`: UMP varint
 *   - payload:      `size` bytes
 *
 * Frame types stay below 200 in practice; bail when the type is out of
 * range or the body is truncated mid-frame to keep the walk safe against
 * garbage / partial responses.
 */
export function parseUmpParts(buf: Uint8Array): UmpPart[] {
  const parts: UmpPart[] = [];
  let offset = 0;
  while (offset < buf.byteLength - 1) {
    const [type, typeBytes] = readUmpVarInt(buf, offset);
    if (type > 200 || typeBytes === offset) break;
    const consumedType = typeBytes - offset;
    if (consumedType <= 0) break;
    offset = typeBytes;
    if (offset >= buf.byteLength) break;
    const [size, sizeOff] = readUmpVarInt(buf, offset);
    if (sizeOff === offset) break;
    offset = sizeOff;
    const remaining = buf.byteLength - offset;
    const actualSize = Math.min(size, remaining);
    const data = buf.subarray(offset, offset + actualSize);
    offset += actualSize;
    parts.push({ type, data });
    if (size > remaining) break;
  }
  return parts;
}
