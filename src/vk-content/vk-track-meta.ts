import type { VkTrackMeta } from "../shared/types";

const UNKNOWN_ARTIST = "Unknown";

/**
 * Extract track metadata from a VK audio element.
 * Also extracts the encrypted audio URL from data-audio attribute.
 *
 * Resolution order:
 *   1. data-full-id / data-sortable-id ON the element itself.
 *   2. Same attributes on a DESCENDANT (newer vkit layouts wrap the row
 *      and put data-* on an inner div).
 *
 * If neither path yields an id, returns null. The caller can then fall
 * back to a page-bridge fiber lookup (only the page-bridge runs in MAIN
 * world and can read React fiber `memoizedProps.track`).
 */
export function extractVkTrackMeta(audioElement: Element): VkTrackMeta | null {
  // (1) Direct attribute lookup
  let target: Element = audioElement;
  let dataFullId = target.getAttribute("data-full-id")
    || target.getAttribute("data-sortable-id");

  // (2) Descendant fallback
  if (!dataFullId) {
    const inner = audioElement.querySelector("[data-full-id], [data-sortable-id]");
    if (inner) {
      target = inner;
      dataFullId = inner.getAttribute("data-full-id")
        || inner.getAttribute("data-sortable-id");
    }
  }

  if (!dataFullId) return null;

  const parsed = parseDataId(dataFullId);
  if (parsed === null) return null;

  const { ownerId, audioId } = parsed;

  // Try to get artist/title from data-audio JSON array
  const dataAudio = target.getAttribute("data-audio");
  let artist: string | null = null;
  let title: string | null = null;
  let encryptedUrl: string | null = null;
  let accessKey: string | null = null;

  if (dataAudio) {
    try {
      const audioArr = JSON.parse(dataAudio);
      // VK data-audio array structure:
      // [0] = audioId, [1] = ownerId, [2] = encrypted URL, [3] = title, [4] = artist
      // [24] = accessKey (present for tracks outside "My music")
      if (Array.isArray(audioArr)) {
        title = typeof audioArr[3] === "string" && audioArr[3].length > 0 ? audioArr[3] : null;
        artist = typeof audioArr[4] === "string" && audioArr[4].length > 0 ? audioArr[4] : null;
        encryptedUrl = typeof audioArr[2] === "string" && audioArr[2].length > 0 ? audioArr[2] : null;
        accessKey = typeof audioArr[24] === "string" && audioArr[24].length > 0 ? audioArr[24] : null;
      }
    } catch {
      // Fallback to DOM parsing
    }
  }

  // Fallback: get artist/title from DOM
  if (!artist) artist = findArtist(audioElement) ?? UNKNOWN_ARTIST;
  if (!title) title = findTitle(audioElement) ?? `audio_${audioId}`;

  return {
    ownerId,
    audioId,
    artist,
    title,
    encryptedUrl: encryptedUrl ?? undefined,
    accessKey: accessKey ?? undefined,
  };
}

/**
 * Unmask VK audio URL using VK's own AudioUtils.unmaskSource function.
 * This must be called from the content script context (page has the function).
 * Falls back to returning the raw URL if unmask is not available.
 */
export function unmaskVkAudioUrl(encryptedUrl: string, userId: number): string {
  // If already a plain URL, return as-is
  if (encryptedUrl.startsWith("https://") || encryptedUrl.startsWith("http://")) {
    return encryptedUrl;
  }

  // Try to call VK's own unmask function via injected script
  // This requires page-level access, so we use a trick:
  // We cannot directly call window functions from content script,
  // so we'll inject a script element to get the result.
  return encryptedUrl; // Fallback — will be handled by the page-level injection
}

/**
 * Decode VK audio URL by injecting a script into the page context.
 * Returns a Promise that resolves to the decoded URL.
 */
export function decodeVkAudioUrlViaPage(encryptedUrl: string, audioFullId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const callbackId = `ymus_decode_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // Listen for the result from the page
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail && detail.callbackId === callbackId) {
        document.removeEventListener("ymus-decode-result", handler);
        resolve(detail.url || null);
      }
    };
    document.addEventListener("ymus-decode-result", handler);

    // Inject a script that calls VK's AudioUtils.unmaskSource
    const script = document.createElement("script");
    script.textContent = `
      (function() {
        var url = null;
        try {
          var encoded = ${JSON.stringify(encryptedUrl)};
          var fullId = ${JSON.stringify(audioFullId)};
          if (window.AudioUtils && window.AudioUtils.unmaskSource) {
            url = window.AudioUtils.unmaskSource(encoded);
          }
          if (!url && window.getAudioPlayer) {
            var player = window.getAudioPlayer();
            if (player && player._impl && player._impl.unmaskSource) {
              url = player._impl.unmaskSource(encoded);
            }
          }
        } catch(e) {}
        document.dispatchEvent(new CustomEvent("ymus-decode-result", {
          detail: { callbackId: ${JSON.stringify(callbackId)}, url: url }
        }));
      })();
    `;
    document.head.appendChild(script);
    script.remove();

    // Timeout after 3 seconds
    setTimeout(() => {
      document.removeEventListener("ymus-decode-result", handler);
      resolve(null);
    }, 3000);
  });
}

/**
 * Parse "ownerId_audioId" string. Supports negative owner IDs (e.g., "-123_456").
 */
function parseDataId(
  value: string,
): { ownerId: string; audioId: string } | null {
  const match = value.match(/^(-?\d+)_(\d+)$/);
  if (match === null) return null;
  return { ownerId: match[1], audioId: match[2] };
}

/**
 * Find artist text from known VK audio element selectors.
 */
function findArtist(el: Element): string | null {
  const selectors = [
    ".audio_row__performers",
    '[class*="AudioRow__performers"]',
    '[class*="performer"]',
    '[class*="artist"]',
    // vkit overlay: secondary link is the artist
    'a[class*="Link__secondary"]',
    '[class*="AudioRowInfo__text"] a[class*="Link__secondary"]',
  ];

  for (const selector of selectors) {
    const found = el.querySelector(selector);
    if (found !== null) {
      const text = found.textContent?.trim();
      if (text !== undefined && text.length > 0) return text;
    }
  }

  return null;
}

/**
 * Find title text from known VK audio element selectors.
 */
function findTitle(el: Element): string | null {
  const selectors = [
    "._audio_row__title_inner",
    ".audio_row__title_inner",
    '[class*="AudioRow__title"]',
    '[class*="audio_row__title"]',
    '[class*="audio_title"]',
    '[class*="title_inner"]',
    // vkit overlay: primary link is the title (first text node only, before subtitle span)
    'a[class*="Link__primary"]',
  ];

  for (const selector of selectors) {
    const found = el.querySelector(selector);
    if (found !== null) {
      // For vkit Link__primary, get only the first direct text content (before subtitle span)
      if (selector.includes("Link__primary")) {
        // The link may contain: "Title subtitle..." — get only the first text node
        for (const node of Array.from(found.childNodes)) {
          if (node.nodeType === 3) { // TEXT_NODE
            const text = node.textContent?.trim();
            if (text && text.length > 0) return text;
          }
        }
        // Fallback: if no text node, try full textContent minus any secondary text
        const subtitle = found.querySelector('[class*="colorTextSecondary"]');
        if (subtitle) {
          const fullText = found.textContent?.trim() || "";
          const subText = subtitle.textContent?.trim() || "";
          const title = fullText.replace(subText, "").trim();
          if (title.length > 0) return title;
        }
      }
      const text = found.textContent?.trim();
      if (text !== undefined && text.length > 0) return text;
    }
  }

  return null;
}
