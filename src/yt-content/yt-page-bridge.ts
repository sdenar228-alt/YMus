/**
 * YouTube Page Bridge — runs in MAIN world (page context) at document_start.
 *
 * Post-revert simplified version. The SW now uses
 * `chrome.webRequest.onBeforeRequest` to capture the player's SABR POSTs,
 * so the bridge no longer hooks `window.fetch`. Its only job is to relay
 * a small set of player actions from the isolated content world to the
 * MAIN world, where the YouTube player API lives:
 *
 *   - `SET_QUALITY`    → switch playback quality before download.
 *   - `RELOAD_VIDEO`   → call `loadVideoById` so the player reissues the
 *                        SABR POSTs the SW listens for.
 *   - `CLEAR_BUFFER`   → no-op kept for backwards compatibility with the
 *                        legacy isolated-world content script wire.
 *   - `GET_BUFFER_STATUS` → returns a constant placeholder so any legacy
 *                        caller doesn't error out.
 *
 * Messages are tagged `event.data.source === "ymus-yt-content"` (request)
 * and `event.data.source === "ymus-yt-bridge"` (response).
 */

(() => {
  const TAG = "[YMus YT Bridge]";

  /** Minimal subset of the YouTube `movie_player` API used by the bridge. */
  interface YouTubePlayer {
    loadVideoById?: (args: { videoId: string; startSeconds?: number }) => void;
    setPlaybackQualityRange?: (min: string, max: string) => void;
    setPlaybackQuality?: (label: string) => void;
    getAvailableQualityLevels?: () => string[];
  }

  /** Input message envelope from `yt-content.ts`. */
  interface BridgeRequest {
    source?: unknown;
    action?: unknown;
    videoId?: unknown;
    targetHeight?: unknown;
  }

  function getPlayer(): YouTubePlayer | null {
    return (
      (document.getElementById("movie_player") as unknown as YouTubePlayer | null) ??
      null
    );
  }

  function getVideoIdFromUrl(): string {
    const params = new URLSearchParams(location.search);
    return params.get("v") || "unknown";
  }

  function heightToLabel(h: number): string {
    if (h >= 4320) return "highres";
    if (h >= 2880) return "hd2880";
    if (h >= 2160) return "hd2160";
    if (h >= 1440) return "hd1440";
    if (h >= 1080) return "hd1080";
    if (h >= 720) return "hd720";
    if (h >= 480) return "large";
    if (h >= 360) return "medium";
    if (h >= 240) return "small";
    return "tiny";
  }

  // ─── Message dispatch ─────────────────────────────────────────────────────

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as BridgeRequest | null;
    if (!data || data.source !== "ymus-yt-content") return;

    const action = typeof data.action === "string" ? data.action : "";
    const videoId =
      typeof data.videoId === "string" && data.videoId.length > 0
        ? data.videoId
        : null;

    if (action === "GET_BUFFER_STATUS") {
      // The post-revert flow does not maintain an in-page byte buffer —
      // bytes come from the SW's webRequest hook. Reply with a placeholder
      // so any leftover legacy caller does not stall.
      window.postMessage(
        {
          source: "ymus-yt-bridge",
          action: "BUFFER_STATUS_RESPONSE",
          videoId: videoId ?? getVideoIdFromUrl(),
          size: 0,
          responseCount: 0,
          itags: [],
        },
        "*",
      );
      return;
    }

    if (action === "CLEAR_BUFFER") {
      // No-op — there is nothing to clear in this bridge.
      return;
    }

    if (action === "RELOAD_VIDEO") {
      const targetId = videoId ?? getVideoIdFromUrl();
      let result: { success: boolean; reason?: string } = {
        success: false,
        reason: "player_not_found",
      };
      try {
        const player = getPlayer();
        if (player && typeof player.loadVideoById === "function") {
          try {
            player.loadVideoById({ videoId: targetId, startSeconds: 0 });
            result = { success: true };
          } catch (e) {
            result = {
              success: false,
              reason: (e as Error)?.message || "loadVideoById_threw",
            };
          }
        } else {
          result = { success: false, reason: "loadVideoById_missing" };
        }
      } catch (e) {
        result = { success: false, reason: (e as Error)?.message || "exception" };
      }
      window.postMessage(
        {
          source: "ymus-yt-bridge",
          action: "RELOAD_VIDEO_RESPONSE",
          ...result,
        },
        "*",
      );
      return;
    }

    if (action === "SET_QUALITY") {
      const targetHeight =
        typeof data.targetHeight === "number" ? data.targetHeight : 1080;
      let result: {
        success: boolean;
        reason?: string;
        appliedLabel?: string;
      } = { success: false, reason: "player_not_found" };
      try {
        const player = getPlayer();
        if (!player) {
          result = { success: false, reason: "player_not_found" };
        } else if (typeof player.setPlaybackQualityRange !== "function") {
          result = { success: false, reason: "api_missing" };
        } else {
          const available =
            (typeof player.getAvailableQualityLevels === "function"
              ? player.getAvailableQualityLevels()
              : null) || [];
          const orderedLabels = [
            "highres",
            "hd2880",
            "hd2160",
            "hd1440",
            "hd1080",
            "hd720",
            "large",
            "medium",
            "small",
            "tiny",
          ];
          const targetLabel = heightToLabel(targetHeight);
          const targetIdx = orderedLabels.indexOf(targetLabel);
          let chosen: string | null = null;
          for (let i = targetIdx; i < orderedLabels.length; i++) {
            const lbl = orderedLabels[i];
            if (available.length === 0 || available.includes(lbl)) {
              chosen = lbl;
              break;
            }
          }
          if (!chosen && available.length > 0) {
            chosen = available[available.length - 1];
          }
          if (!chosen) chosen = targetLabel;
          try {
            player.setPlaybackQualityRange(chosen, chosen);
            if (typeof player.setPlaybackQuality === "function") {
              player.setPlaybackQuality(chosen);
            }
            result = { success: true, appliedLabel: chosen };
          } catch (e) {
            result = {
              success: false,
              reason: (e as Error)?.message || "setQuality_threw",
            };
          }
        }
      } catch (e) {
        result = { success: false, reason: (e as Error)?.message || "exception" };
      }
      window.postMessage(
        {
          source: "ymus-yt-bridge",
          action: "SET_QUALITY_RESPONSE",
          ...result,
        },
        "*",
      );
      return;
    }
  });

  console.log(`${TAG} loaded (SABR replay mode)`);
})();
