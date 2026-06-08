import { buildWavListInfoChunk, buildWavFile, WavMeta } from "../../src/background/wav-meta";

describe("buildWavListInfoChunk", () => {
  it("returns empty array when all fields are empty", () => {
    const result = buildWavListInfoChunk({});
    expect(result.length).toBe(0);
  });

  it("returns empty array when fields are empty strings", () => {
    const result = buildWavListInfoChunk({ artist: "", title: "", album: "", year: "", trackNumber: "" });
    expect(result.length).toBe(0);
  });

  it("builds LIST/INFO chunk with artist field", () => {
    const result = buildWavListInfoChunk({ artist: "Test" });
    const text = new TextDecoder().decode(result);
    expect(text.startsWith("LIST")).toBe(true);
    expect(text).toContain("INFO");
    expect(text).toContain("IART");
    expect(text).toContain("Test");
  });

  it("builds chunk with all fields populated", () => {
    const meta: WavMeta = {
      artist: "Artist",
      title: "Title",
      album: "Album",
      year: "2024",
      trackNumber: "5",
    };
    const result = buildWavListInfoChunk(meta);
    const text = new TextDecoder().decode(result);
    expect(text).toContain("IART");
    expect(text).toContain("INAM");
    expect(text).toContain("IPRD");
    expect(text).toContain("ICRD");
    expect(text).toContain("ITRK");
  });

  it("pads sub-chunk data to even length", () => {
    // "Hi" = 2 bytes + 1 null = 3 bytes → padded to 4
    const result = buildWavListInfoChunk({ artist: "Hi" });
    // LIST(4) + size(4) + INFO(4) + IART(4) + subSize(4) + data(4) = 24
    expect(result.length % 2).toBe(0);
  });
});

describe("buildWavFile", () => {
  it("produces valid 44-byte header for empty PCM data", () => {
    const pcm = new Uint8Array(0);
    const wav = buildWavFile(pcm, 44100, 2, 16);

    // Minimum WAV file: 44 bytes header + 0 data
    expect(wav.length).toBe(44);

    // Check RIFF header
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
  });

  it("sets correct RIFF size field", () => {
    const pcm = new Uint8Array(1000);
    const wav = buildWavFile(pcm, 44100, 2, 16);

    // RIFF size = fileSize - 8
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const riffSize = view.getUint32(4, true);
    expect(riffSize).toBe(wav.length - 8);
  });

  it("sets audioFormat = 1 (PCM)", () => {
    const pcm = new Uint8Array(100);
    const wav = buildWavFile(pcm, 44100, 2, 16);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    // fmt chunk starts at offset 12, audioFormat at offset 20
    expect(view.getUint16(20, true)).toBe(1);
  });

  it("sets correct sample rate, channels, and bits per sample", () => {
    const pcm = new Uint8Array(100);
    const wav = buildWavFile(pcm, 48000, 1, 16);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(view.getUint16(22, true)).toBe(1);     // channels
    expect(view.getUint32(24, true)).toBe(48000);  // sampleRate
    expect(view.getUint16(34, true)).toBe(16);     // bitsPerSample
  });

  it("sets correct byteRate = sampleRate * channels * bitsPerSample/8", () => {
    const pcm = new Uint8Array(100);
    const wav = buildWavFile(pcm, 44100, 2, 16);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    const expectedByteRate = 44100 * 2 * 2; // 176400
    expect(view.getUint32(28, true)).toBe(expectedByteRate);
  });

  it("sets data chunk size equal to PCM data length", () => {
    const pcm = new Uint8Array(2048);
    const wav = buildWavFile(pcm, 44100, 2, 16);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    // data chunk header starts at offset 36
    expect(String.fromCharCode(...wav.slice(36, 40))).toBe("data");
    expect(view.getUint32(40, true)).toBe(2048);
  });

  it("includes PCM data after header", () => {
    const pcm = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const wav = buildWavFile(pcm, 44100, 1, 16);

    expect(wav[44]).toBe(0x01);
    expect(wav[45]).toBe(0x02);
    expect(wav[46]).toBe(0x03);
    expect(wav[47]).toBe(0x04);
  });

  it("appends LIST/INFO chunk when metadata is provided", () => {
    const pcm = new Uint8Array(100);
    const meta: WavMeta = { artist: "Test Artist", title: "Test Song" };
    const wav = buildWavFile(pcm, 44100, 2, 16, meta);

    // File should be larger than 44 + pcm
    expect(wav.length).toBeGreaterThan(44 + 100);

    // LIST chunk should appear after PCM data
    const afterData = wav.slice(44 + 100);
    const listStr = String.fromCharCode(...afterData.slice(0, 4));
    expect(listStr).toBe("LIST");
  });

  it("produces valid WAV without metadata when meta fields are empty", () => {
    const pcm = new Uint8Array(200);
    const wav = buildWavFile(pcm, 44100, 2, 16, { artist: "", title: "" });

    // No LIST chunk appended — file is exactly header + pcm
    expect(wav.length).toBe(44 + 200);
  });
});
