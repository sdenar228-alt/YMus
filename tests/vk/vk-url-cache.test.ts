import { VkUrlCache } from "../../src/background/vk-url-cache";

describe("VkUrlCache", () => {
  let cache: VkUrlCache;

  beforeEach(() => {
    jest.useFakeTimers();
    cache = new VkUrlCache();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("set/get round-trip returns the URL", () => {
    cache.set("123", "456", "https://example.com/audio.mp3");
    expect(cache.get("123", "456")).toBe("https://example.com/audio.mp3");
  });

  it("returns undefined for unknown keys", () => {
    expect(cache.get("999", "888")).toBeUndefined();
  });

  it("expired entries return undefined", () => {
    cache.set("123", "456", "https://example.com/audio.mp3");

    // Advance time past TTL (10 minutes + 1ms)
    jest.advanceTimersByTime(10 * 60 * 1000 + 1);

    expect(cache.get("123", "456")).toBeUndefined();
  });

  it("cache evicts oldest when exceeding 50 entries", () => {
    // Insert 50 entries with increasing timestamps
    for (let i = 0; i < 50; i++) {
      cache.set("owner", `audio_${i}`, `https://url/${i}`);
      jest.advanceTimersByTime(1); // ensure distinct timestamps
    }

    expect(cache.size()).toBe(50);

    // Insert the 51st entry — should evict audio_0 (oldest)
    cache.set("owner", "audio_50", "https://url/50");

    expect(cache.size()).toBe(50);
    expect(cache.get("owner", "audio_0")).toBeUndefined();
    expect(cache.get("owner", "audio_50")).toBe("https://url/50");
  });

  it("size() reflects current entry count", () => {
    expect(cache.size()).toBe(0);

    cache.set("a", "1", "https://url/1");
    expect(cache.size()).toBe(1);

    cache.set("a", "2", "https://url/2");
    expect(cache.size()).toBe(2);

    cache.set("b", "1", "https://url/3");
    expect(cache.size()).toBe(3);
  });
});
