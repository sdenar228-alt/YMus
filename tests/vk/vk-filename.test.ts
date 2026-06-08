import { buildVkFilename, VkFilenameParams } from "../../src/shared/vk-filename";

describe("buildVkFilename", () => {
  it("produces correct filename from artist and title", () => {
    const result = buildVkFilename({
      artist: "Imagine Dragons",
      title: "Believer",
      ownerId: "123",
      audioId: "456",
      ext: "mp3",
    });
    expect(result).toBe("Imagine Dragons - Believer.mp3");
  });

  it("replaces forbidden characters with underscore", () => {
    const result = buildVkFilename({
      artist: 'AC/DC',
      title: 'Who Made Who?',
      ownerId: "1",
      audioId: "2",
      ext: "mp3",
    });
    expect(result).toBe("AC_DC - Who Made Who_.mp3");
    // Verify no forbidden chars remain in name part
    const namePart = result.slice(0, result.lastIndexOf("."));
    expect(namePart).not.toMatch(/[\\/:*?"<>|]/);
  });

  it("truncates name part at 200 characters", () => {
    const longArtist = "A".repeat(150);
    const longTitle = "B".repeat(150);
    const result = buildVkFilename({
      artist: longArtist,
      title: longTitle,
      ownerId: "1",
      audioId: "2",
      ext: "flac",
    });
    const namePart = result.slice(0, result.lastIndexOf("."));
    expect(namePart.length).toBeLessThanOrEqual(200);
    expect(result.endsWith(".flac")).toBe(true);
  });

  it("returns fallback when artist is 'Unknown' and title is empty", () => {
    const result = buildVkFilename({
      artist: "Unknown",
      title: "",
      ownerId: "789",
      audioId: "012",
      ext: "wav",
    });
    expect(result).toBe("vk_audio_789_012.wav");
  });

  it("returns fallback when both artist and title are empty strings", () => {
    const result = buildVkFilename({
      artist: "",
      title: "",
      ownerId: "111",
      audioId: "222",
      ext: "mp3",
    });
    expect(result).toBe("vk_audio_111_222.mp3");
  });

  it("does NOT use fallback when only one of artist/title is empty", () => {
    const result = buildVkFilename({
      artist: "Some Artist",
      title: "",
      ownerId: "1",
      audioId: "2",
      ext: "mp3",
    });
    // title is empty but artist is valid — no fallback
    expect(result).not.toContain("vk_audio_");
  });
});
