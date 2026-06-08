import { VkErrorCode } from "../shared/types";
import { VkUrlCache } from "./vk-url-cache";
import { VkRateLimiter } from "./vk-rate-limiter";
import { validateVkSession } from "./vk-session-validator";

export interface VkAudioUrl {
  url: string;
  ownerId: string;
  audioId: string;
}

export class VkApiError extends Error {
  constructor(
    public readonly code: VkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VkApiError";
  }
}

/**
 * VK audio URL unmask algorithm.
 * VK encrypts audio URLs in data-audio attributes using a simple cipher.
 * The URL is encoded with the user's vk_id as key.
 */
function unmaskVkUrl(encoded: string, userId: number): string {
  if (!encoded || encoded.startsWith("https://") || encoded.startsWith("http://")) {
    return encoded; // Already a plain URL
  }

  // VK uses a specific obfuscation for audio URLs
  // The encoded string contains hex pairs separated by slashes
  // Algorithm: decode the cipher using userId as the XOR key
  const parts = encoded.split("/");
  if (parts.length < 3) return encoded;

  // Try to decode as VK's format
  let url = encoded;

  // VK's unmask function (simplified from their JS):
  // 1. Split by "/"
  // 2. Reverse specific transformations based on operation codes
  // The actual VK algorithm is complex, so we'll use a different approach:
  // fetch the actual playable URL via VK's internal reload endpoint

  return url;
}

export class VkApiClient {
  private readonly cache: VkUrlCache;
  private readonly rateLimiter: VkRateLimiter;

  constructor(cache: VkUrlCache, rateLimiter: VkRateLimiter) {
    this.cache = cache;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Resolve direct audio URL for a VK track.
   * Strategy:
   * 1. If encryptedUrl is provided and starts with https:// — use directly
   * 2. Otherwise, call VK's reload_audio endpoint to get a fresh URL
   */
  async getAudioUrl(ownerId: string, audioId: string, encryptedUrl?: string): Promise<VkAudioUrl> {
    // 1. Check cache
    const cached = this.cache.get(ownerId, audioId);
    if (cached) {
      console.log(`[ymd][vk-api] Cache hit for ${ownerId}_${audioId}`);
      return { url: cached, ownerId, audioId };
    }

    // 2. If we have a direct URL already (some tracks have unencrypted URLs)
    if (encryptedUrl && encryptedUrl.startsWith("https://")) {
      console.log(`[ymd][vk-api] Using provided URL for ${ownerId}_${audioId}`);
      this.cache.set(ownerId, audioId, encryptedUrl);
      return { url: encryptedUrl, ownerId, audioId };
    }

    // 3. Validate session
    console.log(`[ymd][vk-api] No URL, validating session for ${ownerId}_${audioId}...`);
    const session = await validateVkSession();
    if (!session.valid) {
      throw new VkApiError("VK_AUTH_REQUIRED", "Войдите в VK в браузере");
    }

    // 4. Acquire rate limiter slot
    await this.rateLimiter.acquire();

    // 5. Try to get URL via VK's internal API
    const url = await this.fetchAudioUrl(ownerId, audioId);

    // 6. Validate
    if (!url || !url.startsWith("https://")) {
      throw new VkApiError("VK_URL_NOT_FOUND", "Трек недоступен");
    }

    // 7. Cache and return
    this.rateLimiter.reportSuccess();
    this.cache.set(ownerId, audioId, url);
    return { url, ownerId, audioId };
  }

  /**
   * Fetch audio URL via VK's internal reload_audio API.
   */
  private async fetchAudioUrl(ownerId: string, audioId: string): Promise<string | null> {
    const cookies = await chrome.cookies.getAll({ domain: "vk.com" });
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    try {
      // Use VK's audio.get method via al_audio.php
      const body = new URLSearchParams({
        act: "reload_audio",
        ids: `${ownerId}_${audioId}`,
      });

      const response = await fetch("https://vk.com/al_audio.php", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          Cookie: cookieHeader,
        },
        body: body.toString(),
        signal: controller.signal,
        credentials: "include",
      });

      clearTimeout(timeoutId);

      if (response.status === 401 || response.status === 403) {
        throw new VkApiError("VK_AUTH_REQUIRED", "Сессия VK истекла");
      }
      if (response.status === 429) {
        this.rateLimiter.report429();
        throw new VkApiError("VK_RATE_LIMITED", "Слишком много запросов");
      }

      const text = await response.text();
      return this.parseAudioUrl(text);
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if (error instanceof VkApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new VkApiError("VK_TIMEOUT", "Превышено время ожидания");
      }
      throw new VkApiError("VK_NETWORK_ERROR", "Ошибка сети");
    }
  }

  /**
   * Parse VK al_audio.php response. Tries multiple response formats.
   */
  private parseAudioUrl(responseText: string): string | null {
    try {
      // Remove VK's comment prefix
      const cleaned = responseText.replace(/^<!--/, "").trim();

      // Try parsing as JSON
      let data: unknown;
      try {
        data = JSON.parse(cleaned);
      } catch {
        // Try to find URL directly in the response text
        const urlMatch = cleaned.match(/https:\/\/[^"'\s,]+\.mp3[^"'\s,]*/);
        if (urlMatch) return urlMatch[0];

        const m4aMatch = cleaned.match(/https:\/\/[^"'\s,]+\.m4a[^"'\s,]*/);
        if (m4aMatch) return m4aMatch[0];

        return null;
      }

      // Navigate the response structure
      if (Array.isArray(data)) {
        // Could be [[audioId, ownerId, url, ...]] or {data: [[...]]}
        const tuple = Array.isArray(data[0]) ? data[0] : data;
        if (tuple.length > 2 && typeof tuple[2] === "string" && tuple[2].startsWith("https://")) {
          return tuple[2];
        }
      } else if (data && typeof data === "object") {
        const obj = data as Record<string, unknown>;
        if (Array.isArray(obj.data)) {
          const inner = obj.data;
          const tuple = Array.isArray(inner[0]) ? inner[0] : inner;
          if (tuple.length > 2 && typeof tuple[2] === "string" && tuple[2].startsWith("https://")) {
            return tuple[2];
          }
        }
        // Try payload.data format
        if (obj.payload && Array.isArray((obj.payload as any)[1])) {
          const audios = (obj.payload as any)[1][0];
          if (Array.isArray(audios) && audios.length > 2 && typeof audios[2] === "string") {
            const url = audios[2];
            if (url.startsWith("https://")) return url;
          }
        }
      }

      // Last resort: regex for audio URL in response
      const urlMatch = responseText.match(/https:\/\/[^"'\\\s]+?\.(?:mp3|m4a)\?[^"'\\\s]*/);
      if (urlMatch) return urlMatch[0].replace(/\\\//g, "/");

      return null;
    } catch {
      return null;
    }
  }
}
