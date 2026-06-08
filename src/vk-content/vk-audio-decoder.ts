/**
 * VK Audio URL decoder.
 * Decodes encrypted audio URLs from VK's audio_api_unavailable format.
 * Algorithm reverse-engineered from VK's core_spa bundle.
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=";

function base64Decode(e: string): string | false {
  if (!e || e.length % 4 === 1) return false;
  let t: number;
  let n: string;
  let r = 0;
  let o = 0;
  let a = "";
  for (; (n = e.charAt(o++)); ) {
    const idx = ALPHABET.indexOf(n);
    if (~idx) {
      t = r % 4 ? 64 * t! + idx : idx;
      if (r++ % 4) {
        a += String.fromCharCode(255 & (t! >> ((-2 * r) & 6)));
      }
    }
  }
  return a;
}

const ops: Record<string, (...args: string[]) => string> = {
  v(e: string): string {
    return e.split("").reverse().join("");
  },

  r(e: string, t: string): string {
    const chars = e.split("");
    const doubled = ALPHABET + ALPHABET;
    const shift = parseInt(t, 10) || 0;
    let i = chars.length;
    for (; i--; ) {
      const idx = doubled.indexOf(chars[i]);
      if (~idx) {
        chars[i] = doubled.substr(idx - shift, 1);
      }
    }
    return chars.join("");
  },

  s(e: string, t: string): string {
    const n = e.length;
    if (n) {
      const tNum = BigInt(t);
      const indices = generateIndicesBigInt(tNum, n);
      const chars = e.split("");
      let o = 0;
      for (; ++o < n; ) {
        chars[o] = chars.splice(indices[n - 1 - o], 1, chars[o])[0];
      }
      return chars.join("");
    }
    return e;
  },

  i(e: string, t: string, vkId: number): string {
    const n = BigInt(parseInt(t, 10) || 0);
    const r = BigInt(vkId) ^ n;
    return ops.s(e, r.toString());
  },

  x(e: string, t: string): string {
    const charCode = t.charCodeAt(0);
    return e
      .split("")
      .map((ch) => String.fromCharCode(ch.charCodeAt(0) ^ charCode))
      .join("");
  },
};

function generateIndicesBigInt(seed: bigint, length: number): number[] {
  const result = new Array(length);
  if (length === 0) return result;
  const len = BigInt(length);
  if (seed < 0n) seed = -seed;
  for (let o = length - 1; o >= 0; o--) {
    const oBig = BigInt(o);
    seed = ((len * BigInt(o + 1)) ^ (seed + oBig)) % len;
    result[o] = Number(seed);
  }
  return result;
}

/**
 * Decode a VK encrypted audio URL.
 * @param encodedUrl - URL in format "https://vk.com/mp3/audio_api_unavailable.mp3?extra=...#..."
 * @param vkUserId - Current user's VK ID (needed for XOR operations)
 * @returns Decoded direct URL (https://...vkuseraudio.net/.../index.m3u8) or null on failure
 */
export function decodeVkAudioUrl(encodedUrl: string, vkUserId: number): string | null {
  if (!encodedUrl || !encodedUrl.includes("audio_api_unavailable")) {
    // Already a direct URL or empty
    if (encodedUrl && encodedUrl.startsWith("https://")) return encodedUrl;
    return null;
  }

  try {
    const parts = encodedUrl.split("?extra=")[1].split("#");
    const instructionsEncoded = parts[1] === "" ? "" : base64Decode(parts[1]);
    const dataDecoded = base64Decode(parts[0]);

    if (typeof instructionsEncoded !== "string" || !dataDecoded) return null;

    const instructions = instructionsEncoded
      ? instructionsEncoded.split(String.fromCharCode(9))
      : [];

    let result: string = dataDecoded;
    let i = instructions.length;

    for (; i--; ) {
      const parts = instructions[i].split(String.fromCharCode(11));
      const opName = parts.splice(0, 1, result)[0];

      if (!ops[opName]) return null;

      if (opName === "i") {
        // 'i' operation needs vkUserId as third arg
        result = ops.i(parts[0], parts[1] || "0", vkUserId);
      } else {
        result = (ops[opName] as (...args: string[]) => string).apply(null, parts);
      }
    }

    if (result && result.startsWith("http")) return result;
  } catch {
    // Decode failed
  }

  return null;
}
