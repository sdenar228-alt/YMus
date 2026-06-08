import { resolveFormat, PreviewOnlyError } from "../../src/background/format-resolver";
import type { DownloadInfoEntry } from "../../src/shared/types";

describe("resolveFormat", () => {
  const mp3_128: DownloadInfoEntry = {
    codec: "mp3",
    bitrateInKbps: 128,
    preview: false,
    downloadInfoUrl: "https://example.com/mp3-128",
  };

  const mp3_320: DownloadInfoEntry = {
    codec: "mp3",
    bitrateInKbps: 320,
    preview: false,
    downloadInfoUrl: "https://example.com/mp3-320",
  };

  const flac_1411: DownloadInfoEntry = {
    codec: "flac",
    bitrateInKbps: 1411,
    preview: false,
    downloadInfoUrl: "https://example.com/flac-1411",
  };

  const mp3_preview: DownloadInfoEntry = {
    codec: "mp3",
    bitrateInKbps: 192,
    preview: true,
    downloadInfoUrl: "https://example.com/mp3-preview",
  };

  const flac_preview: DownloadInfoEntry = {
    codec: "flac",
    bitrateInKbps: 1411,
    preview: true,
    downloadInfoUrl: "https://example.com/flac-preview",
  };

  describe("preferred format: mp3", () => {
    it("selects highest-bitrate non-preview MP3 entry", () => {
      const result = resolveFormat([mp3_128, mp3_320, flac_1411], "mp3");
      expect(result.entry).toBe(mp3_320);
      expect(result.outputFormat).toBe("mp3");
      expect(result.fellBack).toBe(false);
    });

    it("ignores preview entries", () => {
      const result = resolveFormat([mp3_preview, mp3_128], "mp3");
      expect(result.entry).toBe(mp3_128);
      expect(result.outputFormat).toBe("mp3");
      expect(result.fellBack).toBe(false);
    });
  });

  describe("preferred format: flac", () => {
    it("selects highest-bitrate non-preview FLAC entry when available", () => {
      const result = resolveFormat([mp3_320, flac_1411], "flac");
      expect(result.entry).toBe(flac_1411);
      expect(result.outputFormat).toBe("flac");
      expect(result.fellBack).toBe(false);
    });

    it("uses best MP3 as source for FLAC repacking when no non-preview FLAC exists", () => {
      // С новой политикой preferred=flac никогда не падает в outputFormat=mp3:
      // если настоящего FLAC нет, message-router перепакует MP3 → FLAC.
      const result = resolveFormat([mp3_128, mp3_320, flac_preview], "flac");
      expect(result.entry).toBe(mp3_320);
      expect(result.outputFormat).toBe("flac");
      expect(result.fellBack).toBe(false);
    });
  });

  describe("preferred format: wav", () => {
    it("selects FLAC source when available (preferred for conversion)", () => {
      const result = resolveFormat([mp3_320, flac_1411], "wav");
      expect(result.entry).toBe(flac_1411);
      expect(result.outputFormat).toBe("wav");
      expect(result.fellBack).toBe(false);
    });

    it("falls back to MP3 source when no FLAC available", () => {
      const result = resolveFormat([mp3_128, mp3_320], "wav");
      expect(result.entry).toBe(mp3_320);
      expect(result.outputFormat).toBe("wav");
      expect(result.fellBack).toBe(false);
    });
  });

  describe("PreviewOnlyError", () => {
    it("throws when all entries are preview-only", () => {
      expect(() => resolveFormat([mp3_preview, flac_preview], "mp3")).toThrow(
        PreviewOnlyError,
      );
    });

    it("throws when entries array is empty", () => {
      expect(() => resolveFormat([], "flac")).toThrow(PreviewOnlyError);
    });

    it("throws for wav when all entries are preview-only", () => {
      expect(() => resolveFormat([mp3_preview], "wav")).toThrow(
        PreviewOnlyError,
      );
    });
  });
});
