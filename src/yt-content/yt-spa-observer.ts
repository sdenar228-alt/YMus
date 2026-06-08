/**
 * YouTube SPA Navigation Observer.
 * Detects navigation events on YouTube's SPA (pushState, replaceState, popstate, yt-navigate-finish)
 * and extracts the current videoId from the URL.
 *
 * Requirements: 1.3, 1.4
 */

const TAG = "[YMus YT SPA]";

/**
 * Extracts videoId from current URL.
 * Supports:
 *   - youtube.com/watch?v=VIDEO_ID
 *   - youtube.com/shorts/VIDEO_ID
 * Returns null if URL doesn't match a video page.
 */
function extractVideoIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Regular video: /watch?v=...
    if (parsed.pathname === "/watch") {
      const v = parsed.searchParams.get("v");
      if (v && v.length > 0) return v;
    }
    // Shorts: /shorts/VIDEO_ID
    const shortsMatch = parsed.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
    if (shortsMatch) return shortsMatch[1];
  } catch {
    // Invalid URL
  }
  return null;
}

/**
 * Waits for a video player DOM element with exponential backoff.
 * Retries up to ~10 seconds total. Logs warning and stops if not found.
 *
 * @returns true if element found, false if timed out
 */
function waitForPlayerElement(): Promise<boolean> {
  const SELECTORS = [
    "#movie_player",            // Regular video player
    "ytd-player",              // Player component
    "ytd-reel-video-renderer", // Shorts player
  ];

  return new Promise((resolve) => {
    let elapsed = 0;
    let delay = 250; // Start with 250ms, exponential backoff

    function check() {
      for (const sel of SELECTORS) {
        if (document.querySelector(sel)) {
          resolve(true);
          return;
        }
      }

      elapsed += delay;
      if (elapsed >= 10_000) {
        console.warn(`${TAG} Video player element not found after 10s, stopping retry.`);
        resolve(false);
        return;
      }

      delay = Math.min(delay * 2, 2000); // Cap at 2s
      setTimeout(check, delay);
    }

    check();
  });
}

/**
 * Starts observing YouTube SPA navigations.
 * Calls `onNavigate(videoId)` on every navigation change (including initial load).
 * videoId is null when navigating away from a video page.
 */
export function startSpaObserver(onNavigate: (videoId: string | null) => void): void {
  let lastVideoId: string | null | undefined = undefined; // undefined = never called

  async function handleNavigation() {
    const videoId = extractVideoIdFromUrl(location.href);

    // Deduplicate — don't fire if videoId hasn't changed
    if (videoId === lastVideoId) return;
    lastVideoId = videoId;

    if (videoId) {
      // Wait for player element before notifying
      const found = await waitForPlayerElement();
      if (!found) {
        // Element not found — still notify with videoId so caller knows
        // but the button injector will handle the missing container
        console.warn(`${TAG} Player element not found for videoId=${videoId}`);
      }
    }

    onNavigate(videoId);
  }

  // Intercept history.pushState
  const origPushState = history.pushState.bind(history);
  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    origPushState(...args);
    handleNavigation();
  };

  // Intercept history.replaceState
  const origReplaceState = history.replaceState.bind(history);
  history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
    origReplaceState(...args);
    handleNavigation();
  };

  // Listen for popstate (browser back/forward)
  window.addEventListener("popstate", () => handleNavigation());

  // YouTube-specific SPA navigation event
  window.addEventListener("yt-navigate-finish", () => handleNavigation());

  // Fire for initial page load
  handleNavigation();

  console.log(`${TAG} SPA observer started`);
}
