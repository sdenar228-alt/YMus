import { VkApiClient, VkApiError } from "../../src/background/vk-api-client";
import { VkUrlCache } from "../../src/background/vk-url-cache";
import { VkRateLimiter } from "../../src/background/vk-rate-limiter";

// Mock vk-session-validator
jest.mock("../../src/background/vk-session-validator", () => ({
  validateVkSession: jest.fn(),
}));

import { validateVkSession } from "../../src/background/vk-session-validator";

const mockValidateVkSession = validateVkSession as jest.MockedFunction<typeof validateVkSession>;

// Mock global fetch
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// jest-webextension-mock does not provide chrome.cookies, so set it up manually.
beforeAll(() => {
  (global as any).chrome = (global as any).chrome || {};
  (global as any).chrome.cookies = {
    ...(global as any).chrome.cookies,
    get: jest.fn(),
    getAll: jest.fn(),
  };
});

function createMockRateLimiter(): VkRateLimiter {
  return {
    acquire: jest.fn().mockResolvedValue(undefined),
    report429: jest.fn(),
    reportSuccess: jest.fn(),
    getRetryDelay: jest.fn((n: number) => (n <= 3 ? 1000 * Math.pow(2, n - 1) : null)),
    reset: jest.fn(),
  };
}

function createMockResponse(body: string, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: jest.fn().mockResolvedValue(body),
    headers: new Headers(),
  } as unknown as Response;
}

describe("VkApiClient", () => {
  let cache: VkUrlCache;
  let rateLimiter: VkRateLimiter;
  let client: VkApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    cache = new VkUrlCache();
    rateLimiter = createMockRateLimiter();
    client = new VkApiClient(cache, rateLimiter);

    // Default: session is valid
    mockValidateVkSession.mockResolvedValue({ valid: true });

    // Default: chrome.cookies.getAll returns cookies
    (chrome.cookies.getAll as jest.Mock).mockResolvedValue([
      { name: "remixsid", value: "abc123" },
      { name: "remixlang", value: "0" },
    ]);
  });

  it("returns cached URL without making API call", async () => {
    cache.set("111", "222", "https://cached-audio.mp3");

    const result = await client.getAudioUrl("111", "222");

    expect(result).toEqual({
      url: "https://cached-audio.mp3",
      ownerId: "111",
      audioId: "222",
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(rateLimiter.acquire).not.toHaveBeenCalled();
  });

  it("makes API call and returns URL on success", async () => {
    const audioData = JSON.stringify([["111_222", "111", "https://vk-audio.mp3", "Artist", "Title"]]);
    mockFetch.mockResolvedValue(createMockResponse(audioData));

    const result = await client.getAudioUrl("111", "222");

    expect(result).toEqual({
      url: "https://vk-audio.mp3",
      ownerId: "111",
      audioId: "222",
    });
    expect(rateLimiter.acquire).toHaveBeenCalled();
    expect(rateLimiter.reportSuccess).toHaveBeenCalled();
    // Should be cached now
    expect(cache.get("111", "222")).toBe("https://vk-audio.mp3");
  });

  it("throws VK_AUTH_REQUIRED on HTTP 401", async () => {
    mockFetch.mockResolvedValue(createMockResponse("", 401));

    await expect(client.getAudioUrl("111", "222")).rejects.toThrow(VkApiError);
    await expect(client.getAudioUrl("111", "222")).rejects.toMatchObject({
      code: "VK_AUTH_REQUIRED",
    });
  });

  it("throws VK_AUTH_REQUIRED on HTTP 403", async () => {
    mockFetch.mockResolvedValue(createMockResponse("", 403));

    await expect(client.getAudioUrl("111", "222")).rejects.toMatchObject({
      code: "VK_AUTH_REQUIRED",
    });
  });

  it("throws VK_RATE_LIMITED on HTTP 429 and calls rateLimiter.report429()", async () => {
    mockFetch.mockResolvedValue(createMockResponse("", 429));

    await expect(client.getAudioUrl("111", "222")).rejects.toMatchObject({
      code: "VK_RATE_LIMITED",
    });
    expect(rateLimiter.report429).toHaveBeenCalled();
  });

  it("throws VK_TIMEOUT on AbortError", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    mockFetch.mockRejectedValue(abortError);

    await expect(client.getAudioUrl("111", "222")).rejects.toMatchObject({
      code: "VK_TIMEOUT",
    });
  });

  it("throws VK_URL_NOT_FOUND when response has empty URL", async () => {
    const audioData = JSON.stringify([["111_222", "111", "", "Artist", "Title"]]);
    mockFetch.mockResolvedValue(createMockResponse(audioData));

    await expect(client.getAudioUrl("111", "222")).rejects.toMatchObject({
      code: "VK_URL_NOT_FOUND",
    });
  });

  it("throws VK_URL_NOT_FOUND when URL does not start with https://", async () => {
    const audioData = JSON.stringify([["111_222", "111", "http://insecure.mp3", "Artist", "Title"]]);
    mockFetch.mockResolvedValue(createMockResponse(audioData));

    await expect(client.getAudioUrl("111", "222")).rejects.toMatchObject({
      code: "VK_URL_NOT_FOUND",
    });
  });

  it("throws VK_AUTH_REQUIRED when session is invalid", async () => {
    mockValidateVkSession.mockResolvedValue({
      valid: false,
      errorCode: "VK_NOT_LOGGED_IN",
      errorMessage: "Войдите в VK в браузере",
    });

    await expect(client.getAudioUrl("111", "222")).rejects.toMatchObject({
      code: "VK_AUTH_REQUIRED",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws VK_NETWORK_ERROR on non-abort fetch failure", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(client.getAudioUrl("111", "222")).rejects.toMatchObject({
      code: "VK_NETWORK_ERROR",
    });
  });

  it("includes cookies in request header", async () => {
    const audioData = JSON.stringify([["111_222", "111", "https://audio.mp3"]]);
    mockFetch.mockResolvedValue(createMockResponse(audioData));

    await client.getAudioUrl("111", "222");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://vk.com/al_audio.php",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Cookie: "remixsid=abc123; remixlang=0",
        }),
      }),
    );
  });
});
