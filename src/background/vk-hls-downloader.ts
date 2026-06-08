/**
 * HLS downloader for VK audio with per-segment AES-128 decryption.
 * VK uses alternating encrypted/unencrypted segments.
 *
 * Pipeline (no longer "fetch-all → decrypt-all → demux-all"):
 *   For each segment we run fetch → decrypt → demux as soon as the previous
 *   stage of the SAME segment finishes. Independent segments run in parallel
 *   (concurrency-bounded). The final concat happens once all segments have
 *   completed all stages.
 *
 * Cross-track throttling: when multiple tracks are downloaded in parallel
 * (playlist mode), each track grabbing its own pool of N parallel fetches
 * multiplies into N×K simultaneous requests. VK's CDN starts throttling
 * around 30+ parallel streams to one host, doubling per-track latency.
 * We solve this with a GLOBAL semaphore — all tracks share one pool of
 * MAX_GLOBAL_FETCHES inflight requests, no matter how many tracks call
 * downloadVkHlsTrack concurrently.
 *
 * Performance ceiling: VK CDN enforces a per-flow rate limit of ~400 KiB/s
 * and a per-host aggregate cap. Range requests are NOT honored (probed
 * empirically: returns 200 instead of 206). This means the practical floor
 * for a 10 MiB track is around 5-7 seconds and there is no way to push it
 * lower from the client side.
 */

interface SegmentInfo {
  url: string;
  encrypted: boolean;
  keyUrl: string | null;
}

/** Per-track fetch fan-out. concurrency=6 is the empirical sweet spot. */
const SEGMENT_FETCH_CONCURRENCY = 6;
/** Global ceiling across ALL inflight fetches in this background. */
const MAX_GLOBAL_FETCHES = 16;
/** Cap on tracks downloading SIMULTANEOUSLY at the HLS layer. */
const MAX_PARALLEL_TRACKS = 2;
/** Per-segment slow-request retry threshold. Aborts and retries; if both
 * timed attempts fail, a final no-timeout attempt is made. */
const SLOW_SEGMENT_TIMEOUT_MS = 4000;

/** Tiny FIFO semaphore — `acquire()` resolves when a slot frees up. */
class Semaphore {
  private inflight = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly capacity: number) {}
  /** Returns release-fn AND the time spent waiting in the queue (ms). */
  async acquire(): Promise<{ release: () => void; waitMs: number }> {
    const t = performance.now();
    if (this.inflight < this.capacity) {
      this.inflight++;
      return { release: () => this.release(), waitMs: 0 };
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inflight++;
    return { release: () => this.release(), waitMs: performance.now() - t };
  }
  private release(): void {
    this.inflight--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const fetchSemaphore = new Semaphore(MAX_GLOBAL_FETCHES);
const trackSemaphore = new Semaphore(MAX_PARALLEL_TRACKS);

async function semFetch(url: string, init?: RequestInit): Promise<{ resp: Response; waitMs: number }> {
  const { release, waitMs } = await fetchSemaphore.acquire();
  try {
    const resp = await fetch(url, init);
    return { resp, waitMs };
  } finally {
    release();
  }
}

/**
 * Module-level AES key cache. VK reuses the same AES-128 key across many
 * tracks within one session, so re-fetching + re-importing per track wastes
 * an extra fetch + a WebCrypto importKey call (≈100–300 ms each time).
 * The cache is keyed by the absolute key URL.
 */
const keyCache = new Map<string, Promise<CryptoKey>>();

async function getAesKey(keyUrl: string): Promise<CryptoKey> {
  let cached = keyCache.get(keyUrl);
  if (cached) return cached;
  cached = (async () => {
    const { resp } = await semFetch(keyUrl);
    if (!resp.ok) {
      keyCache.delete(keyUrl);
      throw new Error(`Key fetch failed: ${resp.status}`);
    }
    const buf = await resp.arrayBuffer();
    return crypto.subtle.importKey("raw", buf, { name: "AES-CBC" }, false, ["decrypt"]);
  })();
  keyCache.set(keyUrl, cached);
  // If the import fails, drop the cache entry so the next caller retries.
  cached.catch(() => keyCache.delete(keyUrl));
  return cached;
}

/**
 * Download VK HLS track — handles mixed encrypted/unencrypted segments.
 * Returns { audioDataB64, strategy } for use by message-router.
 *
 * Wrapped in trackSemaphore so multiple parallel calls don't all hit VK's
 * CDN at once and trip the per-origin rate limiter.
 *
 * @param onProgress  Optional callback invoked as segments complete; receives
 *                    a value in [0..100]. Use it to drive download UI.
 */
export async function downloadVkHlsTrack(
  m3u8Url: string,
  _filename: string,
  onProgress?: (percent: number) => void,
): Promise<{ audioDataB64: string; strategy: "hls_demux" }> {
  const { release } = await trackSemaphore.acquire();
  try {
    const buffer = await downloadHlsSegments(m3u8Url, onProgress);
    onProgress?.(98); // base64 encoding still ahead
    const base64 = arrayBufferToBase64(buffer);
    onProgress?.(100);
    return { audioDataB64: base64, strategy: "hls_demux" };
  } finally {
    release();
  }
}

/**
 * Download and concatenate HLS segments. Pipelined: fetch → decrypt → demux
 * happen as soon as inputs are ready, no full-pass barriers.
 */
async function downloadHlsSegments(
  m3u8Url: string,
  onProgress?: (percent: number) => void,
): Promise<ArrayBuffer> {
  const tStart = performance.now();
  let queueWaitTotal = 0;

  // 1. Fetch manifest
  const { resp } = await semFetch(m3u8Url);
  if (!resp.ok) throw new Error(`Manifest fetch failed: ${resp.status}`);
  const manifest = await resp.text();
  onProgress?.(2);

  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);

  // 2. Parse segments with per-segment encryption info
  const segments = parseM3u8Segments(manifest, baseUrl);
  if (segments.length === 0) throw new Error("No segments");

  // 3. Pre-compute encrypted-segment indices (needed for IV per segment).
  const encryptedIvIndex = new Array<number>(segments.length);
  let encCounter = 0;
  for (let i = 0; i < segments.length; i++) {
    encryptedIvIndex[i] = segments[i].encrypted ? encCounter++ : -1;
  }

  // 4. Resolve the AES key once (cached across tracks within the session).
  let cryptoKey: CryptoKey | null = null;
  const keyUrl = segments.find(s => s.encrypted)?.keyUrl ?? null;
  if (keyUrl) {
    try {
      cryptoKey = await getAesKey(keyUrl);
    } catch (e) {
      console.warn("[ymd][hls] key fetch failed:", e);
    }
  }
  onProgress?.(5);

  // 5. Pipeline: each segment task does fetch → decrypt → demux end-to-end.
  // Segment results are stored at their original index so the final concat
  // preserves audio order.
  const processed = new Array<ArrayBuffer>(segments.length);
  let completedSegments = 0;
  // Reserve 5–95% of the progress bar for the segment phase so the early
  // manifest/key resolution and the trailing base64 step also have room.
  const reportSegmentDone = () => {
    completedSegments++;
    const pct = 5 + Math.round((completedSegments / segments.length) * 90);
    onProgress?.(Math.min(95, pct));
  };

  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= segments.length) return;

      const seg = segments[i];

      // fetch through the global semaphore with timed retry. Aborts are
      // RECOVERABLE: after 2 timed attempts we make a final no-timeout
      // attempt. Only a real network/HTTP error past that bubbles up.
      let segData: ArrayBuffer | null = null;
      let waitMs = 0;
      const MAX_TIMED_ATTEMPTS = 2;
      let attempt = 0;
      let lastErr: unknown = null;
      while (attempt < MAX_TIMED_ATTEMPTS && segData === null) {
        attempt++;
        const ac = new AbortController();
        const slowTimer = setTimeout(() => ac.abort(), SLOW_SEGMENT_TIMEOUT_MS);
        try {
          const { resp: segResp, waitMs: w } = await semFetch(seg.url, { signal: ac.signal });
          waitMs = w;
          if (!segResp.ok) {
            clearTimeout(slowTimer);
            lastErr = new Error(`Segment ${i} HTTP ${segResp.status}`);
            await new Promise(r => setTimeout(r, 150));
            continue;
          }
          segData = await segResp.arrayBuffer();
          clearTimeout(slowTimer);
        } catch (err) {
          clearTimeout(slowTimer);
          lastErr = err;
          await new Promise(r => setTimeout(r, 100));
        }
      }
      if (segData === null) {
        // Final unconditional attempt — slow but correct.
        const { resp: segResp, waitMs: w } = await semFetch(seg.url);
        waitMs = w;
        if (!segResp.ok) throw lastErr ?? new Error(`Segment ${i} failed: ${segResp.status}`);
        segData = await segResp.arrayBuffer();
      }
      queueWaitTotal += waitMs;

      // decrypt (independent across segments — each has its own IV)
      if (seg.encrypted && cryptoKey) {
        const iv = sequenceToIv(encryptedIvIndex[i]);
        try {
          segData = await crypto.subtle.decrypt(
            { name: "AES-CBC", iv }, cryptoKey, segData,
          );
        } catch {
          // If decrypt fails, keep the raw bytes
        }
      }

      // demux MPEG-TS in place if needed
      const view = new Uint8Array(segData);
      if (view.length >= 188 && view[0] === 0x47) {
        const audio = demuxTsAudio(view);
        processed[i] = audio.length > 100 ? (audio.buffer as ArrayBuffer) : segData;
      } else {
        processed[i] = segData;
      }

      reportSegmentDone();
    }
  }

  const workers: Promise<void>[] = [];
  const poolSize = Math.min(SEGMENT_FETCH_CONCURRENCY, segments.length);
  for (let w = 0; w < poolSize; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // 6. Concatenate in original order
  const totalSize = processed.reduce((sum, c) => sum + c.byteLength, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of processed) {
    result.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }

  const total = performance.now() - tStart;
  const avgQueueWait = queueWaitTotal / segments.length;
  console.log(
    `[ymd][hls] ${segments.length} segs → ${(totalSize / 1024).toFixed(0)} KiB in ${total.toFixed(0)}ms (queueWaitAvg=${avgQueueWait.toFixed(0)}ms, c=${poolSize})`,
  );

  return result.buffer;
}

/**
 * Parse m3u8 with per-segment encryption tracking.
 */
function parseM3u8Segments(manifest: string, baseUrl: string): SegmentInfo[] {
  const lines = manifest.split("\n");
  const segments: SegmentInfo[] = [];

  let currentEncrypted = false;
  let currentKeyUrl: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("#EXT-X-KEY:")) {
      const methodMatch = trimmed.match(/METHOD=([^,]+)/);
      const method = methodMatch?.[1] || "NONE";

      if (method === "NONE") {
        currentEncrypted = false;
        currentKeyUrl = null;
      } else if (method === "AES-128") {
        currentEncrypted = true;
        const uriMatch = trimmed.match(/URI="([^"]+)"/);
        currentKeyUrl = uriMatch ? (uriMatch[1].startsWith("http") ? uriMatch[1] : baseUrl + uriMatch[1]) : null;
      }
      continue;
    }

    // Skip other comments/tags
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Segment URL
    const url = trimmed.startsWith("http") ? trimmed : baseUrl + trimmed;
    segments.push({ url, encrypted: currentEncrypted, keyUrl: currentKeyUrl });
  }

  return segments;
}

function sequenceToIv(seq: number): ArrayBuffer {
  const iv = new ArrayBuffer(16);
  new DataView(iv).setUint32(12, seq, false);
  return iv;
}

/**
 * Convert ArrayBuffer → base64 in chunks. Doing
 *   String.fromCharCode(...new Uint8Array(buffer))
 * for a 4–8 MiB buffer either blows the call-stack or stalls the main
 * thread for hundreds of milliseconds. 32-KiB chunks keep memory bounded
 * and execution time under ~50 ms even on slow CPUs.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // 32 KiB
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    // String.fromCharCode.apply tolerates a Uint8Array as the second arg
    // because it has indexed access and length. This is the standard fast
    // pattern for converting binary → base64 in browser JS.
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Demux MPEG-TS — extract audio elementary stream.
 * Strategy: find PID whose PES payload starts with ADTS sync (0xFFF) or MP3 sync (0xFFE/0xFFF),
 * then extract all payloads from that PID.
 */
function demuxTsAudio(data: Uint8Array): Uint8Array {
  const TS = 188;
  if (data.length < TS) return new Uint8Array(0);

  // Step 1: Find audio PID by scanning first PES start in each PID
  const pidPayloads = new Map<number, number[]>(); // pid → list of packet offsets
  let audioPid = -1;

  for (let i = 0; i <= data.length - TS; i += TS) {
    if (data[i] !== 0x47) continue;
    const pid = ((data[i + 1] & 0x1F) << 8) | data[i + 2];
    if (pid === 0 || pid === 0x1FFF) continue; // PAT or null

    if (!pidPayloads.has(pid)) pidPayloads.set(pid, []);
    pidPayloads.get(pid)!.push(i);

    // Check if this packet has PES start with audio sync
    if (audioPid < 0 && (data[i + 1] & 0x40)) { // payload_unit_start
      const hasAdapt = (data[i + 3] & 0x20) !== 0;
      const hasPayload = (data[i + 3] & 0x10) !== 0;
      if (!hasPayload) continue;
      
      let off = i + 4 + (hasAdapt ? 1 + data[i + 4] : 0);
      // Skip PES header: 00 00 01 XX ...
      if (off + 9 < i + TS && data[off] === 0 && data[off+1] === 0 && data[off+2] === 1) {
        const streamId = data[off + 3];
        if (streamId >= 0xC0 && streamId <= 0xDF || streamId === 0xBD) {
          const pesHdrLen = data[off + 8];
          const audioStart = off + 9 + pesHdrLen;
          // Check for ADTS sync (0xFFF) or MP3 sync (0xFFE+)
          if (audioStart + 1 < i + TS) {
            const b0 = data[audioStart];
            const b1 = data[audioStart + 1];
            if (b0 === 0xFF && (b1 & 0xE0) === 0xE0) {
              audioPid = pid;
            }
          }
        }
      }
    }
  }

  if (audioPid < 0) {
    // Fallback: use first non-PAT/PMT PID with most packets
    let maxPid = -1, maxCount = 0;
    for (const [pid, packets] of pidPayloads) {
      if (pid <= 0x1F) continue; // skip PAT/PMT range
      if (packets.length > maxCount) { maxCount = packets.length; maxPid = pid; }
    }
    audioPid = maxPid;
  }
  if (audioPid < 0) {
    console.log("[ymd][hls] demux: no audio PID found");
    return new Uint8Array(0);
  }
  console.log(`[ymd][hls] demux: using audio PID=${audioPid}`);

  // Step 2: Extract PES payloads from audioPid
  const audioChunks: Uint8Array[] = [];
  for (let i = 0; i <= data.length - TS; i += TS) {
    if (data[i] !== 0x47) continue;
    const pid = ((data[i + 1] & 0x1F) << 8) | data[i + 2];
    if (pid !== audioPid) continue;
    if (!(data[i + 3] & 0x10)) continue; // no payload

    const hasAdapt = (data[i + 3] & 0x20) !== 0;
    let off = i + 4 + (hasAdapt ? 1 + data[i + 4] : 0);
    if (off >= i + TS) continue;

    // If payload_unit_start, skip PES header
    if (data[i + 1] & 0x40) {
      if (off + 9 <= i + TS && data[off] === 0 && data[off+1] === 0 && data[off+2] === 1) {
        const pesHdrLen = data[off + 8];
        off += 9 + pesHdrLen;
      }
    }

    if (off < i + TS) {
      audioChunks.push(data.slice(off, i + TS));
    }
  }

  const total = audioChunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of audioChunks) { result.set(c, offset); offset += c.length; }
  return result;
}
