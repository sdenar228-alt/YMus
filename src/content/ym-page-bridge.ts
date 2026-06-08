/**
 * Yandex Music page bridge.
 *
 * Runs in MAIN world at document_start so it can hook the page's `fetch`
 * and `XMLHttpRequest` BEFORE the SPA bundle starts loading. Whenever the
 * page asks Yandex Music's backend about the currently playing track —
 * via /handlers/track.jsx, /handlers/playaudio.jsx,
 * /api/v2.1/handlers/rotor/..., or download-info — we extract the trackId
 * (and, where possible, artist/title) and post a message to the
 * isolated-world content script so it can use those values directly,
 * without scraping the DOM.
 *
 * Why we need this: the 2026 redesign of "Моя волна" no longer renders
 * any /track/{id} link in the DOM, doesn't update og:title, and doesn't
 * expose externalAPI on window. Network traffic is the only reliable
 * signal that survives those changes — the player still has to fetch
 * track info to play it.
 */

const TAG = "[YMus YM Bridge]";
const SOURCE = "ymd-bridge";

type TrackDetectionSource = "playback" | "metadata" | "prefetch";

interface DetectedTrack {
  trackId: string;
  albumId?: string;
  artist?: string;
  title?: string;
  detectionSource?: TrackDetectionSource;
}

// Most-recently-detected now-playing track. Stored at module scope so we can
// resend it whenever the content script asks (it loads later than this bridge,
// so it might miss the first event). We intentionally keep prefetches out of
// this slot on wave pages: Yandex Music asks for the next track's download-info
// before it starts playing, and that must not replace the current track.
let lastTrack: DetectedTrack | null = null;
let lastPrefetchTrack: DetectedTrack | null = null;

function isWaveMode(): boolean {
  try {
    return new URL(location.href).searchParams.has("wave");
  } catch {
    return false;
  }
}

function shouldPromoteTrack(track: DetectedTrack): boolean {
  if (track.detectionSource === "playback") return true;
  if (track.detectionSource === "metadata") return true;
  if (track.detectionSource === "prefetch") {
    lastPrefetchTrack = track;
    return !isWaveMode() && lastTrack === null;
  }
  return true;
}

function postTrack(track: DetectedTrack | null): void {
  if (!track) return;
  if (shouldPromoteTrack(track)) {
    lastTrack = track;
  }
  try {
    window.postMessage(
      {
        source: SOURCE,
        action: "TRACK_DETECTED",
        trackId: lastTrack?.trackId ?? track.trackId,
        albumId: lastTrack?.albumId ?? track.albumId,
        artist: lastTrack?.artist ?? track.artist,
        title: lastTrack?.title ?? track.title,
        detectionSource: lastTrack?.detectionSource ?? track.detectionSource,
      },
      "*",
    );
  } catch { /* ignore */ }
}

/**
 * Extract `trackId` from any URL Yandex Music uses to talk to its API.
 * Recognised shapes (the path is what matters; the host is always one of
 * music.yandex.ru / api.music.yandex.net / api.music.yandex.ru):
 *   /handlers/track.jsx?track=<id>:<album>           → '<id>:<album>'
 *   /handlers/track.jsx?track=<id>                   → '<id>'
 *   /handlers/playaudio?from=...&track-id=<id>       → '<id>'
 *   /tracks/<id>/download-info                       → '<id>'
 *   /tracks/<id>                                     → '<id>'
 *   /api/v2.1/handlers/track/<id>:<album>/...        → '<id>:<album>'
 *   /api/v2.1/handlers/track/<id>/...                → '<id>'
 *   /get-file-info/batch?...&trackIds=<id>           → '<id>'   (2026 redesign)
 *   /get-file-info?...&track=<id>                    → '<id>'
 */
function extractTrackIdFromUrl(rawUrl: string): DetectedTrack | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, location.origin);
  } catch {
    return null;
  }
  const path = parsed.pathname;

  // /tracks/<id>(/download-info)?
  const m1 = path.match(/\/tracks\/(\d+)(?:\/|$)/);
  if (m1) {
    return {
      trackId: m1[1],
      detectionSource: path.includes("/download-info") ? "prefetch" : "metadata",
    };
  }

  // /api/v2.1/handlers/track/<id>(:<album>)?(/...)?
  const m2 = path.match(/\/handlers\/track\/(\d+)(?::(\d+))?/);
  if (m2) return { trackId: m2[1], albumId: m2[2], detectionSource: "metadata" };

  // /handlers/track.jsx?track=<id>(:<album>)?
  if (path.endsWith("/handlers/track.jsx") || path.endsWith("/track.jsx")) {
    const t = parsed.searchParams.get("track");
    if (t) {
      const [id, album] = t.split(":");
      if (/^\d+$/.test(id)) return { trackId: id, albumId: album, detectionSource: "metadata" };
    }
  }

  // /handlers/playaudio.jsx?...&track-id=<id>&album-id=<album>&...
  if (path.endsWith("/playaudio") || path.endsWith("/playaudio.jsx") || path.includes("/handlers/playaudio")) {
    const id = parsed.searchParams.get("track-id");
    const album = parsed.searchParams.get("album-id") ?? undefined;
    if (id && /^\d+$/.test(id)) return { trackId: id, albumId: album, detectionSource: "playback" };
  }

  // /get-file-info/batch?...&trackIds=<id>(,<id>)*
  // and /get-file-info?...&track=<id>
  // (api.music.yandex.ru — used by the 2026 "Моя волна" redesign).
  if (path.includes("/get-file-info")) {
    // batch variant — comma-separated list, take the first id.
    const batchIds = parsed.searchParams.get("trackIds");
    if (batchIds) {
      const first = batchIds.split(",")[0]?.trim();
      if (first && /^\d+$/.test(first)) return { trackId: first, detectionSource: "prefetch" };
    }
    // single-track variant
    const single = parsed.searchParams.get("trackId") ?? parsed.searchParams.get("track");
    if (single && /^\d+$/.test(single)) return { trackId: single, detectionSource: "prefetch" };
  }

  return null;
}

/**
 * Try to enrich a partial track record with artist/title pulled from a
 * JSON response body (when YM returns the full track DTO).
 *
 * Also recognises the `downloadInfos[]` shape used by /get-file-info/batch
 * — which doesn't carry artist/title, but does have `trackId`. If we got
 * here without one (e.g. URL parsing missed), pull it from there.
 */
function enrichFromResponseJson(json: unknown, base: DetectedTrack): DetectedTrack {
  if (!json || typeof json !== "object") return base;
  const obj = json as Record<string, unknown>;

  // /get-file-info/batch shape: { downloadInfos: [{ trackId, ... }, ...] }
  // Doesn't include artist/title, but the top-level trackId is always
  // already in the request URL — so we just pass `base` through.
  if (Array.isArray(obj.downloadInfos)) {
    return base;
  }

  // Top-level shapes vary: { track: {...} }, [{ id, ... }], or {... directly}.
  const candidate = (obj.track as Record<string, unknown> | undefined)
    ?? (Array.isArray(obj) && obj.length > 0 ? (obj[0] as Record<string, unknown>) : undefined)
    ?? obj;

  let title: string | undefined;
  let artist: string | undefined;

  const t = candidate?.title;
  if (typeof t === "string" && t.length > 0) title = t;

  const artists = candidate?.artists;
  if (Array.isArray(artists) && artists.length > 0) {
    const names = artists
      .map((a) => (a as Record<string, unknown>)?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    if (names.length > 0) artist = names.join(", ");
  }

  return { ...base, title, artist };
}

// ─── fetch hook ──────────────────────────────────────────────────────────────

const origFetch = window.fetch;
window.fetch = async function patchedFetch(...args) {
  const resp = await origFetch.apply(this, args as Parameters<typeof fetch>);
  try {
    const url = typeof args[0] === "string"
      ? args[0]
      : args[0] instanceof Request
        ? args[0].url
        : (args[0] as URL).toString();

    const fromUrl = extractTrackIdFromUrl(url);
    if (fromUrl) {
      // Try to enrich with the response body — but only for JSON, and
      // only by cloning so we don't disturb the page's own consumer of
      // the response.
      let enriched = fromUrl as typeof lastTrack;
      try {
        const ct = resp.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const json = await resp.clone().json();
          enriched = enrichFromResponseJson(json, fromUrl);
        }
      } catch { /* ignore — keep fromUrl */ }
      postTrack(enriched);
    }
  } catch { /* ignore — never break the page's fetch */ }
  return resp;
};

// ─── XMLHttpRequest hook ─────────────────────────────────────────────────────

const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function patchedOpen(
  this: XMLHttpRequest & { __ymd_url?: string },
  method: string,
  url: string | URL,
  ...rest: unknown[]
) {
  this.__ymd_url = typeof url === "string" ? url : url.toString();
  // @ts-expect-error — the rest args are variadic in the real signature
  return origOpen.call(this, method, url, ...rest);
};

XMLHttpRequest.prototype.send = function patchedSend(
  this: XMLHttpRequest & { __ymd_url?: string },
  body?: Document | XMLHttpRequestBodyInit | null,
) {
  try {
    const u = this.__ymd_url;
    if (u) {
      const fromUrl = extractTrackIdFromUrl(u);
      if (fromUrl) {
        // We can't peek into the response body without delaying the page,
        // so we post the URL-derived id on `loadend`. Artist/title may be
        // resolved later by another hook (fetch).
        this.addEventListener("loadend", () => {
          let enriched = fromUrl as typeof lastTrack;
          try {
            const ct = this.getResponseHeader?.("content-type") ?? "";
            if (ct.includes("application/json") && typeof this.responseText === "string" && this.responseText.length > 0) {
              const json = JSON.parse(this.responseText);
              enriched = enrichFromResponseJson(json, fromUrl);
            }
          } catch { /* ignore */ }
          postTrack(enriched);
        });
      }
    }
  } catch { /* ignore */ }
  return origSend.call(this, body ?? null);
};

// ─── Replay-on-request handshake ────────────────────────────────────────────

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "ymd-content") return;
  if (data.action !== "REQUEST_LAST_TRACK") return;
  // The content script just loaded and is asking what we've seen so far.
  if (lastTrack) postTrack(lastTrack);
  else if (lastPrefetchTrack && !isWaveMode()) postTrack(lastPrefetchTrack);
});

console.log(`${TAG} fetch/XHR hooks installed`);
