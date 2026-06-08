/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}
 */

/**
 * Click → bridge → background full-flow integration test.
 *
 * Spec: youtube-buffer-capture-revert — task 5.1
 *
 * **Validates: Requirements 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.12**
 *
 * Drives `src/yt-content/yt-content.ts` end-to-end against a jsdom
 * watch page with mocked dependencies:
 *
 *   - `yt-spa-observer.startSpaObserver` — captured so the test can
 *      synthesize a navigation event and trigger button injection.
 *   - `yt-button-injector.injectDownloadButton` — replaced with a
 *      stub that records the `onClick` handler and exposes `setState`
 *      / `setLabel` / `setTooltip` / `setProgress` history.
 *   - `yt-playlist-injector` — no-op stubs (playlist surface is out
 *      of scope for the single-video click flow).
 *   - `yt-buffer-capture.forceFullBuffer` — returns whatever the
 *      test queues (`{ ok: true }`, `{ ok: false, reason: "timeout" }`, …).
 *   - `chrome.runtime.sendMessage` — replies `{ blocked: false }` to
 *      `YT_CHECK_GUARD` and the test-supplied response to
 *      `YT_DOWNLOAD_VIDEO`.
 *   - `window.postMessage` — the test acts as the MAIN-world bridge
 *      and replies with `SET_QUALITY_RESPONSE` /
 *      `MEDIA_BUFFER_RESPONSE` when the content script posts requests.
 *
 * Each scenario starts from a freshly required module so module-level
 * state (`currentButton`, `currentVideoId`, `autoResumeFiredFor`) is
 * reset between tests.
 */

// ─── Module-level mocks (must be declared with jest.mock BEFORE require) ────

// `currentSpaObserverCallback` is hoisted so the mocked module can
// stash the navigation callback for the test to fire.
let __currentSpaObserverCallback: ((videoId: string | null) => void) | null =
  null;

interface MockButtonHandle {
  setProgress: jest.Mock<void, [number]>;
  setState: jest.Mock<void, [string]>;
  setTooltip: jest.Mock<void, [string]>;
  setLabel: jest.Mock<void, [string]>;
  remove: jest.Mock<void, []>;
  /** State transition history in order of calls. */
  states: string[];
  /** Last tooltip text (for surfacing reason / error code). */
  lastTooltip: string | null;
  /** Stored onClick handler captured at injection time. */
  click: () => void;
  /** videoId passed at injection time. */
  videoId: string;
}

let __lastInjectedButton: MockButtonHandle | null = null;

interface MockBufferResult {
  ok: true;
}
interface MockBufferFail {
  ok: false;
  reason: "playerSwapped" | "timeout" | "noBufferGrowth";
}
type MockBufferResponse = MockBufferResult | MockBufferFail;

let __forceFullBufferResult: MockBufferResponse = { ok: true };

jest.mock("../src/yt-content/yt-spa-observer", () => ({
  startSpaObserver: jest.fn(
    (onNavigate: (videoId: string | null) => void): void => {
      __currentSpaObserverCallback = onNavigate;
    },
  ),
}));

jest.mock("../src/yt-content/yt-button-injector", () => ({
  injectDownloadButton: jest.fn(
    (
      videoId: string,
      _videoType: "regular" | "shorts",
      onClick: () => void,
    ): MockButtonHandle => {
      const states: string[] = ["idle"];
      const handle: MockButtonHandle = {
        videoId,
        click: onClick,
        states,
        lastTooltip: null,
        setProgress: jest.fn<void, [number]>(),
        setState: jest.fn<void, [string]>((s) => {
          states.push(s);
        }),
        setTooltip: jest.fn<void, [string]>((t) => {
          handle.lastTooltip = t;
        }),
        setLabel: jest.fn<void, [string]>(),
        remove: jest.fn<void, []>(),
      };
      __lastInjectedButton = handle;
      return handle;
    },
  ),
}));

jest.mock("../src/yt-content/yt-playlist-injector", () => ({
  collectPlaylistVideoIds: jest.fn((): string[] => []),
  getCurrentPlaylistId: jest.fn((): string | null => null),
  injectPlaylistDownloadButton: jest.fn(() => null),
}));

jest.mock("../src/yt-content/yt-buffer-capture", () => ({
  forceFullBuffer: jest.fn(
    async (
      _video: HTMLVideoElement,
      _duration: number,
      onProgress: (pct: number) => void,
    ): Promise<MockBufferResponse> => {
      // Emit a single progress tick on the success path so the
      // button.setProgress wiring is exercised.
      try {
        onProgress(50);
      } catch {
        /* ignore */
      }
      return __forceFullBufferResult;
    },
  ),
}));

// ─── Test helpers ────────────────────────────────────────────────────────────

/**
 * Set the jsdom URL via history.replaceState so `location.search` reflects
 * `?v=<id>`. yt-content.ts reads the current URL inside isFreshLoadForVideo.
 */
function setHref(href: string): void {
  history.replaceState(history.state, "", href);
}

/** Build a YouTube `?v=<id>` URL on the canonical watch path. */
function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Sleep one macrotask so async chain inside yt-content can advance. */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Drain all pending microtasks + a few macrotasks. */
async function flushAsync(steps = 5): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await nextMacrotask();
  }
}

/**
 * Drain the click flow with real-timer awareness. The flow has a
 * `sleep(1500)` after a successful quality switch and 2 s / 10 s bridge
 * timeouts, so a pure microtask drain is not enough.
 *
 * Strategy: yield to the event loop repeatedly with a small real-time
 * delay between yields. Total wait ≤ `maxMs` (default 2500 ms — fits
 * within the default Jest 5 s timeout while covering the 1500 ms sleep
 * plus a few hundred ms of slack for chrome.runtime.sendMessage and
 * forceFullBuffer to settle). Each yield is a `setTimeout(_, stepMs)`
 * so jsdom's timer queue flushes pending tasks (the bridge response
 * listener, the 1500 ms quality settle, and the chrome.runtime.sendMessage
 * callback).
 */
async function drainClickFlow(maxMs = 2500, stepMs = 25): Promise<void> {
  const steps = Math.ceil(maxMs / stepMs);
  for (let i = 0; i < steps; i++) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

interface PlayerStubOpts {
  isLive?: boolean;
  isLiveContent?: boolean;
  isDrmProtected?: boolean;
  title?: string;
}

/**
 * Install a `<video>` + `#movie_player` element pair into the document.
 * Returns the video element so tests can inspect / mutate it.
 */
function installPlayerDom(
  duration: number,
  playerOpts: PlayerStubOpts = {},
): HTMLVideoElement {
  const player = document.createElement("div");
  player.id = "movie_player";
  // Attach a `getVideoData` shim so the live/DRM pre-flight reads it.
  (
    player as HTMLDivElement & {
      getVideoData?: () => PlayerStubOpts;
    }
  ).getVideoData = () => playerOpts;

  const video = document.createElement("video");
  // jsdom's <video> reports duration NaN by default — define our own.
  Object.defineProperty(video, "duration", {
    configurable: true,
    get: () => duration,
  });
  Object.defineProperty(video, "paused", {
    configurable: true,
    value: true,
    writable: true,
  });
  player.appendChild(video);
  document.body.appendChild(player);

  // Inject an action-bar container so injectDownloadButton (the real
  // implementation, not the mock) would normally find it. Our mock
  // ignores the DOM but keeping a clean shape avoids surprises.
  const menu = document.createElement("div");
  menu.id = "flexible-item-buttons";
  document.body.appendChild(menu);

  return video;
}

/**
 * Stub the navigation timing entry so `isFreshLoadForVideo` can read
 * a non-empty array and the page-age check uses our `performance.now`.
 *
 * `pageAgeMs` is what `performance.now()` should return — set
 * `pageAgeMs` to ~3000 for "fresh load", or ~120000 for "stale".
 */
function setPageAge(pageAgeMs: number): void {
  // jsdom provides `performance.getEntriesByType` but may return [] for
  // "navigation" until a real navigation occurs. We override both.
  const fakeEntry = {
    type: "navigation",
    startTime: 0,
  } as unknown as PerformanceEntry;
  (
    performance as unknown as {
      getEntriesByType: (type: string) => PerformanceEntry[];
    }
  ).getEntriesByType = (type: string): PerformanceEntry[] =>
    type === "navigation" ? [fakeEntry] : [];

  (
    performance as unknown as { now: () => number }
  ).now = (): number => pageAgeMs;
}

/**
 * Bridge stub — listens for `ymus-yt-content` requests and replies with
 * the supplied responses keyed by request `action`. Each entry is consumed
 * (FIFO) on match. Multiple responses for the same action queue up.
 *
 * The stub posts the response back via `window.postMessage` synchronously
 * inside a microtask so the content script's awaiting `postBridge` resolves
 * naturally.
 */
function installBridgeStub(
  responses: Partial<{
    SET_QUALITY: Array<Record<string, unknown>>;
    GET_MEDIA_BUFFER: Array<Record<string, unknown>>;
    GET_BUFFER_STATUS: Array<Record<string, unknown>>;
    RELOAD_VIDEO: Array<Record<string, unknown>>;
    CLEAR_BUFFER: Array<Record<string, unknown>>;
  }>,
): { uninstall: () => void; received: Array<Record<string, unknown>> } {
  const received: Array<Record<string, unknown>> = [];
  const queues: Record<string, Array<Record<string, unknown>>> = {
    SET_QUALITY: [...(responses.SET_QUALITY ?? [])],
    GET_MEDIA_BUFFER: [...(responses.GET_MEDIA_BUFFER ?? [])],
    GET_BUFFER_STATUS: [...(responses.GET_BUFFER_STATUS ?? [])],
    RELOAD_VIDEO: [...(responses.RELOAD_VIDEO ?? [])],
    CLEAR_BUFFER: [...(responses.CLEAR_BUFFER ?? [])],
  };
  const responseAction: Record<string, string> = {
    SET_QUALITY: "SET_QUALITY_RESPONSE",
    GET_MEDIA_BUFFER: "MEDIA_BUFFER_RESPONSE",
    GET_BUFFER_STATUS: "BUFFER_STATUS_RESPONSE",
    RELOAD_VIDEO: "RELOAD_VIDEO_RESPONSE",
    CLEAR_BUFFER: "CLEAR_BUFFER_RESPONSE",
  };

  const handler = (event: MessageEvent): void => {
    // NOTE: do NOT filter on event.source here. In jsdom the source
    // property of a same-window postMessage can be a wrapper that is
    // not strict-equal to the global `window` reference, which would
    // silently drop every request. The `data.source` discriminator is
    // sufficient — it identifies the YMus content-script protocol.
    const data = event.data as { source?: unknown; action?: unknown } | null;
    if (!data || data.source !== "ymus-yt-content") return;
    const action = data.action as string;
    received.push(data as Record<string, unknown>);
    const queue = queues[action];
    if (!queue || queue.length === 0) return;
    const next = queue.shift()!;
    // Reply on a microtask so the awaiting postBridge listener has been
    // installed before our response arrives.
    //
    // We use `dispatchEvent(new MessageEvent("message", { source: window }))`
    // instead of `window.postMessage(...)` because jsdom sets `event.source`
    // to `null` for same-window postMessage calls. The content script's
    // `postBridge` filters on `event.source !== window`, so a real-Chrome
    // semantics replay needs us to construct the MessageEvent explicitly.
    queueMicrotask(() => {
      const responseData = {
        source: "ymus-yt-bridge",
        action: responseAction[action],
        ...next,
      };
      const evt = new MessageEvent("message", {
        data: responseData,
        source: window as unknown as MessageEventSource,
      });
      window.dispatchEvent(evt);
    });
  };
  window.addEventListener("message", handler);
  return {
    uninstall: () => window.removeEventListener("message", handler),
    received,
  };
}

interface RuntimeMessageRecord {
  message: unknown;
  responded: boolean;
}

/**
 * Replace `chrome.runtime.sendMessage` with a programmable stub.
 *
 *   - `YT_CHECK_GUARD` → resolves `{ blocked: false }` unless the test
 *      overrides it via `guardBlocked: true`.
 *   - `YT_DOWNLOAD_VIDEO` → resolves with `downloadResponse` and records
 *      the message body so the test can inspect the payload.
 */
function installSendMessageStub(opts: {
  guardBlocked?: boolean;
  downloadResponse?: { success: boolean; downloadId?: number; errorCode?: string; reason?: string };
  /**
   * If true, simulate the v3 promise-based form: `sendMessage(msg)` returns a
   * Promise. Otherwise use the callback form: `sendMessage(msg, cb)`.
   */
  promiseForm?: boolean;
}): {
  records: RuntimeMessageRecord[];
  restore: () => void;
} {
  const records: RuntimeMessageRecord[] = [];
  const original = chrome.runtime.sendMessage;
  const guardResp = { blocked: opts.guardBlocked === true };
  const downloadResp = opts.downloadResponse ?? {
    success: true,
    downloadId: 42,
  };

  // Provide a callback-based replacement (matches the wire used inside
  // yt-content.ts: both `chrome.runtime.sendMessage(msg, cb)` for the
  // download and `chrome.runtime.sendMessage({...}, cb)` for the guard).
  const stub = jest.fn(
    (
      message: unknown,
      maybeCb?: (resp: unknown) => void,
    ): unknown => {
      const record: RuntimeMessageRecord = { message, responded: false };
      records.push(record);
      const msg = message as { type?: string } | null;

      let resp: unknown;
      if (msg?.type === "YT_CHECK_GUARD") resp = guardResp;
      else if (msg?.type === "YT_DOWNLOAD_VIDEO") resp = downloadResp;
      else resp = undefined;

      const dispatch = (): void => {
        record.responded = true;
        if (typeof maybeCb === "function") {
          // Mimic the chrome event loop — invoke on a microtask so the
          // awaiting Promise can settle in deterministic order.
          queueMicrotask(() => {
            try {
              maybeCb(resp);
            } catch {
              /* swallow */
            }
          });
        }
      };

      if (opts.promiseForm === true && typeof maybeCb !== "function") {
        return Promise.resolve().then(() => {
          record.responded = true;
          return resp;
        });
      }

      dispatch();
      return undefined;
    },
  );

  (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = stub;
  return {
    records,
    restore: () => {
      (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage =
        original;
    },
  };
}

/**
 * Mount yt-content.ts (its IIFE bootstrap runs as a side effect of require)
 * and drive the SPA navigation callback so the button gets injected.
 *
 * Returns the captured button handle.
 */
async function mountYtContentAndNavigate(
  videoId: string,
): Promise<MockButtonHandle> {
  jest.isolateModules(() => {
    require("../src/yt-content/yt-content");
  });
  // The bootstrap awaits `checkDistributionGuard()` (which sendMessage'd
  // YT_CHECK_GUARD). Drain microtasks so it resolves and `startSpaObserver`
  // runs.
  await flushAsync();
  if (!__currentSpaObserverCallback) {
    throw new Error(
      "yt-content bootstrap did not register an SPA observer callback",
    );
  }
  __currentSpaObserverCallback(videoId);
  // Button injection is synchronous inside `tryInject`, which runs after
  // the navigation callback. Await one tick so `__lastInjectedButton` is
  // populated.
  await flushAsync();
  if (!__lastInjectedButton || __lastInjectedButton.videoId !== videoId) {
    throw new Error(
      `Expected injected button for videoId=${videoId}, got ${__lastInjectedButton?.videoId ?? "<none>"}`,
    );
  }
  return __lastInjectedButton;
}

// ─── Top-level beforeEach / afterEach ───────────────────────────────────────

// Each click-flow test waits real time for the 1500 ms quality settle
// plus a drainClickFlow loop. Bump the per-test timeout so the slowest
// happy-path test has enough headroom.
jest.setTimeout(10_000);

beforeEach(async () => {
  // Reset module + DOM state.
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  __currentSpaObserverCallback = null;
  __lastInjectedButton = null;
  __forceFullBufferResult = { ok: true };
  // Reset module cache so each test gets a fresh yt-content IIFE run.
  // Hoisted `jest.mock` factories above survive `resetModules` and are
  // re-applied on the next require, so we don't need to re-register them.
  jest.resetModules();

  // Reset chrome.storage between tests (jest-webextension-mock + the
  // setup file install per-area stores; calling clear() flushes each).
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("yt-content click flow — full integration", () => {
  it("[diagnostic] window.postMessage reaches a same-window listener", async () => {
    const received: string[] = [];
    const handler = (event: MessageEvent): void => {
      const data = event.data as { tag?: string } | null;
      if (data && typeof data.tag === "string") received.push(data.tag);
    };
    window.addEventListener("message", handler);
    window.postMessage({ tag: "diag-1" }, "*");
    await flushAsync(10);
    window.removeEventListener("message", handler);
    expect(received).toEqual(["diag-1"]);
  });

  it("[diagnostic] chrome.storage.local.get resolves a Promise after clear", async () => {
    await chrome.storage.local.clear();
    const r1 = (await chrome.storage.local.get("ytPreferredQuality")) as Record<
      string,
      unknown
    >;
    expect(r1).toEqual({});
    await chrome.storage.local.set({ ytPreferredQuality: "720p" });
    const r2 = (await chrome.storage.local.get("ytPreferredQuality")) as Record<
      string,
      unknown
    >;
    expect(r2.ytPreferredQuality).toBe("720p");
  });
  describe("happy path on a fresh /watch page", () => {
    it("clicks → SET_QUALITY → forceFullBuffer → GET_MEDIA_BUFFER → YT_DOWNLOAD_VIDEO → success", async () => {
      const videoId = "dQw4w9WgXcQ";
      setHref(watchUrl(videoId));
      setPageAge(3_000);
      installPlayerDom(125);
      const sendMessage = installSendMessageStub({
        guardBlocked: false,
        downloadResponse: { success: true, downloadId: 7 },
      });
      // Audio + video ArrayBuffers — the post-mux-fix flow ships both
      // tracks under the new `{audioData, videoData, audioSize,
      // videoSize, audioItag, videoItag}` envelope (per
      // youtube-download-mux-corruption-fix design.md task 3.3).
      const audioBuf = new ArrayBuffer(200 * 1024);
      const videoBuf = new ArrayBuffer(800 * 1024);
      const bridge = installBridgeStub({
        SET_QUALITY: [
          { success: true, appliedLabel: "hd1080" },
        ],
        // RELOAD_VIDEO must be answered or the click flow stalls on a
        // 2 s bridge timeout (eats most of the drainClickFlow budget).
        RELOAD_VIDEO: [{ success: true }],
        GET_MEDIA_BUFFER: [
          {
            videoId,
            audioData: audioBuf,
            videoData: videoBuf,
            audioSize: audioBuf.byteLength,
            videoSize: videoBuf.byteLength,
            audioItag: 140,
            videoItag: 137,
            audioHasInit: true,
            videoHasInit: true,
            responseCount: 12,
          },
        ],
      });

      const button = await mountYtContentAndNavigate(videoId);

      // Trigger the click.
      button.click();
      // Drain the click flow — many awaits chain through it including
      // the 1500 ms quality settle sleep after SET_QUALITY succeeds
      // and the 2000 ms post-RELOAD_VIDEO settle.
      await drainClickFlow(5_000);

      try {
        // Bridge must have received SET_QUALITY then GET_MEDIA_BUFFER (in order).
        const actions = bridge.received.map((m) => m.action);
        expect(actions).toContain("SET_QUALITY");
        expect(actions).toContain("GET_MEDIA_BUFFER");
        expect(actions.indexOf("SET_QUALITY")).toBeLessThan(
          actions.indexOf("GET_MEDIA_BUFFER"),
        );

        // YT_CHECK_GUARD + YT_DOWNLOAD_VIDEO were both sent.
        const types = sendMessage.records
          .map((r) => (r.message as { type?: string }).type)
          .filter(Boolean);
        expect(types).toContain("YT_CHECK_GUARD");
        expect(types).toContain("YT_DOWNLOAD_VIDEO");

        // Check the download payload shape — post-mux-fix the content
        // script ships base64-encoded audio AND video buffers along
        // with both iTags (per bugfix.md §3.6).
        const dlRecord = sendMessage.records.find(
          (r) => (r.message as { type?: string }).type === "YT_DOWNLOAD_VIDEO",
        )!;
        const payload = (dlRecord.message as {
          payload?: {
            videoId?: string;
            url?: string;
            title?: string;
            audioDataB64?: string;
            videoDataB64?: string;
            audioITag?: number;
            videoITag?: number;
            durationSec?: number;
          };
        }).payload!;
        expect(payload.videoId).toBe(videoId);
        expect(typeof payload.audioDataB64).toBe("string");
        expect((payload.audioDataB64 ?? "").length).toBeGreaterThan(0);
        expect(typeof payload.videoDataB64).toBe("string");
        expect((payload.videoDataB64 ?? "").length).toBeGreaterThan(0);
        expect(payload.audioITag).toBe(140);
        expect(payload.videoITag).toBe(137);
        expect(typeof payload.url).toBe("string");
        expect(payload.url).toContain(videoId);

        // Button transitions: idle (initial) → loading → success.
        expect(button.states[0]).toBe("idle");
        expect(button.states).toContain("loading");
        expect(button.states).toContain("success");
        // Loading must come before success.
        expect(button.states.indexOf("loading")).toBeLessThan(
          button.states.indexOf("success"),
        );

        // Progress was driven from forceFullBuffer (50 → 30 after the
        // 0..60% rescaling in runClickFlow) and then 100 on success.
        const progressCalls = button.setProgress.mock.calls.map((c) => c[0]);
        // forceFullBuffer mock emits 50; runClickFlow rescales to 0..60
        // → Math.round(50 * 0.6) = 30.
        expect(progressCalls).toContain(30);
        expect(progressCalls).toContain(100);
      } finally {
        bridge.uninstall();
        sendMessage.restore();
      }
    });

    it("YT_DOWNLOAD_VIDEO payload uses .m4a-bound iTag for AAC and propagates Opus iTags too", async () => {
      const videoId = "dQw4w9WgXcQ";
      setHref(watchUrl(videoId));
      setPageAge(3_000);
      installPlayerDom(60);
      const sendMessage = installSendMessageStub({
        downloadResponse: { success: true, downloadId: 11 },
      });
      const audioBuf = new ArrayBuffer(150 * 1024);
      const videoBuf = new ArrayBuffer(600 * 1024);
      const bridge = installBridgeStub({
        SET_QUALITY: [{ success: true, appliedLabel: "hd1080" }],
        RELOAD_VIDEO: [{ success: true }],
        GET_MEDIA_BUFFER: [
          {
            videoId,
            audioData: audioBuf,
            videoData: videoBuf,
            audioSize: audioBuf.byteLength,
            videoSize: videoBuf.byteLength,
            audioItag: 251, // Opus audio
            videoItag: 248, // VP9 video
            audioHasInit: true,
            videoHasInit: true,
            responseCount: 5,
          },
        ],
      });

      try {
        const button = await mountYtContentAndNavigate(videoId);
        button.click();
        await drainClickFlow(5_000);

        const dl = sendMessage.records.find(
          (r) => (r.message as { type?: string }).type === "YT_DOWNLOAD_VIDEO",
        );
        expect(dl).toBeDefined();
        const payload = (dl!.message as {
          payload: {
            audioITag: number;
            videoITag: number;
            audioDataB64: string;
            videoDataB64: string;
          };
        }).payload;
        // The content script must propagate the iTags verbatim — it does
        // not pick extensions itself; that decision belongs to the
        // background bytes-passthrough handler.
        expect(payload.audioITag).toBe(251);
        expect(payload.videoITag).toBe(248);
        expect(typeof payload.audioDataB64).toBe("string");
        expect(payload.audioDataB64.length).toBeGreaterThan(0);
        expect(typeof payload.videoDataB64).toBe("string");
        expect(payload.videoDataB64.length).toBeGreaterThan(0);
        // Silence unused-var for `button`.
        void button;
      } finally {
        bridge.uninstall();
        sendMessage.restore();
      }
    });
  });

  describe("DRM-protected video — disabled state, no download", () => {
    it("surfaces DRM_PROTECTED without invoking forceFullBuffer or sendMessage(YT_DOWNLOAD_VIDEO)", async () => {
      const videoId = "drmProtect1";
      setHref(watchUrl(videoId));
      setPageAge(3_000);
      installPlayerDom(120, { isDrmProtected: true });
      const sendMessage = installSendMessageStub({});
      const bridge = installBridgeStub({});

      try {
        const button = await mountYtContentAndNavigate(videoId);
        button.click();
        await flushAsync(20);

        // No YT_DOWNLOAD_VIDEO message was sent.
        const dl = sendMessage.records.find(
          (r) => (r.message as { type?: string }).type === "YT_DOWNLOAD_VIDEO",
        );
        expect(dl).toBeUndefined();

        // Bridge never saw GET_MEDIA_BUFFER or SET_QUALITY (we bail before).
        const actions = bridge.received.map((m) => m.action);
        expect(actions).not.toContain("GET_MEDIA_BUFFER");
        expect(actions).not.toContain("SET_QUALITY");

        // Button transitioned to loading then to disabled (non-retryable).
        expect(button.states).toContain("loading");
        expect(button.states).toContain("disabled");

        // Tooltip surfaces a DRM message.
        expect(button.lastTooltip).toMatch(/DRM/i);

        // forceFullBuffer was not called.
        const ffb = jest.requireMock(
          "../src/yt-content/yt-buffer-capture",
        ) as { forceFullBuffer: jest.Mock };
        expect(ffb.forceFullBuffer).not.toHaveBeenCalled();
      } finally {
        bridge.uninstall();
        sendMessage.restore();
      }
    });
  });

  describe("Live stream — disabled state, no download", () => {
    it("surfaces LIVE_STREAM when getVideoData().isLive is true", async () => {
      const videoId = "liveStream1";
      setHref(watchUrl(videoId));
      setPageAge(3_000);
      installPlayerDom(120, { isLive: true });
      const sendMessage = installSendMessageStub({});
      const bridge = installBridgeStub({});

      try {
        const button = await mountYtContentAndNavigate(videoId);
        button.click();
        await flushAsync(20);

        const dl = sendMessage.records.find(
          (r) => (r.message as { type?: string }).type === "YT_DOWNLOAD_VIDEO",
        );
        expect(dl).toBeUndefined();
        expect(bridge.received.map((m) => m.action)).not.toContain(
          "GET_MEDIA_BUFFER",
        );
        expect(button.states).toContain("disabled");
        expect(button.lastTooltip).toMatch(/(трансля|live)/i);
      } finally {
        bridge.uninstall();
        sendMessage.restore();
      }
    });

    it("surfaces LIVE_STREAM when video.duration === Infinity", async () => {
      const videoId = "liveStream2";
      setHref(watchUrl(videoId));
      setPageAge(3_000);
      installPlayerDom(Infinity);
      const sendMessage = installSendMessageStub({});
      const bridge = installBridgeStub({});

      try {
        const button = await mountYtContentAndNavigate(videoId);
        button.click();
        await flushAsync(20);

        expect(
          sendMessage.records.find(
            (r) =>
              (r.message as { type?: string }).type === "YT_DOWNLOAD_VIDEO",
          ),
        ).toBeUndefined();
        expect(button.states).toContain("disabled");
      } finally {
        bridge.uninstall();
        sendMessage.restore();
      }
    });
  });

  describe("BUFFER_CAPTURE_FAILED when forceFullBuffer returns ok:false", () => {
    it("surfaces BUFFER_CAPTURE_FAILED without sending YT_DOWNLOAD_VIDEO", async () => {
      const videoId = "bufFail1xxx";
      setHref(watchUrl(videoId));
      setPageAge(3_000);
      installPlayerDom(120);
      __forceFullBufferResult = { ok: false, reason: "timeout" };
      const sendMessage = installSendMessageStub({});
      const bridge = installBridgeStub({
        SET_QUALITY: [{ success: true, appliedLabel: "hd1080" }],
        // RELOAD_VIDEO must be answered or the click flow stalls on the
        // 2 s bridge timeout, eating the drainClickFlow budget before
        // forceFullBuffer is reached.
        RELOAD_VIDEO: [{ success: true }],
      });

      try {
        const button = await mountYtContentAndNavigate(videoId);
        button.click();
        await drainClickFlow(5_000);

        const dl = sendMessage.records.find(
          (r) => (r.message as { type?: string }).type === "YT_DOWNLOAD_VIDEO",
        );
        expect(dl).toBeUndefined();
        // BUFFER_CAPTURE_FAILED is retryable → "error" state, not "disabled".
        expect(button.states).toContain("error");
        expect(button.lastTooltip).toMatch(/(буфер|buffer)/i);

        // SET_QUALITY ran (we got past the live/DRM gate); GET_MEDIA_BUFFER
        // did NOT (forceFullBuffer failed before the bridge round-trip).
        const actions = bridge.received.map((m) => m.action);
        expect(actions).toContain("SET_QUALITY");
        expect(actions).not.toContain("GET_MEDIA_BUFFER");
      } finally {
        bridge.uninstall();
        sendMessage.restore();
      }
    });
  });

  describe("Empty media buffer (size === 0)", () => {
    it("surfaces BUFFER_CAPTURE_FAILED when bridge returns audioSize=0/videoSize=0 (coverage-mismatch sentinel)", async () => {
      // Per youtube-download-mux-corruption-fix design.md task 3.3, the
      // page bridge emits `{audioSize: 0, videoSize: 0}` as the
      // coverage-mismatch sentinel (root cause #4). The content script
      // surfaces that as BUFFER_CAPTURE_FAILED (retryable error) instead
      // of shipping a mismatched audio/video pair to the muxer that
      // would silently truncate to the shorter track.
      const videoId = "noQuality12";
      setHref(watchUrl(videoId));
      setPageAge(3_000);
      installPlayerDom(60);
      const sendMessage = installSendMessageStub({});
      const bridge = installBridgeStub({
        SET_QUALITY: [{ success: true, appliedLabel: "hd1080" }],
        RELOAD_VIDEO: [{ success: true }],
        GET_MEDIA_BUFFER: [
          {
            videoId,
            audioData: null,
            videoData: null,
            audioSize: 0,
            videoSize: 0,
            audioItag: 0,
            videoItag: 0,
            audioHasInit: false,
            videoHasInit: false,
            responseCount: 0,
          },
        ],
      });

      try {
        const button = await mountYtContentAndNavigate(videoId);
        button.click();
        await drainClickFlow(5_000);

        // No YT_DOWNLOAD_VIDEO sent.
        expect(
          sendMessage.records.find(
            (r) =>
              (r.message as { type?: string }).type === "YT_DOWNLOAD_VIDEO",
          ),
        ).toBeUndefined();

        // BUFFER_CAPTURE_FAILED is retryable → "error" state.
        expect(button.states).toContain("error");
        expect(button.lastTooltip).toMatch(/(буфер|buffer)/i);
      } finally {
        bridge.uninstall();
        sendMessage.restore();
      }
    });
  });

  describe("Stale page (no fresh load) → markAutoDownload + reload", () => {
    it("writes ymus_yt_pending_download with 180s expiry and calls location.reload(); does NOT send YT_DOWNLOAD_VIDEO", async () => {
      const videoId = "staleClick1";
      setHref(watchUrl(videoId));
      // Page age outside [1.5s, 60s] (legacy "fresh load" window).
      setPageAge(120_000);
      installPlayerDom(120);

      // jsdom defines `window.location.reload` as a non-writable,
      // non-configurable own property (per spec). To intercept the call
      // we replace `window.location` with a thin wrapper Location object
      // whose `reload` is a jest mock; we use `Object.defineProperty`
      // on `window` itself, which IS configurable in jsdom.
      const reloadCalls: number[] = [];
      const realLocation = window.location;
      // Non-configurable non-writable own props (like `reload`) make a
      // Proxy target unusable. Build a plain stand-in instead — only
      // surfaces the `reload` mock and forwards `href` getter to the
      // real Location for diagnostic readability.
      const fakeLocation = {
        reload: (): void => {
          reloadCalls.push(Date.now());
        },
        get href(): string {
          return realLocation.href;
        },
        get search(): string {
          return realLocation.search;
        },
        get pathname(): string {
          return realLocation.pathname;
        },
        get hash(): string {
          return realLocation.hash;
        },
        get host(): string {
          return realLocation.host;
        },
        get hostname(): string {
          return realLocation.hostname;
        },
        get origin(): string {
          return realLocation.origin;
        },
        get protocol(): string {
          return realLocation.protocol;
        },
      } as unknown as Location;
      const locationOwnDescriptor = Object.getOwnPropertyDescriptor(
        window,
        "location",
      );
      Object.defineProperty(window, "location", {
        configurable: true,
        get: () => fakeLocation,
      });

      const sendMessage = installSendMessageStub({});
      const bridge = installBridgeStub({});

      try {
        const button = await mountYtContentAndNavigate(videoId);
        const before = Date.now();
        button.click();
        await flushAsync(20);

        // No YT_DOWNLOAD_VIDEO was sent.
        expect(
          sendMessage.records.find(
            (r) =>
              (r.message as { type?: string }).type === "YT_DOWNLOAD_VIDEO",
          ),
        ).toBeUndefined();
        expect(bridge.received).toEqual([]);

        // location.reload was called.
        expect(reloadCalls.length).toBe(1);

        // ymus_yt_pending_download was written with the legacy field shape.
        const stored = await chrome.storage.local.get(
          "ymus_yt_pending_download",
        );
        const pending = (
          stored as { ymus_yt_pending_download?: { videoId: string; expiresAt: number } }
        ).ymus_yt_pending_download;
        expect(pending).toBeDefined();
        expect(pending!.videoId).toBe(videoId);
        // Expiry is 180s past `before`. Allow a small wiggle for clock drift.
        expect(pending!.expiresAt).toBeGreaterThanOrEqual(before + 179_000);
        expect(pending!.expiresAt).toBeLessThanOrEqual(Date.now() + 180_500);
      } finally {
        try {
          if (locationOwnDescriptor) {
            Object.defineProperty(window, "location", locationOwnDescriptor);
          } else {
            // window.location is a built-in; restore by deleting our
            // override to expose the underlying real Location getter.
            delete (window as unknown as { location?: unknown }).location;
          }
        } catch {
          /* ignore — best effort */
        }
        bridge.uninstall();
        sendMessage.restore();
      }
    });
  });

  describe("Distribution-protection guard blocks all wiring", () => {
    it("does not register an SPA observer or inject a button when guard returns blocked:true", async () => {
      setHref(watchUrl("anyVideoId1"));
      setPageAge(3_000);
      installPlayerDom(60);
      const sendMessage = installSendMessageStub({ guardBlocked: true });

      try {
        // Mount yt-content but expect the bootstrap to bail out.
        jest.isolateModules(() => {
          require("../src/yt-content/yt-content");
        });
        await flushAsync(10);

        // SPA observer was never registered (callback stayed null).
        expect(__currentSpaObserverCallback).toBeNull();
        // No button was injected.
        expect(__lastInjectedButton).toBeNull();
        // YT_CHECK_GUARD WAS sent (that's how the guard runs).
        const types = sendMessage.records
          .map((r) => (r.message as { type?: string }).type)
          .filter(Boolean);
        expect(types).toContain("YT_CHECK_GUARD");
        // YT_DOWNLOAD_VIDEO was NOT sent (no button = no click flow).
        expect(types).not.toContain("YT_DOWNLOAD_VIDEO");
      } finally {
        sendMessage.restore();
      }
    });
  });

  describe("Auto-resume bootstrap re-issues a click after reload", () => {
    it("reads + clears the pending key on navigation, simulates a click, and runs the full flow", async () => {
      const videoId = "resumeMe123";
      setHref(watchUrl(videoId));
      setPageAge(3_000);
      installPlayerDom(120);
      // Pre-populate the pending key with a fresh expiry.
      await chrome.storage.local.set({
        ymus_yt_pending_download: {
          videoId,
          expiresAt: Date.now() + 60_000,
        },
      });

      const sendMessage = installSendMessageStub({
        downloadResponse: { success: true, downloadId: 99 },
      });
      const audioBuf = new ArrayBuffer(200 * 1024);
      const videoBuf = new ArrayBuffer(800 * 1024);
      const bridge = installBridgeStub({
        SET_QUALITY: [{ success: true, appliedLabel: "hd1080" }],
        RELOAD_VIDEO: [{ success: true }],
        GET_MEDIA_BUFFER: [
          {
            videoId,
            audioData: audioBuf,
            videoData: videoBuf,
            audioSize: audioBuf.byteLength,
            videoSize: videoBuf.byteLength,
            audioItag: 140,
            videoItag: 137,
            audioHasInit: true,
            videoHasInit: true,
            responseCount: 7,
          },
        ],
      });

      try {
        const button = await mountYtContentAndNavigate(videoId);
        // The content script's auto-resume bootstrap fires after the
        // button is injected. Drain async to let the click propagate
        // through the SET_QUALITY/forceFullBuffer/GET_MEDIA_BUFFER chain
        // (including the 1500 ms quality-settle sleep and the 2000 ms
        // post-RELOAD_VIDEO settle).
        await drainClickFlow(5_000);

        // The pending key is consumed.
        const after = await chrome.storage.local.get(
          "ymus_yt_pending_download",
        );
        expect(
          (after as { ymus_yt_pending_download?: unknown })
            .ymus_yt_pending_download,
        ).toBeUndefined();

        // YT_DOWNLOAD_VIDEO was sent with the resumed videoId.
        const dl = sendMessage.records.find(
          (r) =>
            (r.message as { type?: string }).type === "YT_DOWNLOAD_VIDEO",
        );
        expect(dl).toBeDefined();
        const payload = (dl!.message as {
          payload: { videoId: string };
        }).payload;
        expect(payload.videoId).toBe(videoId);

        // Button reached success.
        expect(button.states).toContain("success");
      } finally {
        bridge.uninstall();
        sendMessage.restore();
      }
    });

    it("does NOT re-issue the click when the pending key has expired", async () => {
      const videoId = "expiredKey1";
      setHref(watchUrl(videoId));
      setPageAge(3_000);
      installPlayerDom(120);
      // Pre-populate with an expired key.
      await chrome.storage.local.set({
        ymus_yt_pending_download: {
          videoId,
          expiresAt: Date.now() - 1_000,
        },
      });

      const sendMessage = installSendMessageStub({});
      const bridge = installBridgeStub({});

      try {
        const button = await mountYtContentAndNavigate(videoId);
        await flushAsync(15);

        // Pending key was cleared on read (legacy contract: at-most-once).
        const after = await chrome.storage.local.get(
          "ymus_yt_pending_download",
        );
        expect(
          (after as { ymus_yt_pending_download?: unknown })
            .ymus_yt_pending_download,
        ).toBeUndefined();

        // No click was simulated → no YT_DOWNLOAD_VIDEO and no bridge round-trip.
        expect(
          sendMessage.records.find(
            (r) =>
              (r.message as { type?: string }).type === "YT_DOWNLOAD_VIDEO",
          ),
        ).toBeUndefined();
        expect(bridge.received).toEqual([]);

        // Button should remain idle (no click was triggered).
        expect(button.states[button.states.length - 1]).toBe("idle");
      } finally {
        bridge.uninstall();
        sendMessage.restore();
      }
    });
  });
});
