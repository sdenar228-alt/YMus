/**
 * Fetch helper that reports byte-level download progress.
 *
 * Reads the response body via `getReader()` and accumulates chunks while
 * invoking `onProgress` every TICK_MS or whenever a chunk completes. The
 * total size is taken from `Content-Length`; if the server doesn't send
 * one, progress falls back to "indeterminate" (caller can treat that as
 * "keep showing pseudo-progress").
 *
 * Returns a Uint8Array of the full body so the existing buildTaggedFile
 * pipeline can consume it byte-for-byte.
 */
const TICK_MS = 100;

export interface FetchWithProgressResult {
  bytes: Uint8Array;
  /** Total length from Content-Length, or -1 if not provided. */
  totalBytes: number;
}

export async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  init?: RequestInit,
): Promise<FetchWithProgressResult> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }

  const lenHeader = resp.headers.get("content-length");
  const totalBytes = lenHeader !== null ? parseInt(lenHeader, 10) : -1;

  // If for any reason there's no body (HTTP 204, etc.) fall back to a
  // single arrayBuffer read — keeps the contract safe.
  if (resp.body === null) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    onProgress?.(buf.length, buf.length);
    return { bytes: buf, totalBytes: buf.length };
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastReport = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;

    // Throttle progress callbacks to TICK_MS so we don't flood the
    // message bus when chunks arrive rapidly (HTTP/2 frames every ~5ms).
    const now = performance.now();
    if (now - lastReport >= TICK_MS) {
      lastReport = now;
      onProgress?.(received, totalBytes);
    }
  }

  // Final report (always — even if we throttled the last partial tick).
  onProgress?.(received, totalBytes);

  // Stitch chunks into a single Uint8Array. Done up-front so the rest of
  // the pipeline keeps using a contiguous byte buffer.
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return { bytes: out, totalBytes };
}
