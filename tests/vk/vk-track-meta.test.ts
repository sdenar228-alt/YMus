/**
 * @jest-environment jsdom
 */

import { extractVkTrackMeta } from "../../src/vk-content/vk-track-meta";

function createAudioRow(opts: {
  dataId?: string;
  artist?: string;
  title?: string;
}): HTMLElement {
  const row = document.createElement("div");
  if (opts.dataId !== undefined) {
    row.setAttribute("data-full-id", opts.dataId);
  }
  if (opts.artist !== undefined) {
    const performers = document.createElement("span");
    performers.className = "AudioRow__performers";
    performers.textContent = opts.artist;
    row.appendChild(performers);
  }
  if (opts.title !== undefined) {
    const titleEl = document.createElement("span");
    titleEl.className = "AudioRow__title";
    titleEl.textContent = opts.title;
    row.appendChild(titleEl);
  }
  return row;
}

describe("extractVkTrackMeta", () => {
  it("extracts metadata from a typical VK audio row", () => {
    const row = createAudioRow({
      dataId: "123_456",
      artist: "Artist Name",
      title: "Track Title",
    });

    const result = extractVkTrackMeta(row);

    expect(result).toEqual({
      ownerId: "123",
      audioId: "456",
      artist: "Artist Name",
      title: "Track Title",
    });
  });

  it("returns fallback artist 'Unknown' when artist element is missing", () => {
    const row = createAudioRow({
      dataId: "100_200",
      title: "Some Song",
    });

    const result = extractVkTrackMeta(row);

    expect(result).toEqual({
      ownerId: "100",
      audioId: "200",
      artist: "Unknown",
      title: "Some Song",
    });
  });

  it("returns fallback title 'audio_{audioId}' when title element is missing", () => {
    const row = createAudioRow({
      dataId: "100_789",
      artist: "Cool Artist",
    });

    const result = extractVkTrackMeta(row);

    expect(result).toEqual({
      ownerId: "100",
      audioId: "789",
      artist: "Cool Artist",
      title: "audio_789",
    });
  });

  it("returns null when data-id attribute is missing", () => {
    const row = createAudioRow({
      artist: "Some Artist",
      title: "Some Title",
    });

    const result = extractVkTrackMeta(row);

    expect(result).toBeNull();
  });

  it("handles negative owner IDs (community audio)", () => {
    const row = createAudioRow({
      dataId: "-12345_67890",
      artist: "Community Track",
      title: "Song",
    });

    const result = extractVkTrackMeta(row);

    expect(result).toEqual({
      ownerId: "-12345",
      audioId: "67890",
      artist: "Community Track",
      title: "Song",
    });
  });

  it("handles large numeric IDs", () => {
    const row = createAudioRow({
      dataId: "999999999_123456789",
      artist: "Big ID Artist",
      title: "Big ID Track",
    });

    const result = extractVkTrackMeta(row);

    expect(result).toEqual({
      ownerId: "999999999",
      audioId: "123456789",
      artist: "Big ID Artist",
      title: "Big ID Track",
    });
  });

  it("trims whitespace from artist and title", () => {
    const row = createAudioRow({
      dataId: "1_2",
      artist: "  Spaced Artist  ",
      title: "  Spaced Title  ",
    });

    const result = extractVkTrackMeta(row);

    expect(result).toEqual({
      ownerId: "1",
      audioId: "2",
      artist: "Spaced Artist",
      title: "Spaced Title",
    });
  });

  it("extracts from element with data-full-id and nested artist", () => {
    const el = document.createElement("div");
    el.setAttribute("data-full-id", "50_60");

    const performers = document.createElement("span");
    performers.className = "AudioRow__performers";
    performers.textContent = "Nested Artist";
    el.appendChild(performers);

    const result = extractVkTrackMeta(el);

    expect(result).toEqual({
      ownerId: "50",
      audioId: "60",
      artist: "Nested Artist",
      title: "audio_60",
    });
  });

  it("returns null for invalid data-id format", () => {
    const row = createAudioRow({ dataId: "invalid" });
    expect(extractVkTrackMeta(row)).toBeNull();
  });

  it("returns null for data-id with non-numeric parts", () => {
    const row = createAudioRow({ dataId: "abc_def" });
    expect(extractVkTrackMeta(row)).toBeNull();
  });
});
