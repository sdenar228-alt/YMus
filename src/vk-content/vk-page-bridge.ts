/**
 * VK Page Bridge — runs in MAIN world (page context).
 * Gets audio URL via VK's internal API and decodes it.
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=";

function b64(e: string): string | false {
  if (!e || e.length % 4 === 1) return false;
  let t: number = 0, n: string, r = 0, o = 0, a = "";
  for (; (n = e.charAt(o++)); ) {
    const idx = ALPHABET.indexOf(n);
    if (~idx) { t = r % 4 ? 64 * t + idx : idx; if (r++ % 4) a += String.fromCharCode(255 & (t >> ((-2 * r) & 6))); }
  }
  return a;
}

const ops: any = {
  v(e: string) { return e.split("").reverse().join(""); },
  r(e: string, t: string) {
    const chars = e.split(""); const d = ALPHABET + ALPHABET; const shift = parseInt(t, 10) || 0;
    let i = chars.length; for (; i--;) { const idx = d.indexOf(chars[i]); if (~idx) chars[i] = d.substr(idx - shift, 1); }
    return chars.join("");
  },
  s(e: string, t: bigint) {
    const n = e.length; if (!n) return e;
    const indices: number[] = new Array(n);
    const len = BigInt(n); let seed = t < 0n ? -t : t;
    for (let o = n - 1; o >= 0; o--) { seed = (len * BigInt(o + 1) ^ seed + BigInt(o)) % len; indices[o] = Number(seed); }
    const chars = e.split(""); let o = 0;
    for (; ++o < n;) chars[o] = chars.splice(indices[n - 1 - o], 1, chars[o])[0];
    return chars.join("");
  },
  i(e: string, t: string) {
    const n = BigInt(parseInt(t, 10) || 0);
    const vkId = (window as any).vk?.id ?? 0;
    const r = BigInt(vkId) ^ n;
    return ops.s(e, r);
  },
  x(e: string, t: string) {
    const code = t.charCodeAt(0);
    return e.split("").map(ch => String.fromCharCode(ch.charCodeAt(0) ^ code)).join("");
  },
};

function decode(encodedUrl: string): string | null {
  if (!encodedUrl || !encodedUrl.includes("audio_api_unavailable")) {
    if (encodedUrl?.startsWith("https://")) return encodedUrl;
    return null;
  }
  try {
    const parts = encodedUrl.split("?extra=")[1].split("#");
    let instructions = parts[1] === "" ? "" : b64(parts[1]);
    let data = b64(parts[0]);
    if (typeof instructions !== "string" || !data) return null;
    const ops_list = instructions ? instructions.split(String.fromCharCode(9)) : [];
    let result: string = data;
    let i = ops_list.length;
    for (; i--;) {
      const p = ops_list[i].split(String.fromCharCode(11));
      const opName = p.splice(0, 1, result)[0];
      if (!ops[opName]) return null;
      result = ops[opName].apply(null, p);
    }
    if (result?.startsWith("http")) return result;
  } catch {}
  return null;
}

// Listen for requests from content script
document.addEventListener("ymus-get-url", async (event) => {
  const { ownerId, audioId, requestId, accessKey } = (event as CustomEvent).detail;
  let url: string | null = null;

  // Strategy 0: Direct POST to al_audio.php?act=reload_audios
  // Works for ANY track (recommendations, search, artist page, posts) without
  // needing it to be in the player's playlist. Reverse-engineered from VK's
  // own reload_audios call that fires on Play. Requires accessKey for tracks
  // outside the user's "My music".
  try {
    const fullId = accessKey
      ? `${ownerId}_${audioId}_${accessKey}`
      : `${ownerId}_${audioId}`;
    console.log(`[YMus page-bridge] Strategy 0: POST reload_audios for ${fullId}`);

    const params = new URLSearchParams();
    params.append("al", "1");
    params.append("audio_ids", fullId);

    const resp = await fetch("/al_audio.php?act=reload_audios", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: params.toString(),
    });

    if (resp.ok) {
      const text = await resp.text();
      // VK ranges between bare JSON and `<!--{...}-->` envelope; strip the prefix if present.
      const jsonStart = text.indexOf("{");
      const json = jsonStart >= 0 ? JSON.parse(text.slice(jsonStart)) : null;
      // payload[1][0] is array of [audio_array, ...]; audio_array[2] is encrypted URL.
      const payloadEntry =
        json?.payload?.[1]?.[0]?.[0] ??
        json?.payload?.[1]?.[0] ??
        null;
      const encryptedUrl =
        Array.isArray(payloadEntry) && typeof payloadEntry[2] === "string"
          ? payloadEntry[2]
          : null;
      if (encryptedUrl) {
        url = decode(encryptedUrl);
        if (url) url = url.replace("?siren=1", "").replace("&siren=1", "");
        console.log(`[YMus page-bridge] Strategy 0: got url=${url ? url.slice(0, 60) + "..." : "decode-failed"}`);
      } else {
        console.log(`[YMus page-bridge] Strategy 0: no encrypted url in payload`);
      }
    } else {
      console.log(`[YMus page-bridge] Strategy 0: HTTP ${resp.status}`);
    }
  } catch (e: any) {
    console.log(`[YMus page-bridge] Strategy 0 error:`, e?.message || e);
  }

  if (url) {
    document.dispatchEvent(new CustomEvent("ymus-url-result", { detail: { requestId, url } }));
    return;
  }

  // Strategy 1: Try to get URL from React fiber (works for new VK pages)
  try {
    const rows = document.querySelectorAll('[data-testid="MusicPlaylistTracks_MusicTrackRow"]');
    for (const row of rows) {
      const fk = Object.keys(row).find(k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
      if (!fk) continue;
      let cur = (row as any)[fk];
      for (let i = 0; i < 10; i++) {
        if (!cur) break;
        const p = cur.memoizedProps;
        if (p && p.track && p.track.entity) {
          const ent = p.track.entity;
          const id = ent.identity;
          if (id && String(id.id) === String(audioId) && String(id.ownerId) === String(ownerId)) {
            const fiberUrl = ent.url || ent.apiAudio?.url || null;
            if (fiberUrl && fiberUrl.startsWith("https://")) {
              url = fiberUrl;
              console.log(`[YMus page-bridge] ymus-get-url: got URL from fiber for ${ownerId}_${audioId}`);
            }
          }
          break;
        }
        cur = cur.return;
      }
      if (url) break;
    }
  } catch {}

  // If fiber gave us a URL, respond immediately
  if (url) {
    document.dispatchEvent(new CustomEvent("ymus-url-result", { detail: { requestId, url } }));
    return;
  }

  // Strategy 2: VK player _ensureHasURL (classic pages)

  try {
    const player = (window as any).getAudioPlayer?.();
    if (!player) {
      console.log(`[YMus page-bridge] ymus-get-url: no player for ${ownerId}_${audioId}`);
      throw new Error("no player");
    }
    
    let audio: any = null;
    
    // Try DOM row first (classic approach)
    const row = document.querySelector(`.audio_row[data-full-id="${ownerId}_${audioId}"]`);
    if (row) {
      audio = (window as any).AudioUtils?.getAudioFromEl?.(row);
    }
    
    // Fallback: find audio in player playlist by ownerId/audioId
    if (!audio) {
      const playlist = player.getCurrentPlaylist?.();
      const audiosList = playlist?.getAudiosList?.() || [];
      for (const a of audiosList) {
        if (Array.isArray(a) && String(a[0]) === String(audioId) && String(a[1]) === String(ownerId)) {
          audio = a;
          break;
        }
      }
    }
    
    // Fallback: construct minimal audio array for _ensureHasURL
    if (!audio) {
      audio = [parseInt(audioId, 10), parseInt(ownerId, 10), "", "", ""];
    }
    
    const result = await player._ensureHasURL(audio);
    const encryptedUrl = result?.url || audio[2] || null;
    console.log(`[YMus page-bridge] ymus-get-url: ${ownerId}_${audioId} → encUrl=${encryptedUrl ? encryptedUrl.substring(0, 50) + '...' : 'null'}`);
    if (encryptedUrl) {
      url = decode(encryptedUrl);
      // Remove siren param — VK serves unencrypted without it
      if (url) {
        url = url.replace("?siren=1", "").replace("&siren=1", "");
      }
    }
    console.log(`[YMus page-bridge] ymus-get-url: decoded url=${url ? url.substring(0, 60) + '...' : 'null'}`);
  } catch (e: any) {
    console.log(`[YMus page-bridge] ymus-get-url error for ${ownerId}_${audioId}:`, e?.message || e);
  }

  // Strategy 3: Silent play — NOT NEEDED, _ensureHasURL works without play.
  // The issue is CustomEvent detail not passing between worlds.
  // Fallback: write URL to a hidden DOM element that content script can read.
  if (!url) {
    try {
      const player = (window as any).getAudioPlayer?.();
      if (player) {
        const audio = [parseInt(audioId, 10), parseInt(ownerId, 10), "", "", ""];
        const result = await player._ensureHasURL(audio);
        const encryptedUrl = result?.url || audio[2] || null;
        if (encryptedUrl) {
          url = decode(encryptedUrl);
          if (url) url = url.replace("?siren=1", "").replace("&siren=1", "");
          console.log(`[YMus page-bridge] ymus-get-url: retry _ensureHasURL got URL for ${ownerId}_${audioId}`);
        }
      }
    } catch {}
  }

  // Dispatch result AND write to DOM (double delivery for reliability)
  const resultEl = document.getElementById("ymus-url-result-data") || document.createElement("div");
  resultEl.id = "ymus-url-result-data";
  resultEl.setAttribute("data-request-id", requestId);
  resultEl.setAttribute("data-url", url || "");
  resultEl.style.display = "none";
  if (!resultEl.parentElement) document.body.appendChild(resultEl);
  
  document.dispatchEvent(new CustomEvent("ymus-url-result", { detail: { requestId, url } }));
});

// Listen for playlist tracks request — returns tracks from VK API, fiber, or player
document.addEventListener("ymus-get-playlist-tracks", async (event) => {
  const { requestId } = (event as CustomEvent).detail;

  // Strategy 1: VK API request (most reliable — gets ALL tracks regardless of DOM state)
  try {
    const apiTracks = await fetchPlaylistTracksViaApi();
    if (apiTracks.length > 0) {
      console.log(`[YMus page-bridge] VK API: ${apiTracks.length} tracks`);
      document.dispatchEvent(new CustomEvent("ymus-playlist-tracks-result", { detail: { requestId, tracks: apiTracks } }));
      return;
    }
  } catch (e) {
    console.log("[YMus page-bridge] VK API failed:", e);
  }

  // Strategy 2: Try React fiber — get track IDs from VISIBLE rows only (current playlist)
  try {
    const fiberTracks = extractPlaylistTracksFromFiber();
    if (fiberTracks.length > 0) {
      console.log(`[YMus page-bridge] Fiber extraction: ${fiberTracks.length} tracks`);
      document.dispatchEvent(new CustomEvent("ymus-playlist-tracks-result", { detail: { requestId, tracks: fiberTracks } }));
      return;
    }
  } catch (e) {
    console.log("[YMus page-bridge] Fiber extraction failed:", e);
  }

  // Strategy 3: VK Player API (old pages)
  let tracks: Array<{ownerId: string; audioId: string; artist: string; title: string}> = [];
  try {
    const player = (window as any).getAudioPlayer?.();
    if (player) {
      const playlist = player.getCurrentPlaylist?.();
      const audiosList = playlist?.getAudiosList?.() || [];
      
      for (const audio of audiosList) {
        if (!Array.isArray(audio) || audio.length < 5) continue;
        tracks.push({
          audioId: String(audio[0]),
          ownerId: String(audio[1]),
          title: audio[3] || "audio",
          artist: audio[4] || "Unknown",
        });
      }
    }
  } catch {}

  console.log(`[YMus page-bridge] Player API: ${tracks.length} tracks`);
  document.dispatchEvent(new CustomEvent("ymus-playlist-tracks-result", { detail: { requestId, tracks } }));
});

/**
 * Fetch playlist tracks via VK internal API (al_audio.php or audio.get).
 * Parses playlist ownerId/id/accessKey from current URL.
 * Supports both /music/playlist/... and ?z=audio_playlist... URL formats.
 * Returns all tracks in the playlist, regardless of DOM rendering.
 */
async function fetchPlaylistTracksViaApi(): Promise<Array<{ownerId: string; audioId: string; artist: string; title: string}>> {
  const url = location.href;
  
  // Try /music/playlist/{ownerId}_{playlistId}_{accessKey}
  let plOwnerId: string | null = null;
  let plId: string | null = null;
  let accessKey = "";

  const musicMatch = url.match(/\/music\/playlist\/(-?\d+)_(\d+)_?([a-f0-9]*)/);
  if (musicMatch) {
    plOwnerId = musicMatch[1];
    plId = musicMatch[2];
    accessKey = musicMatch[3] || "";
  }

  // Try z=audio_playlist{ownerId}_{playlistId}_{accessKey}
  if (!plOwnerId) {
    const zMatch = url.match(/[?&]z=audio_playlist(-?\d+)_(\d+)(?:_([a-f0-9]+))?/);
    if (zMatch) {
      plOwnerId = zMatch[1];
      plId = zMatch[2];
      accessKey = zMatch[3] || "";
    }
  }

  // Also try simpler z=audio_playlist{ownerId}_{playlistId} without accessKey
  if (!plOwnerId) {
    const zSimple = url.match(/[?&]z=audio_playlist(-?\d+)_(\d+)/);
    if (zSimple) {
      plOwnerId = zSimple[1];
      plId = zSimple[2];
    }
  }

  if (!plOwnerId || !plId) {
    console.log("[YMus page-bridge] Cannot parse playlist from URL:", url);
    return [];
  }

  console.log(`[YMus page-bridge] Fetching playlist via API: owner=${plOwnerId}, id=${plId}, key=${accessKey}`);

  // Try VK internal API via al_audio.php
  try {
    const formData = new FormData();
    formData.append("act", "load_section");
    formData.append("al", "1");
    formData.append("claim", "0");
    formData.append("offset", "0");
    formData.append("owner_id", plOwnerId);
    formData.append("playlist_id", plId);
    formData.append("access_hash", accessKey);
    formData.append("type", "playlist");
    formData.append("is_loading_all", "1");

    const resp = await fetch("/al_audio.php", {
      method: "POST",
      body: formData,
      credentials: "same-origin",
    });

    if (resp.ok) {
      // VK may return windows-1251, but modern VK pages use UTF-8
      // Try to get response as text — browser will use response headers for encoding
      const blob = await resp.blob();
      // First try UTF-8
      let text = await blob.text();
      // If we see mojibake (replacement chars), try windows-1251
      if (text.includes("\ufffd") || text.includes("Ð")) {
        const reader = new FileReader();
        text = await new Promise<string>((resolve) => {
          reader.onload = () => resolve(reader.result as string);
          reader.readAsText(blob, "windows-1251");
        });
      }
      const tracks = parseAlAudioResponse(text);
      if (tracks.length > 0) return tracks;
    }
  } catch (e) {
    console.log("[YMus page-bridge] al_audio.php failed:", e);
  }

  return [];
}

/**
 * Parse response from al_audio.php — extracts audio arrays.
 * VK response format: contains a JSON payload with "list" array of audio arrays.
 * Each audio: [audioId, ownerId, encUrl, title, artist, duration, ...]
 * Also handles the raw <!json> format VK uses.
 */
function parseAlAudioResponse(text: string): Array<{ownerId: string; audioId: string; artist: string; title: string}> {
  const tracks: Array<{ownerId: string; audioId: string; artist: string; title: string}> = [];
  const seen = new Set<string>();

  // VK al_audio.php returns something like: <!--{"type":"playlist",...,"list":[[audioId,ownerId,...],...],...}-->
  // Try to find the JSON object with "list" field
  try {
    // Find JSON payload — VK wraps it in <!--{...}-->  or returns raw after delimiter
    const jsonMatches = text.match(/<!(?:--|json)>(.*?)(?:<!|$)/s);
    let jsonStr = jsonMatches ? jsonMatches[1] : null;
    
    // Also try: response may start with <!--  and have multiple payloads separated by <!--
    if (!jsonStr) {
      const parts = text.split("<!--");
      for (const part of parts) {
        const trimmed = part.replace(/-->.*$/s, "").trim();
        if (trimmed.startsWith("{") && trimmed.includes('"list"')) {
          jsonStr = trimmed;
          break;
        }
      }
    }

    if (jsonStr) {
      const data = JSON.parse(jsonStr);
      const list = data.list || data.audios || [];
      
      for (const audio of list) {
        if (!Array.isArray(audio) || audio.length < 5) continue;
        const audioId = String(audio[0]);
        const ownerId = String(audio[1]);
        const encUrl = audio[2] || "";
        const title = decodeVkString(String(audio[3] || "audio"));
        const artist = decodeVkString(String(audio[4] || "Unknown"));
        const key = `${ownerId}_${audioId}`;
        
        // Skip tracks with no URL (blocked/unavailable)
        if (!encUrl) {
          console.log(`[YMus page-bridge] Skipping unavailable: ${artist} - ${title}`);
          continue;
        }
        
        if (!seen.has(key)) {
          seen.add(key);
          tracks.push({ ownerId, audioId, artist, title });
        }
      }
      
      if (tracks.length > 0) {
        console.log(`[YMus page-bridge] Parsed JSON list: ${tracks.length} available tracks`);
        return tracks;
      }
    }
  } catch (e) {
    console.log("[YMus page-bridge] JSON parse failed, falling back to regex:", e);
  }

  // Fallback: regex extraction (less reliable, may pick up extra arrays)
  const audioRegex = /\[(\d+),(-?\d+),"((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)","((?:[^"\\]|\\.)*)"/g;
  let match;
  
  while ((match = audioRegex.exec(text)) !== null) {
    const audioId = match[1];
    const ownerId = match[2];
    const encUrl = match[3];
    const title = decodeVkString(match[4]) || "audio";
    const artist = decodeVkString(match[5]) || "Unknown";
    const key = `${ownerId}_${audioId}`;
    
    if (!encUrl) continue;
    
    if (!seen.has(key)) {
      seen.add(key);
      tracks.push({ ownerId, audioId, artist, title });
    }
  }

  console.log(`[YMus page-bridge] Parsed al_audio (regex fallback): ${tracks.length} available tracks from ${text.length} chars`);
  return tracks;
}

/**
 * Decode VK string — handles HTML entities and unicode escapes.
 */
function decodeVkString(str: string): string {
  if (!str) return str;
  let decoded = str.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  decoded = decoded.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
  decoded = decoded.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  return decoded;
}

/**
 * Get expected track count from DOM header ("Треки 40", "3 трека", etc.)
 */
function getExpectedTrackCount(): number {
  const selectors = [
    '[class*="AudioListHeader__title"]',
    '[class*="audio_page_block__title"]',
    '[class*="MusicPlaylistStatistics__text"]',
    '[class*="vkitMusicPlaylistStatistics"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const match = el.textContent?.match(/(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
  }
  return 0;
}

/**
 * Extract playlist tracks from React fiber props (runs in main world — has access to fiber).
 * Strategy: extract track identity/data from EACH visible MusicPlaylistTracks_MusicTrackRow.
 * This ensures we only get tracks from the CURRENT playlist (visible rows = current playlist).
 */
function extractPlaylistTracksFromFiber(): Array<{ownerId: string; audioId: string; artist: string; title: string; url?: string}> {
  const rows = document.querySelectorAll('[data-testid="MusicPlaylistTracks_MusicTrackRow"]');
  if (rows.length === 0) return [];

  const tracks: Array<{ownerId: string; audioId: string; artist: string; title: string; url?: string}> = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const fiberKey = Object.keys(row).find(
      (k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"),
    );
    if (!fiberKey) continue;

    const fiber = (row as any)[fiberKey];
    let current = fiber;

    for (let i = 0; i < 10; i++) {
      if (!current) break;
      const props = current.memoizedProps;
      if (props && props.track && props.track.entity) {
        try {
          const entity = props.track.entity;
          const identity = entity.identity;
          if (!identity || !identity.id || !identity.ownerId) break;

          const isBlocked = entity.isBlocked === true;
          const trackUrl = entity.url || entity.apiAudio?.url || "";
          const hasUrl = !!(trackUrl && trackUrl.length > 0);

          if (isBlocked && !hasUrl) break; // Skip blocked

          const apiAudio = entity.apiAudio;
          const authors = entity.authors;
          const artist = (apiAudio?.artist) || (authors?.raw) || "Unknown";
          const title = (apiAudio?.title) || entity.title || "audio";
          const key = `${identity.ownerId}_${identity.id}`;

          if (!seen.has(key)) {
            seen.add(key);
            tracks.push({
              ownerId: String(identity.ownerId),
              audioId: String(identity.id),
              artist,
              title,
              url: trackUrl || undefined,
            });
          }
        } catch {}
        break;
      }
      current = current.return;
    }
  }

  return tracks;
}

// Listen for fiber-based meta extraction. The content script tags the
// row it cares about with `data-ymus-row-mark="<requestId>"` and dispatches
// this event. We find the marked element, walk its React fiber to find
// `memoizedProps.track.entity`, and report back. Used as a fallback when
// the row has no data-full-id / data-sortable-id (third-party playlists).
document.addEventListener("ymus-extract-meta-by-mark", (event) => {
  const { requestId } = (event as CustomEvent).detail;
  let meta: any = null;
  try {
    const el = document.querySelector(`[data-ymus-row-mark="${CSS.escape(requestId)}"]`);
    if (el) {
      const fiberKey = Object.keys(el).find(
        (k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"),
      );
      if (fiberKey) {
        let cur: any = (el as any)[fiberKey];
        for (let depth = 0; depth < 14 && cur; depth++) {
          const props = cur.memoizedProps;
          const track = props?.track;
          const entity = track?.entity ?? track;
          if (entity) {
            let identity: any = undefined;
            try { identity = entity.identity; } catch {}
            const ownerId = identity?.ownerId ?? entity.owner_id ?? entity.ownerId;
            const audioId = identity?.id ?? entity.id;
            if (ownerId !== undefined && audioId !== undefined) {
              let apiAudio: any = undefined;
              let authors: any = undefined;
              try { apiAudio = entity.apiAudio; } catch {}
              try { authors = entity.authors; } catch {}
              const artist = apiAudio?.artist || authors?.raw || entity.artist || "Unknown";
              let title = entity.title;
              try { title = apiAudio?.title || entity.title; } catch {}
              const url = entity.url || apiAudio?.url;
              const accessKey = entity.accessKey || entity.access_key || apiAudio?.access_key;
              meta = {
                ownerId: String(ownerId),
                audioId: String(audioId),
                artist: String(artist || "Unknown"),
                title: String(title || `audio_${audioId}`),
                encryptedUrl: url ? String(url) : undefined,
                accessKey: accessKey ? String(accessKey) : undefined,
              };
              break;
            }
          }
          cur = cur.return;
        }
      }
    }
  } catch (e) {
    console.log("[YMus page-bridge] fiber extract failed:", e);
  }
  document.dispatchEvent(new CustomEvent("ymus-extract-meta-result", { detail: { requestId, meta } }));
});

// Listen for current track info requests (from player button)
document.addEventListener("ymus-get-current-track", (event) => {
  const { requestId } = (event as CustomEvent).detail;
  let meta: { ownerId: string; audioId: string; artist: string; title: string } | null = null;

  try {
    const player = (window as any).getAudioPlayer?.();
    if (player) {
      const current = player.getCurrentAudio?.();
      if (Array.isArray(current) && current.length > 4) {
        meta = {
          audioId: String(current[0]),
          ownerId: String(current[1]),
          title: current[3] || "audio",
          artist: current[4] || "Unknown",
        };
      }
    }
  } catch {}

  document.dispatchEvent(new CustomEvent("ymus-current-track-result", { detail: { requestId, meta } }));
});

// Listen for download requests from content script
// Downloads audio via XHR from page context (same-origin, no CORS issues)
// then triggers download via <a download="filename"> (filename is respected in page context)
document.addEventListener("ymus-download-audio", async (event) => {
  const { url, filename, requestId } = (event as CustomEvent).detail;
  
  try {
    let audioBlob: Blob;
    
    if (url.includes(".m3u8")) {
      // HLS stream — download segments and concatenate
      audioBlob = await downloadHls(url);
    } else {
      // Direct mp3 URL — simple fetch
      const response = await fetch(url);
      if (!response.ok) {
        document.dispatchEvent(new CustomEvent("ymus-download-result", {
          detail: { requestId, success: false, error: `HTTP ${response.status}` }
        }));
        return;
      }
      audioBlob = await response.blob();
    }
    
    const blobUrl = URL.createObjectURL(audioBlob);
    
    // Use File constructor to set filename (works better than just <a download>)
    const file = new File([audioBlob], filename, { type: "audio/mpeg" });
    const fileUrl = URL.createObjectURL(file);
    
    const a = document.createElement("a");
    a.href = fileUrl;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    
    // Cleanup
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(fileUrl);
      URL.revokeObjectURL(blobUrl);
    }, 1000);
    
    document.dispatchEvent(new CustomEvent("ymus-download-result", {
      detail: { requestId, success: true }
    }));
  } catch (err: any) {
    document.dispatchEvent(new CustomEvent("ymus-download-result", {
      detail: { requestId, success: false, error: err?.message || "Download failed" }
    }));
  }
});

/**
 * Download HLS stream — fetch m3u8, parse segments, download and concatenate.
 * Handles AES-128 decryption for encrypted segments.
 */
async function downloadHls(m3u8Url: string): Promise<Blob> {
  const resp = await fetch(m3u8Url);
  if (!resp.ok) throw new Error(`Manifest fetch failed: ${resp.status}`);
  const manifest = await resp.text();
  const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);

  // Parse segments
  const lines = manifest.split("\n");
  const segments: { url: string; encrypted: boolean; keyUrl: string | null }[] = [];
  let currentEncrypted = false;
  let currentKeyUrl: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXT-X-KEY:")) {
      const methodMatch = trimmed.match(/METHOD=([^,]+)/);
      const method = methodMatch?.[1] || "NONE";
      if (method === "NONE") {
        currentEncrypted = false;
        currentKeyUrl = null;
      } else if (method === "AES-128") {
        currentEncrypted = true;
        const uriMatch = trimmed.match(/URI="([^"]+)"/);
        currentKeyUrl = uriMatch ? (uriMatch[1].startsWith("http") ? uriMatch[1] : baseUrl + uriMatch[1]) : null;
      }
      continue;
    }
    if (!trimmed || trimmed.startsWith("#")) continue;
    const url = trimmed.startsWith("http") ? trimmed : baseUrl + trimmed;
    segments.push({ url, encrypted: currentEncrypted, keyUrl: currentKeyUrl });
  }

  if (segments.length === 0) throw new Error("No segments found");

  // Fetch encryption key if needed, and import it ONCE
  const keyUrl = segments.find(s => s.encrypted)?.keyUrl;
  let cryptoKey: CryptoKey | null = null;
  if (keyUrl) {
    const keyResp = await fetch(keyUrl);
    if (!keyResp.ok) throw new Error(`Key fetch failed`);
    const keyBuf = await keyResp.arrayBuffer();
    cryptoKey = await crypto.subtle.importKey("raw", keyBuf, { name: "AES-CBC" }, false, ["decrypt"]);
  }

  // Pre-compute encrypted-segment IV indices so each pipeline task is
  // independent of the others. The IV depends on the position among
  // ENCRYPTED segments only, not the overall segment index.
  const encryptedIvIndex = new Array<number>(segments.length);
  let encCounter = 0;
  for (let i = 0; i < segments.length; i++) {
    encryptedIvIndex[i] = segments[i].encrypted ? encCounter++ : -1;
  }

  // Pipelined fetch → decrypt with bounded concurrency. Each segment runs
  // its decrypt as soon as its bytes are in, instead of waiting for all
  // segments to download first.
  const CONCURRENCY = 12;
  const processed: ArrayBuffer[] = new Array(segments.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= segments.length) return;

      const segResp = await fetch(segments[i].url);
      if (!segResp.ok) throw new Error(`Segment ${i} failed`);
      let segData: ArrayBuffer = await segResp.arrayBuffer();

      if (segments[i].encrypted && cryptoKey) {
        const iv = new ArrayBuffer(16);
        new DataView(iv).setUint32(12, encryptedIvIndex[i], false);
        try {
          segData = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, segData);
        } catch {
          // Use raw if decrypt fails
        }
      }
      processed[i] = segData;
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(CONCURRENCY, segments.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const chunks = processed;

  // Concatenate into single blob
  return new Blob(chunks, { type: "audio/mpeg" });
}
