// Service Worker entry point.

import { URLCache } from "./url-cache";
import { createMessageRouter } from "./message-router";
import { logError } from "./logger";
import { startSpotifyTokenCapture } from "./spotify-token-capture";

const cache = new URLCache();
const TELEMETRY_URL = "https://ymus.tech/api/telemetry/extension";
const TELEMETRY_STORAGE_KEY = "ymusTelemetryLastPing";
const TELEMETRY_CLIENT_KEY = "ymusTelemetryClientId";

async function sendTelemetryPing(): Promise<void> {
  try {
    const now = Date.now();
    const stored = await chrome.storage.local.get(TELEMETRY_STORAGE_KEY);
    const clientStored = await chrome.storage.local.get(TELEMETRY_CLIENT_KEY);
    const last = typeof stored[TELEMETRY_STORAGE_KEY] === "number" ? stored[TELEMETRY_STORAGE_KEY] : 0;
    if (now - last < 24 * 60 * 60 * 1000) return;
    let clientId = typeof clientStored[TELEMETRY_CLIENT_KEY] === "string" ? clientStored[TELEMETRY_CLIENT_KEY] : "";
    if (!clientId) {
      clientId = crypto.randomUUID();
      await chrome.storage.local.set({ [TELEMETRY_CLIENT_KEY]: clientId });
    }

    await fetch(TELEMETRY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: chrome.runtime.getManifest().version, clientId }),
    });
    await chrome.storage.local.set({ [TELEMETRY_STORAGE_KEY]: now });
  } catch {
    // Telemetry must never affect extension behavior.
  }
}

void sendTelemetryPing();

// ─── Anti-distribution protection ───────────────────────────────────────────
// Extension works ONLY when loaded as unpacked ("development" installType).
// If someone packages it and publishes to Chrome Web Store — it self-disables.
let distributionBlocked = false;

try {
  chrome.management.getSelf((info) => {
    if (info.installType !== "development") {
      distributionBlocked = true;
      console.warn("[ymd] Distribution protection triggered: installType =", info.installType);
    }
  });
} catch {
  // management API unavailable — allow (shouldn't happen with permission)
}

// ─── Distribution-protection guard helper ──────────────────────────────────
// Exposed so webRequest hooks below can short-circuit without re-reading
// `distributionBlocked` directly.
function isDistributionBlocked(): boolean {
  return distributionBlocked;
}

// ─── Spotify access-token capture ──────────────────────────────────────────
// Регистрируем listener `chrome.webRequest.onBeforeSendHeaders` ОДИН РАЗ при
// старте SW (R4.1) — до первого SPOTIFY_DOWNLOAD_TRACK-сообщения, чтобы к
// моменту первого скачивания токен уже мог быть перехвачен (а на cold-start
// у `getSpotifyAccessToken` есть собственный 2 000 мс дедлайн ожидания).
// Регистрация идемпотентна: повторный вызов не приведёт к двойной подписке.
try {
  startSpotifyTokenCapture();
} catch (error) {
  logError("background:spotifyTokenCapture", error);
}

try {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // YT_CHECK_GUARD must NEVER be blocked — content scripts use it to learn
    // whether they should disable the YouTube UI before the user can click anything.
    if (message && (message as { type?: unknown }).type === "YT_CHECK_GUARD") {
      sendResponse({ success: true, blocked: distributionBlocked });
      return true;
    }
    if (distributionBlocked) {
      sendResponse({ success: false, reason: "Distribution protection active" });
      return true;
    }
    return createMessageRouter(cache)(message, sender, sendResponse);
  });
} catch (error) {
  logError("background:onMessage", error);
}

// ─── YouTube webRequest capture (SABR) ─────────────────────────────────────
// We capture the player's POST bodies for `googlevideo.com/videoplayback`
// requests so the SW can replay them later (see `yt-sabr-downloader.ts`).
// The captured bodies + URL are exposed via `globalThis.__ytSabrUrls` and
// `globalThis.__ytSabrBodies` for the YT_DOWNLOAD_VIDEO handler — the
// legacy YMus build used the same global names, kept verbatim.

interface SabrGlobals {
  __ytSabrUrls?: Map<number, string[]>;
  __ytSabrBodies?: Map<number, ArrayBuffer[]>;
}

const ytSabrUrls = new Map<number, string[]>();
const ytSabrBodies = new Map<number, ArrayBuffer[]>();

try {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (!details.url.includes("googlevideo.com/videoplayback")) return;
      if (isDistributionBlocked()) return;
      // Stash the URL with the per-request `rn` and `alr` query params
      // stripped so we can append our own when replaying.
      const baseUrl = details.url
        .replace(/[&?]rn=\d+/, "")
        .replace(/[&?]alr=yes/, "");
      ytSabrUrls.set(details.tabId, [baseUrl]);

      if (
        details.requestBody &&
        details.requestBody.raw &&
        details.requestBody.raw.length > 0
      ) {
        const bodies = ytSabrBodies.get(details.tabId) ?? [];
        if (bodies.length < 50) {
          const rawBytes = details.requestBody.raw[0].bytes;
          if (rawBytes && rawBytes.byteLength > 0) {
            bodies.push(rawBytes);
            ytSabrBodies.set(details.tabId, bodies);
          }
        }
      }
    },
    { urls: ["*://*.googlevideo.com/videoplayback*"] },
    ["requestBody"],
  );
  chrome.tabs.onRemoved.addListener((tabId) => {
    ytSabrUrls.delete(tabId);
    ytSabrBodies.delete(tabId);
  });
} catch (error) {
  logError("background:webRequest", error);
}

(globalThis as unknown as SabrGlobals).__ytSabrUrls = ytSabrUrls;
(globalThis as unknown as SabrGlobals).__ytSabrBodies = ytSabrBodies;

// Welcome-страница при первой установке расширения.
// Открываем ссылку на Telegram-канал автора, чтобы пользователь мог следить
// за актуальными версиями. Срабатывает ТОЛЬКО при `reason === "install"`,
// чтобы не открывать вкладку при каждом обновлении/перезагрузке расширения.
const WELCOME_URL = "https://t.me/YMusLink";

try {
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason !== "install") return;
    try {
      void chrome.tabs.create({ url: WELCOME_URL });
    } catch (error) {
      logError("background:onInstalled:tabs.create", error);
    }
  });
} catch (error) {
  logError("background:onInstalled", error);
}

// ─── SW keepalive ───────────────────────────────────────────────────────────
// MV3 service workers go idle after ~30 seconds of inactivity. That makes
// chrome://extensions show "service worker (inactive)" — annoying when you
// want to inspect the SW console for debugging.
//
// chrome.alarms with a periodInMinutes <= 0.5 wakes the SW back up before
// the idle timer fires, keeping it permanently alive (or at least restarting
// it within ~30s of any termination). The handler does nothing — just
// receiving the alarm event is enough to reset the idle timer.
const KEEPALIVE_ALARM = "ymus-keepalive";

try {
  // Recreate the alarm on every SW startup. Chrome persists alarms across
  // restarts, but creating it again is idempotent and ensures the period
  // matches the latest code.
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM) {
      // Touch some chrome API to reset idle timer. No logging — would spam.
      try { void chrome.runtime.getPlatformInfo(); } catch { /* ignore */ }
    }
  });
} catch (error) {
  logError("background:keepalive", error);
}
