import { extractVideoId } from "../../src/shared/yt-video-id";

describe("extractVideoId", () => {
  test("extracts id from /watch?v=", () => {
    expect(
      extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toBe("dQw4w9WgXcQ");
  });

  test("extracts id from /watch?...&v=...", () => {
    expect(
      extractVideoId("https://www.youtube.com/watch?feature=related&v=dQw4w9WgXcQ"),
    ).toBe("dQw4w9WgXcQ");
  });

  test("extracts id from youtu.be short link", () => {
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  test("extracts id from /shorts/", () => {
    expect(
      extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
    ).toBe("dQw4w9WgXcQ");
  });

  test("returns null for empty / non-string", () => {
    expect(extractVideoId("")).toBeNull();
    // @ts-expect-error: testing runtime guard
    expect(extractVideoId(null)).toBeNull();
    // @ts-expect-error: testing runtime guard
    expect(extractVideoId(undefined)).toBeNull();
  });

  test("returns null for a 10-char id", () => {
    expect(
      extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXc"),
    ).toBeNull();
  });

  test("returns null for non-YouTube URL", () => {
    expect(extractVideoId("https://example.com/page")).toBeNull();
  });

  test("returns null for unrelated path with `v=` fragment", () => {
    expect(extractVideoId("https://example.com/file.html?v=zzz")).toBeNull();
  });
});
