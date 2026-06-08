import { getFormatPreferences, setFormatPreferences } from "../../src/shared/format-storage";

describe("format-storage", () => {
  beforeEach(() => {
    // Clear chrome.storage.local mock between tests
    (chrome.storage.local as any).clear();
  });

  describe("getFormatPreferences", () => {
    it("returns defaults when storage is empty", async () => {
      const prefs = await getFormatPreferences();
      expect(prefs).toEqual({
        singleTrackFormat: "mp3",
        bulkFormat: "mp3",
      });
    });

    it("returns stored values when present", async () => {
      await chrome.storage.local.set({
        ymd_format_prefs: {
          singleTrackFormat: "flac",
          bulkFormat: "wav",
        },
      });

      const prefs = await getFormatPreferences();
      expect(prefs).toEqual({
        singleTrackFormat: "flac",
        bulkFormat: "wav",
      });
    });

    it("treats invalid singleTrackFormat as mp3", async () => {
      await chrome.storage.local.set({
        ymd_format_prefs: {
          singleTrackFormat: "ogg",
          bulkFormat: "flac",
        },
      });

      const prefs = await getFormatPreferences();
      expect(prefs.singleTrackFormat).toBe("mp3");
      expect(prefs.bulkFormat).toBe("flac");
    });

    it("treats invalid bulkFormat as mp3", async () => {
      await chrome.storage.local.set({
        ymd_format_prefs: {
          singleTrackFormat: "wav",
          bulkFormat: 123,
        },
      });

      const prefs = await getFormatPreferences();
      expect(prefs.singleTrackFormat).toBe("wav");
      expect(prefs.bulkFormat).toBe("mp3");
    });

    it("returns defaults when stored value is null", async () => {
      await chrome.storage.local.set({ ymd_format_prefs: null });

      const prefs = await getFormatPreferences();
      expect(prefs).toEqual({
        singleTrackFormat: "mp3",
        bulkFormat: "mp3",
      });
    });
  });

  describe("setFormatPreferences", () => {
    it("persists full preferences", async () => {
      await setFormatPreferences({
        singleTrackFormat: "flac",
        bulkFormat: "wav",
      });

      const prefs = await getFormatPreferences();
      expect(prefs).toEqual({
        singleTrackFormat: "flac",
        bulkFormat: "wav",
      });
    });

    it("supports partial update of singleTrackFormat", async () => {
      await setFormatPreferences({ singleTrackFormat: "wav" });

      const prefs = await getFormatPreferences();
      expect(prefs.singleTrackFormat).toBe("wav");
      expect(prefs.bulkFormat).toBe("mp3"); // default preserved
    });

    it("supports partial update of bulkFormat", async () => {
      await setFormatPreferences({ bulkFormat: "flac" });

      const prefs = await getFormatPreferences();
      expect(prefs.singleTrackFormat).toBe("mp3"); // default preserved
      expect(prefs.bulkFormat).toBe("flac");
    });

    it("ignores invalid values in partial update", async () => {
      await setFormatPreferences({ singleTrackFormat: "flac", bulkFormat: "wav" });
      await setFormatPreferences({ singleTrackFormat: "invalid" as any });

      const prefs = await getFormatPreferences();
      expect(prefs.singleTrackFormat).toBe("flac"); // kept previous valid value
      expect(prefs.bulkFormat).toBe("wav");
    });

    it("round-trips all valid formats", async () => {
      const formats = ["mp3", "flac", "wav"] as const;

      for (const fmt of formats) {
        await setFormatPreferences({ singleTrackFormat: fmt, bulkFormat: fmt });
        const prefs = await getFormatPreferences();
        expect(prefs.singleTrackFormat).toBe(fmt);
        expect(prefs.bulkFormat).toBe(fmt);
      }
    });
  });
});
