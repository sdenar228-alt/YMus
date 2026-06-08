/**
 * Yandex Music — bridge listener.
 *
 * Receives TRACK_DETECTED postMessage events from the MAIN-world page
 * bridge (`ym-page-bridge.ts`) and stores the most recent value in module
 * state. `track-meta.ts` reads `getLastBridgeTrack()` first when it can't
 * find a /track/ link in the DOM.
 *
 * The page bridge is loaded at document_start and starts intercepting
 * fetch/XHR immediately. The content script (this file's caller) starts
 * later, so on first inject we ask the bridge to replay whatever it's
 * already detected via { source: "ymd-content", action: "REQUEST_LAST_TRACK" }.
 */

const TAG = "[YMus YM Bridge Listener]";

export interface BridgeTrack {
  trackId: string;
  albumId?: string;
  artist?: string;
  title?: string;
  detectionSource?: "playback" | "metadata" | "prefetch";
  /** When the bridge last reported it, used to expire stale data. */
  receivedAt: number;
}

let lastBridgeTrack: BridgeTrack | null = null;
let started = false;

export function startYmBridgeListener(): void {
  if (started) return;
  started = true;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "ymd-bridge") return;
    if (data.action !== "TRACK_DETECTED") return;
    if (typeof data.trackId !== "string" || data.trackId.length === 0) return;

    lastBridgeTrack = {
      trackId: data.trackId,
      albumId: typeof data.albumId === "string" && data.albumId.length > 0 ? data.albumId : undefined,
      artist: typeof data.artist === "string" && data.artist.length > 0 ? data.artist : undefined,
      title: typeof data.title === "string" && data.title.length > 0 ? data.title : undefined,
      detectionSource:
        data.detectionSource === "playback" ||
        data.detectionSource === "metadata" ||
        data.detectionSource === "prefetch"
          ? data.detectionSource
          : undefined,
      receivedAt: Date.now(),
    };
  });

  // The bridge may have already seen track requests before this listener
  // attached. Ask it to replay the most recent one.
  try {
    window.postMessage({ source: "ymd-content", action: "REQUEST_LAST_TRACK" }, "*");
  } catch { /* ignore */ }

  console.log(`${TAG} listening for TRACK_DETECTED messages`);
}

/**
 * Returns the last track reported by the bridge, or null if nothing has
 * been seen yet (or the data is older than 30 minutes — which would mean
 * the user idled long enough that the page surely isn't playing the same
 * track anymore).
 */
export function getLastBridgeTrack(): BridgeTrack | null {
  if (!lastBridgeTrack) return null;
  const ageMs = Date.now() - lastBridgeTrack.receivedAt;
  if (ageMs > 30 * 60 * 1000) {
    lastBridgeTrack = null;
    return null;
  }
  return lastBridgeTrack;
}
