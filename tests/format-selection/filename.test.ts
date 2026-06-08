import { buildFilename } from "../../src/shared/filename";

describe("buildFilename — format-selection extensions", () => {
  describe("extension mapping per codec", () => {
    it("uses .mp3 extension for mp3 codec", () => {
      const name = buildFilename({ artist: "Artist", title: "Title", codec: "mp3" });
      expect(name).toBe("Artist - Title.mp3");
    });

    it("uses .flac extension for flac codec", () => {
      const name = buildFilename({ artist: "Artist", title: "Title", codec: "flac" });
      expect(name).toBe("Artist - Title.flac");
    });

    it("uses .wav extension for wav codec", () => {
      const name = buildFilename({ artist: "Artist", title: "Title", codec: "wav" });
      expect(name).toBe("Artist - Title.wav");
    });

    it("uses .aac extension for aac codec (legacy)", () => {
      const name = buildFilename({ artist: "Artist", title: "Title", codec: "aac" });
      expect(name).toBe("Artist - Title.aac");
    });
  });

  describe("filename pattern '{Artist} - {Title}.{ext}'", () => {
    it.each(["mp3", "flac", "wav"] as const)(
      "applies the pattern for %s",
      (codec) => {
        const name = buildFilename({ artist: "The Beatles", title: "Yesterday", codec });
        expect(name).toBe(`The Beatles - Yesterday.${codec}`);
      },
    );
  });

  describe("missing artist/title", () => {
    it("substitutes 'Unknown' for empty artist", () => {
      const name = buildFilename({ artist: "", title: "Title", codec: "flac" });
      expect(name).toBe("Unknown - Title.flac");
    });

    it("substitutes 'Unknown' for empty title", () => {
      const name = buildFilename({ artist: "Artist", title: "   ", codec: "wav" });
      expect(name).toBe("Artist - Unknown.wav");
    });
  });

  describe("forbidden filesystem characters", () => {
    it("replaces forbidden characters with '_' in artist/title", () => {
      const name = buildFilename({
        artist: 'A/B\\C:D*E?F"G<H>I|J',
        title: "Title",
        codec: "flac",
      });
      expect(name).toBe("A_B_C_D_E_F_G_H_I_J - Title.flac");
    });
  });

  describe("200-character truncation", () => {
    it("truncates name part (without extension) to 200 characters for flac", () => {
      const longArtist = "A".repeat(150);
      const longTitle = "B".repeat(150);
      const name = buildFilename({ artist: longArtist, title: longTitle, codec: "flac" });

      const dotIdx = name.lastIndexOf(".");
      const namePart = name.slice(0, dotIdx);
      const ext = name.slice(dotIdx + 1);

      expect(namePart.length).toBe(200);
      expect(ext).toBe("flac");
    });

    it("truncates name part (without extension) to 200 characters for wav", () => {
      const longArtist = "X".repeat(300);
      const name = buildFilename({ artist: longArtist, title: "T", codec: "wav" });

      const dotIdx = name.lastIndexOf(".");
      const namePart = name.slice(0, dotIdx);
      const ext = name.slice(dotIdx + 1);

      expect(namePart.length).toBe(200);
      expect(ext).toBe("wav");
    });

    it("does not truncate when name part is at or below 200 characters", () => {
      const artist = "A".repeat(98); // 98 + 3 (' - ') + 99 (title) = 200
      const title = "B".repeat(99);
      const name = buildFilename({ artist, title, codec: "mp3" });

      expect(name).toBe(`${artist} - ${title}.mp3`);
      expect(name.slice(0, name.lastIndexOf(".")).length).toBe(200);
    });
  });
});
