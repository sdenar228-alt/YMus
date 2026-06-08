// Unit tests for the popup fallback notification message builder
// (Requirements 6.1, 6.3, 6.4 — Task 8.3).

import { buildFallbackMessage } from "../../src/popup/fallback-message";

describe("buildFallbackMessage", () => {
  it("returns the FLAC→MP3 message when preferred FLAC was downloaded as MP3 (Req 6.1)", () => {
    const msg = buildFallbackMessage("flac", "mp3", undefined);
    expect(msg).toBe("FLAC недоступен для этого трека, скачан в MP3");
  });

  it("returns the FLAC→MP3 message even when worker provided a reason (Req 6.1)", () => {
    // The Service Worker resolver already produces the same Russian string,
    // but the popup MUST use its own canonical message regardless.
    const msg = buildFallbackMessage(
      "flac",
      "mp3",
      "FLAC недоступен для этого трека, скачан в MP3",
    );
    expect(msg).toBe("FLAC недоступен для этого трека, скачан в MP3");
  });

  it("returns the WAV→MP3 conversion-failure message (Req 6.4)", () => {
    const msg = buildFallbackMessage("wav", "mp3", undefined);
    expect(msg).toBe("Конвертация в WAV не удалась, скачан в MP3");
  });

  it("returns the WAV→FLAC conversion-failure message (Req 6.4)", () => {
    const msg = buildFallbackMessage("wav", "flac", undefined);
    expect(msg).toBe("Конвертация в WAV не удалась, скачан в FLAC");
  });

  it("uses popup canonical WAV-failure text even when worker gave a detailed reason", () => {
    const msg = buildFallbackMessage(
      "wav",
      "mp3",
      "Конвертация в WAV не удалась, скачан в MP3: decoder error",
    );
    // Popup intentionally produces a clean user-facing message; the detailed
    // worker reason is dropped to keep the status compact.
    expect(msg).toBe("Конвертация в WAV не удалась, скачан в MP3");
  });

  it("falls back to the worker-provided reason for unexpected fallback combinations", () => {
    const msg = buildFallbackMessage(
      "mp3",
      "flac",
      "MP3 недоступен, использован альтернативный формат",
    );
    expect(msg).toBe("MP3 недоступен, использован альтернативный формат");
  });

  it("produces a generic message when no worker reason is provided for unexpected fallback", () => {
    const msg = buildFallbackMessage("mp3", "flac", undefined);
    expect(msg).toBe("Скачан в FLAC вместо MP3");
  });
});
