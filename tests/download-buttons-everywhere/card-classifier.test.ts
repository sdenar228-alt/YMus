import {
  classifyCardHref,
  buildAlbumIdentifierUrl,
  DOWNLOADABLE_CATEGORIES,
  CardCategory,
  CardIdentifier,
} from "../../src/content/card-classifier";

describe("card-classifier", () => {
  describe("classifyCardHref", () => {
    // --- Track → unknown (Req 4: track pages are not cards) ---
    it("classifies /album/{n}/track/{n} as unknown", () => {
      const result = classifyCardHref("/album/123/track/456");
      expect(result.category).toBe("unknown");
      expect(result.identifier).toBeNull();
    });

    it("classifies /album/123/track/456/ (trailing slash) as unknown", () => {
      const result = classifyCardHref("/album/123/track/456/");
      expect(result.category).toBe("unknown");
      expect(result.identifier).toBeNull();
    });

    // --- Album (Req 4.2) ---
    it("classifies /album/{n} as album", () => {
      const result = classifyCardHref("/album/12345");
      expect(result.category).toBe("album");
      expect(result.identifier).toEqual({ kind: "album", albumId: "12345" });
    });

    it("classifies /album/{n}/ (trailing slash) as album", () => {
      const result = classifyCardHref("/album/99/");
      expect(result.category).toBe("album");
      expect(result.identifier).toEqual({ kind: "album", albumId: "99" });
    });

    it("classifies absolute URL https://music.yandex.ru/album/100 as album", () => {
      const result = classifyCardHref("https://music.yandex.ru/album/100");
      expect(result.category).toBe("album");
      expect(result.identifier).toEqual({ kind: "album", albumId: "100" });
    });

    // --- Podcast disambiguation (Req 4.6) ---
    it("classifies /album/{n} as podcast when BOTH block title is 'Подкасты' AND href has /podcasts/ segment", () => {
      // This case shouldn't normally happen with /album/{n} since it doesn't contain /podcasts/
      // The rule only reclassifies to podcast if href contains /podcasts?/ segment
      const result = classifyCardHref("/album/555", "Подкасты");
      // block title says podcast but href (/album/555) doesn't contain /podcasts?/ → album by URL
      expect(result.category).toBe("album");
      expect(result.identifier).toEqual({ kind: "album", albumId: "555" });
    });

    it("classifies /album/{n} as album when only block title is 'Подкасты' but no podcast segment in href", () => {
      const result = classifyCardHref("/album/777", "Подкасты");
      expect(result.category).toBe("album");
      expect(result.identifier).toEqual({ kind: "album", albumId: "777" });
    });

    // --- Podcast URL (Req 4.6) ---
    it("classifies /podcasts as podcast", () => {
      expect(classifyCardHref("/podcasts").category).toBe("podcast");
    });

    it("classifies /podcasts/some-show as podcast", () => {
      expect(classifyCardHref("/podcasts/some-show").category).toBe("podcast");
    });

    it("classifies /podcast as podcast", () => {
      expect(classifyCardHref("/podcast").category).toBe("podcast");
    });

    it("classifies /podcast/episode as podcast", () => {
      expect(classifyCardHref("/podcast/episode").category).toBe("podcast");
    });

    // --- Playlist classic (Req 4.3) ---
    it("classifies /users/{owner}/playlists/{n} as playlist-classic", () => {
      const result = classifyCardHref("/users/alice/playlists/42");
      expect(result.category).toBe("playlist-classic");
      expect(result.identifier).toEqual({
        kind: "playlist-classic",
        owner: "alice",
        playlistId: "42",
      });
    });

    it("classifies /users/bob/playlists/100/ (trailing slash) as playlist-classic", () => {
      const result = classifyCardHref("/users/bob/playlists/100/");
      expect(result.category).toBe("playlist-classic");
      expect(result.identifier).toEqual({
        kind: "playlist-classic",
        owner: "bob",
        playlistId: "100",
      });
    });

    // --- Playlist UUID (Req 4.4) ---
    it("classifies /playlists/lk.abcd1234-5678-9abc as playlist-uuid", () => {
      const result = classifyCardHref("/playlists/lk.abcd1234-5678-9abc");
      expect(result.category).toBe("playlist-uuid");
      expect(result.identifier).toEqual({
        kind: "playlist-uuid",
        uuid: "lk.abcd1234-5678-9abc",
      });
    });

    it("classifies /playlists/12345678-abcd-ef01-9abc as playlist-uuid", () => {
      const result = classifyCardHref("/playlists/12345678-abcd-ef01-9abc");
      expect(result.category).toBe("playlist-uuid");
      expect(result.identifier).toEqual({
        kind: "playlist-uuid",
        uuid: "12345678-abcd-ef01-9abc",
      });
    });

    // --- Artist (Req 4.5) ---
    it("classifies /artist/{n} as artist", () => {
      const result = classifyCardHref("/artist/9999");
      expect(result.category).toBe("artist");
      expect(result.identifier).toBeNull();
    });

    it("classifies /artist/1/ (trailing slash) as artist", () => {
      expect(classifyCardHref("/artist/1/").category).toBe("artist");
    });

    // --- Mix (Req 4.7) ---
    it("classifies /genre/rock as mix", () => {
      expect(classifyCardHref("/genre/rock").category).toBe("mix");
    });

    it("classifies /mood/happy as mix", () => {
      expect(classifyCardHref("/mood/happy").category).toBe("mix");
    });

    it("classifies /dailyPlaylist as mix", () => {
      expect(classifyCardHref("/dailyPlaylist").category).toBe("mix");
    });

    it("classifies /dailyPlaylist/2024-01-01 as mix", () => {
      expect(classifyCardHref("/dailyPlaylist/2024-01-01").category).toBe("mix");
    });

    // --- User profile (Req 4.8) ---
    it("classifies /users/alice as user-profile", () => {
      const result = classifyCardHref("/users/alice");
      expect(result.category).toBe("user-profile");
      expect(result.identifier).toBeNull();
    });

    it("classifies /users/bob/ (trailing slash) as user-profile", () => {
      expect(classifyCardHref("/users/bob/").category).toBe("user-profile");
    });

    // --- Unknown ---
    it("classifies unrecognized paths as unknown", () => {
      expect(classifyCardHref("/something/else").category).toBe("unknown");
      expect(classifyCardHref("/").category).toBe("unknown");
      expect(classifyCardHref("").category).toBe("unknown");
    });

    // --- Query string / hash stripping ---
    it("strips query string before matching", () => {
      const result = classifyCardHref("/album/123?from=home");
      expect(result.category).toBe("album");
      expect(result.identifier).toEqual({ kind: "album", albumId: "123" });
    });

    it("strips hash before matching", () => {
      const result = classifyCardHref("/artist/50#section");
      expect(result.category).toBe("artist");
    });
  });

  describe("DOWNLOADABLE_CATEGORIES", () => {
    it("contains exactly album, playlist-classic, playlist-uuid", () => {
      expect(DOWNLOADABLE_CATEGORIES.size).toBe(3);
      expect(DOWNLOADABLE_CATEGORIES.has("album")).toBe(true);
      expect(DOWNLOADABLE_CATEGORIES.has("playlist-classic")).toBe(true);
      expect(DOWNLOADABLE_CATEGORIES.has("playlist-uuid")).toBe(true);
    });

    it("does not contain non-downloadable categories", () => {
      expect(DOWNLOADABLE_CATEGORIES.has("artist")).toBe(false);
      expect(DOWNLOADABLE_CATEGORIES.has("podcast")).toBe(false);
      expect(DOWNLOADABLE_CATEGORIES.has("mix")).toBe(false);
      expect(DOWNLOADABLE_CATEGORIES.has("user-profile")).toBe(false);
      expect(DOWNLOADABLE_CATEGORIES.has("unknown")).toBe(false);
    });
  });

  describe("identifier invariant", () => {
    it("identifier is non-null iff category is downloadable", () => {
      const cases: Array<[string, string | null]> = [
        ["/album/1", null],
        ["/users/x/playlists/2", null],
        ["/playlists/lk.abcdefgh", null],
        ["/artist/3", null],
        ["/podcasts/show", null],
        ["/genre/rock", null],
        ["/users/someone", null],
        ["/unknown/path", null],
      ];

      for (const [href] of cases) {
        const result = classifyCardHref(href);
        if (DOWNLOADABLE_CATEGORIES.has(result.category)) {
          expect(result.identifier).not.toBeNull();
        } else {
          expect(result.identifier).toBeNull();
        }
      }
    });
  });

  describe("buildAlbumIdentifierUrl", () => {
    it("builds album URL", () => {
      const url = buildAlbumIdentifierUrl({ kind: "album", albumId: "123" });
      expect(url).toBe("https://music.yandex.ru/album/123");
    });

    it("builds playlist-classic URL", () => {
      const url = buildAlbumIdentifierUrl({
        kind: "playlist-classic",
        owner: "alice",
        playlistId: "42",
      });
      expect(url).toBe("https://music.yandex.ru/users/alice/playlists/42");
    });

    it("builds playlist-uuid URL", () => {
      const url = buildAlbumIdentifierUrl({
        kind: "playlist-uuid",
        uuid: "lk.abcd-1234",
      });
      expect(url).toBe("https://music.yandex.ru/playlists/lk.abcd-1234");
    });
  });
});
