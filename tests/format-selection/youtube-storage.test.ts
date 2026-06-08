import { getYouTubePreferences, setYouTubePreferences } from "../../src/popup/youtube-storage";

describe("youtube-storage", () => {
  beforeEach(() => {
    (chrome.storage.local as any).clear();
  });

  describe("getYouTubePreferences", () => {
    it("returns defaults when storage is empty", async () => {
      const prefs = await getYouTubePreferences();
      expect(prefs).toEqual({ quality: "1080p", downloadMode: "video" });
    });

    it("returns stored values when present", async () => {
      await chrome.storage.local.set({
        ytPreferredQuality: "720p",
        ytDownloadMode: "audio-only",
      });

      const prefs = await getYouTubePreferences();
      expect(prefs).toEqual({ quality: "720p", downloadMode: "audio-only" });
    });

    it("falls back to default quality on invalid value", async () => {
      await chrome.storage.local.set({
        ytPreferredQuality: "360p",
        ytDownloadMode: "video",
      });

      const prefs = await getYouTubePreferences();
      expect(prefs.quality).toBe("1080p");
      expect(prefs.downloadMode).toBe("video");
    });

    it("falls back to default downloadMode on invalid value", async () => {
      await chrome.storage.local.set({
        ytPreferredQuality: "4K",
        ytDownloadMode: "stream",
      });

      const prefs = await getYouTubePreferences();
      expect(prefs.quality).toBe("4K");
      expect(prefs.downloadMode).toBe("video");
    });

    it("returns defaults when no keys are set", async () => {
      const prefs = await getYouTubePreferences();
      expect(prefs).toEqual({ quality: "1080p", downloadMode: "video" });
    });

    it("migrates from legacy youtube_prefs key", async () => {
      await chrome.storage.local.set({
        youtube_prefs: { quality: "4K", downloadMode: "audio-only" },
      });

      const prefs = await getYouTubePreferences();
      expect(prefs).toEqual({ quality: "4K", downloadMode: "audio-only" });

      // Verify migration persisted to new keys
      const raw = await chrome.storage.local.get(["ytPreferredQuality", "ytDownloadMode", "youtube_prefs"]);
      expect(raw.ytPreferredQuality).toBe("4K");
      expect(raw.ytDownloadMode).toBe("audio-only");
      expect(raw.youtube_prefs).toBeUndefined();
    });

    it("migrates legacy with invalid values using defaults", async () => {
      await chrome.storage.local.set({
        youtube_prefs: { quality: "360p", downloadMode: "stream" },
      });

      const prefs = await getYouTubePreferences();
      expect(prefs.quality).toBe("1080p");
      expect(prefs.downloadMode).toBe("video");
    });
  });

  describe("setYouTubePreferences", () => {
    it("persists full preferences", async () => {
      await setYouTubePreferences({ quality: "4K", downloadMode: "video-audio" });

      const prefs = await getYouTubePreferences();
      expect(prefs).toEqual({ quality: "4K", downloadMode: "video-audio" });
    });

    it("supports partial update of quality", async () => {
      await setYouTubePreferences({ quality: "720p" });

      const prefs = await getYouTubePreferences();
      expect(prefs.quality).toBe("720p");
      expect(prefs.downloadMode).toBe("video"); // default preserved
    });

    it("supports partial update of downloadMode", async () => {
      await setYouTubePreferences({ downloadMode: "audio-only" });

      const prefs = await getYouTubePreferences();
      expect(prefs.quality).toBe("1080p"); // default preserved
      expect(prefs.downloadMode).toBe("audio-only");
    });

    it("ignores invalid values in partial update", async () => {
      await setYouTubePreferences({ quality: "2K", downloadMode: "video-audio" });
      await setYouTubePreferences({ quality: "8K" as any });

      const prefs = await getYouTubePreferences();
      expect(prefs.quality).toBe("2K"); // kept previous valid value
      expect(prefs.downloadMode).toBe("video-audio");
    });

    it("persists quality to ytPreferredQuality key", async () => {
      await setYouTubePreferences({ quality: "2K" });

      const raw = await chrome.storage.local.get("ytPreferredQuality");
      expect(raw.ytPreferredQuality).toBe("2K");
    });

    it("round-trips all valid quality values", async () => {
      const qualities = ["480p", "720p", "1080p", "2K", "4K"] as const;

      for (const q of qualities) {
        await setYouTubePreferences({ quality: q });
        const prefs = await getYouTubePreferences();
        expect(prefs.quality).toBe(q);
      }
    });

    it("round-trips all valid downloadMode values", async () => {
      const modes = ["video", "audio-only", "video-audio"] as const;

      for (const m of modes) {
        await setYouTubePreferences({ downloadMode: m });
        const prefs = await getYouTubePreferences();
        expect(prefs.downloadMode).toBe(m);
      }
    });
  });
});
