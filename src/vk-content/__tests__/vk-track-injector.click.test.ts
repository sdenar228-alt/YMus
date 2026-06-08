/**
 * @jest-environment jsdom
 */

/**
 * VK track injector — click handler PBT (Property 1 + Property 2)
 *
 * This file lives at `src/vk-content/__tests__/vk-track-injector.click.test.ts`
 * per the task spec. The Jest config has been extended to also match
 * `**\/src/**\/__tests__/**\/*.test.ts` so this file is picked up.
 *
 * --------------------------------------------------------------------
 *  Property 1 — Bug Condition / Expected Behavior (post-fix)
 * --------------------------------------------------------------------
 *  **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6**
 *
 *  These fixtures encode the POST-FIX expected behavior. They MUST FAIL
 *  on the unfixed code today — that failure is the deliverable for
 *  task 1 (it confirms the bug exists). Each silent-exit branch should
 *  produce zero `[YMus VK click]` log lines, zero toasts, zero class
 *  changes, and zero `chrome.runtime.sendMessage` calls on unfixed code.
 *
 * --------------------------------------------------------------------
 *  Property 2 — Preservation
 * --------------------------------------------------------------------
 *  **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**
 *
 *  These tests encode the existing happy-path contract observed on
 *  UNFIXED code. They MUST PASS on unfixed code (today) and must
 *  continue to PASS after the fix lands (no regressions).
 */

import * as fc from "fast-check";

// ─── Module loader (fresh module per test for isolated onClickRef state) ───

function loadInjector(): typeof import("../vk-track-injector") {
  jest.resetModules();
  return require("../vk-track-injector");
}

// We also need a way to reach `extractVkTrackMeta` so we can spy/throw on it.
// `vk-track-injector.ts` imports it from `./vk-track-meta`, so spying on the
// imported module via `require` after `jest.resetModules()` is the only way
// to intercept the call — we mutate the live binding before the click fires.
function loadInjectorWithMetaSpy(): {
  injector: typeof import("../vk-track-injector");
  metaModule: typeof import("../vk-track-meta");
} {
  jest.resetModules();
  const metaModule = require("../vk-track-meta");
  const injector = require("../vk-track-injector");
  return { injector, metaModule };
}

// ─── DOM fixtures ──────────────────────────────────────────────────────────

interface AudioRowOpts {
  ownerId: number;
  audioId: number;
  artist: string;
  title: string;
  encryptedUrl?: string;
  accessKey?: string;
}

/** Classic `.audio_row[data-full-id]` row matching VK_AUDIO_SELECTORS[0]. */
function createAudioRow(opts: AudioRowOpts): HTMLElement {
  const el = document.createElement("div");
  el.className = "audio_row";
  el.setAttribute("data-full-id", `${opts.ownerId}_${opts.audioId}`);

  // VK data-audio array shape: [audioId, ownerId, encryptedUrl, title, artist, ...]
  const arr: unknown[] = [
    opts.audioId,
    opts.ownerId,
    opts.encryptedUrl ?? "",
    opts.title,
    opts.artist,
  ];
  if (opts.accessKey !== undefined) {
    // index 24 is the accessKey slot
    while (arr.length < 25) arr.push(null);
    arr[24] = opts.accessKey;
  }
  el.setAttribute("data-audio", JSON.stringify(arr));

  // DOM fallback children (mirrors real VK markup)
  const performersEl = document.createElement("span");
  performersEl.className = "audio_row__performers";
  performersEl.textContent = opts.artist;
  el.appendChild(performersEl);

  const titleEl = document.createElement("span");
  titleEl.className = "audio_row__title_inner";
  titleEl.textContent = opts.title;
  el.appendChild(titleEl);

  return el;
}

/** Row that matches `.audio_row[data-full-id]` but whose data-full-id is unparseable. */
function createMetaNullRow(rawDataFullId: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "audio_row";
  el.setAttribute("data-full-id", rawDataFullId);
  return el;
}

/** Player overlay block + audioButtons container (where ymus-vk-player-dl-btn is injected). */
function createPlayerOverlay(): HTMLElement {
  const block = document.createElement("div");
  block.className = "AudioPlayerBlock__root";
  const buttons = document.createElement("div");
  buttons.className = "AudioPlayerBlock__audioButtons audioButtons";
  block.appendChild(buttons);
  document.body.appendChild(block);
  return block;
}

// ─── Spy/observer helpers ──────────────────────────────────────────────────

interface ConsoleSpyBundle {
  log: jest.SpyInstance;
  warn: jest.SpyInstance;
  error: jest.SpyInstance;
  /** All `[YMus VK click] …` lines emitted during the test (any level). */
  clickLogs: Array<{ level: "log" | "warn" | "error"; args: unknown[] }>;
}

function spyConsole(): ConsoleSpyBundle {
  const clickLogs: ConsoleSpyBundle["clickLogs"] = [];
  const captureFor = (level: "log" | "warn" | "error") =>
    (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === "string" && first.startsWith("[YMus VK click]")) {
        clickLogs.push({ level, args });
      }
    };
  const log = jest
    .spyOn(console, "log")
    .mockImplementation(captureFor("log"));
  const warn = jest
    .spyOn(console, "warn")
    .mockImplementation(captureFor("warn"));
  const error = jest
    .spyOn(console, "error")
    .mockImplementation(captureFor("error"));
  return { log, warn, error, clickLogs };
}

interface ToastObserver {
  toastsAdded: HTMLElement[];
  observer: MutationObserver;
  disconnect: () => void;
}

function observeToasts(): ToastObserver {
  const toastsAdded: HTMLElement[] = [];
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of Array.from(m.addedNodes)) {
        if (n instanceof HTMLElement && n.classList.contains("ymus-vk-toast")) {
          toastsAdded.push(n);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return { toastsAdded, observer, disconnect: () => observer.disconnect() };
}

function installChromeRuntimeMock(): jest.Mock {
  const sendMessage = jest.fn();
  // jest-webextension-mock pre-installs `chrome` globally, but we replace
  // sendMessage with a fresh jest.fn() per test for clean assertions.
  (globalThis as any).chrome = (globalThis as any).chrome ?? {};
  (globalThis as any).chrome.runtime = (globalThis as any).chrome.runtime ?? {};
  (globalThis as any).chrome.runtime.sendMessage = sendMessage;
  return sendMessage;
}

function clickButton(btn: HTMLButtonElement): void {
  btn.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true })
  );
}

// ─── fast-check generators ─────────────────────────────────────────────────

const ownerIdArb = fc.oneof(
  fc.integer({ min: -2_100_000_000, max: -1 }),
  fc.integer({ min: 1, max: 2_100_000_000 })
);
const audioIdArb = fc.integer({ min: 1, max: 999_999_999 });
const nonEmptyStrArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((s) => s.trim().length > 0 && !s.includes('"') && !s.includes("\\"));

// =================================================================
//  Property 1 — Bug Condition / Expected Behavior (POST-FIX)
//  These MUST FAIL on the unfixed code today.
// =================================================================

describe("Property 1 — Bug Condition: silent-exit branches must be observable", () => {
  let consoleSpies: ConsoleSpyBundle;
  let toastWatch: ToastObserver;
  let sendMessage: jest.Mock;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.removeAttribute("data-ymus-last-error");
    jest.useFakeTimers();
    consoleSpies = spyConsole();
    toastWatch = observeToasts();
    sendMessage = installChromeRuntimeMock();
  });

  afterEach(() => {
    toastWatch.disconnect();
    consoleSpies.log.mockRestore();
    consoleSpies.warn.mockRestore();
    consoleSpies.error.mockRestore();
    jest.useRealTimers();
  });

  /**
   * Fixture 1: meta-null
   *
   * Row matches `VK_AUDIO_SELECTORS[0]` (so a button is injected) but
   * `data-full-id` is unparseable (`"abc_xyz"`), so `extractVkTrackMeta`
   * returns null. Today: silent. Post-fix: one `[YMus VK click] meta-null`
   * warn line, no class change, no toast, no sendMessage.
   */
  it("meta-null: unparseable data-full-id emits exactly one [YMus VK click] meta-null warn line", () => {
    const row = createMetaNullRow("abc_xyz");
    document.body.appendChild(row);

    const { startVkTrackInjector } = loadInjector();
    startVkTrackInjector(jest.fn());

    const btn = row.querySelector(".ymus-vk-dl-btn") as HTMLButtonElement;
    expect(btn).not.toBeNull(); // button IS injected — only meta extraction fails

    clickButton(btn);

    const metaNullLogs = consoleSpies.clickLogs.filter(
      (e) => typeof e.args[0] === "string" && (e.args[0] as string).includes("meta-null")
    );
    expect(metaNullLogs.length).toBe(1);
    expect(metaNullLogs[0].level).toBe("warn");
    // Context: data-full-id value, matched selector
    const payload = metaNullLogs[0].args[1];
    expect(payload).toMatchObject({
      dataFullId: "abc_xyz",
      matchedSelector: ".audio_row[data-full-id]",
    });

    expect(btn.classList.contains("ymus-loading")).toBe(false);
    expect(btn.classList.contains("ymus-success")).toBe(false);
    expect(btn.classList.contains("ymus-error")).toBe(false);
    expect(toastWatch.toastsAdded.length).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  /**
   * Fixture 2: ref-null
   *
   * `startVkTrackInjector` is called with `null` (cast through `any`) so
   * `scanAndInject()` runs (and injects a button) but `onClickRef` stays
   * null. Per the task spec, this avoids needing a test-only export from
   * the injector module. Click → silent today; post-fix: one
   * `[YMus VK click] ref-null` warn line.
   */
  it("ref-null: handler runs while onClickRef is null emits exactly one ref-null warn line", () => {
    const row = createAudioRow({
      ownerId: 1,
      audioId: 100,
      artist: "Artist",
      title: "Title",
    });
    document.body.appendChild(row);

    const { startVkTrackInjector } = loadInjector();
    // Pass null to leave onClickRef === null at click time. This invokes
    // scanAndInject() (so the button gets injected with the click handler
    // closed over the audio element) without giving the handler a non-null
    // ref to call.
    (startVkTrackInjector as unknown as (cb: null) => void)(null);

    const btn = row.querySelector(".ymus-vk-dl-btn") as HTMLButtonElement;
    expect(btn).not.toBeNull();

    clickButton(btn);

    const refNullLogs = consoleSpies.clickLogs.filter(
      (e) => typeof e.args[0] === "string" && (e.args[0] as string).includes("ref-null")
    );
    expect(refNullLogs.length).toBe(1);
    expect(refNullLogs[0].level).toBe("warn");
    expect(refNullLogs[0].args[1]).toMatchObject({ ownerId_audioId: "1_100" });

    expect(btn.classList.contains("ymus-loading")).toBe(false);
    expect(btn.classList.contains("ymus-error")).toBe(false);
    expect(toastWatch.toastsAdded.length).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  /**
   * Fixture 3: already-loading
   *
   * Pre-set `ymus-loading` on the button before clicking. Today: silent
   * return. Post-fix: one `[YMus VK click] already-loading` info line and
   * no second sendMessage.
   */
  it("already-loading: button with ymus-loading class emits exactly one already-loading log line", () => {
    const row = createAudioRow({
      ownerId: 5,
      audioId: 555,
      artist: "Loading Artist",
      title: "Loading Title",
    });
    document.body.appendChild(row);

    const { startVkTrackInjector } = loadInjector();
    startVkTrackInjector(jest.fn());

    const btn = row.querySelector(".ymus-vk-dl-btn") as HTMLButtonElement;
    btn.classList.add("ymus-loading");

    clickButton(btn);

    const loadingLogs = consoleSpies.clickLogs.filter(
      (e) =>
        typeof e.args[0] === "string" &&
        (e.args[0] as string).includes("already-loading")
    );
    expect(loadingLogs.length).toBe(1);
    expect(loadingLogs[0].level).toBe("log");

    // No second dispatch: the click was ignored.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(toastWatch.toastsAdded.length).toBe(0);
  });

  /**
   * Fixture 4: exception
   *
   * Spy on `extractVkTrackMeta` so it throws synchronously inside the
   * handler. Today: throw escapes (no log, no DOM change). Post-fix:
   * one `[YMus VK click] exception` error line, `ymus-error` class on btn,
   * a `.ymus-vk-toast` is appended, and `document.body[data-ymus-last-error]`
   * is set to the error message.
   */
  it("exception: synchronous throw inside handler is caught, logged, ymus-error + toast + data-ymus-last-error set", () => {
    const row = createAudioRow({
      ownerId: 7,
      audioId: 777,
      artist: "Boom Artist",
      title: "Boom Title",
    });
    document.body.appendChild(row);

    const { injector, metaModule } = loadInjectorWithMetaSpy();
    const throwingErr = new Error("boom");
    jest.spyOn(metaModule, "extractVkTrackMeta").mockImplementation(() => {
      throw throwingErr;
    });

    injector.startVkTrackInjector(jest.fn());

    const btn = row.querySelector(".ymus-vk-dl-btn") as HTMLButtonElement;
    expect(btn).not.toBeNull();

    clickButton(btn);

    const exceptionLogs = consoleSpies.clickLogs.filter(
      (e) =>
        typeof e.args[0] === "string" && (e.args[0] as string).includes("exception")
    );
    expect(exceptionLogs.length).toBe(1);
    expect(exceptionLogs[0].level).toBe("error");

    expect(btn.classList.contains("ymus-error")).toBe(true);
    expect(toastWatch.toastsAdded.length).toBeGreaterThanOrEqual(1);
    expect(document.body.getAttribute("data-ymus-last-error")).toBe("boom");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  /**
   * Fixture 5: orphaned
   *
   * Inject button, then `audioEl.remove()` so it is detached. Click the
   * still-attached button (the test must keep a reference to it).
   *
   * Note: the design allows a one-shot recovery via
   * `btn.closest('[data-full-id], [data-sortable-id], [class*="AudioRow__root"]')`,
   * but in this fixture the button is no longer attached anywhere either
   * (we appended it inside `audioEl`). After `audioEl.remove()`, the
   * button has no ancestor and `closest()` returns null → recovery fails.
   *
   * Today: silent. Post-fix: one `[YMus VK click] orphaned` warn line +
   * `ymus-error` + toast.
   */
  it("orphaned: detached audio row click emits exactly one orphaned warn line + ymus-error + toast", () => {
    const row = createAudioRow({
      ownerId: 9,
      audioId: 999,
      artist: "Ghost Artist",
      title: "Ghost Title",
    });
    document.body.appendChild(row);

    const { startVkTrackInjector } = loadInjector();
    startVkTrackInjector(jest.fn());

    const btn = row.querySelector(".ymus-vk-dl-btn") as HTMLButtonElement;
    expect(btn).not.toBeNull();

    // Detach the row (and the button along with it)
    row.remove();
    expect(row.isConnected).toBe(false);
    expect(btn.isConnected).toBe(false);

    clickButton(btn);

    const orphanLogs = consoleSpies.clickLogs.filter(
      (e) =>
        typeof e.args[0] === "string" &&
        ((e.args[0] as string).includes("orphaned") ||
          (e.args[0] as string).includes("recovered"))
    );
    expect(orphanLogs.length).toBe(1);

    // Recovery failed (no replacement row in DOM) → ymus-error + toast.
    if (
      typeof orphanLogs[0].args[0] === "string" &&
      (orphanLogs[0].args[0] as string).includes("orphaned")
    ) {
      expect(btn.classList.contains("ymus-error")).toBe(true);
      expect(toastWatch.toastsAdded.length).toBeGreaterThanOrEqual(1);
    }

    expect(sendMessage).not.toHaveBeenCalled();
  });

  /**
   * Fixture 6: player-overlay page-bridge timeout
   *
   * Inject .AudioPlayerBlock__root + [class*="audioButtons"] (so the
   * player button is injected), but no current row anywhere in the DOM
   * and never dispatch `ymus-current-track-result`. Advance fake timers
   * past 5000 ms.
   *
   * Today: the existing setTimeout removes the listener silently. Post-fix:
   * one `[YMus VK click] meta-null { source: "player-overlay", reason:
   * "page-bridge-timeout" }` warn line + `ymus-error` + toast.
   */
  it("player-overlay page-bridge timeout: emits meta-null warn with source/reason + ymus-error + toast", () => {
    const block = createPlayerOverlay();

    const { startVkTrackInjector } = loadInjector();
    startVkTrackInjector(jest.fn());

    const playerBtn = block.querySelector(
      ".ymus-vk-player-dl-btn"
    ) as HTMLButtonElement;
    expect(playerBtn).not.toBeNull();

    clickButton(playerBtn);

    // Strategy 1 + 2 fail (no current row), strategy 3 dispatches event but
    // we never fire `ymus-current-track-result`. Advance past the 5000 ms
    // timeout in attachPlayerClickHandler.
    jest.advanceTimersByTime(6000);

    const metaNullPlayerLogs = consoleSpies.clickLogs.filter(
      (e) =>
        typeof e.args[0] === "string" &&
        (e.args[0] as string).includes("meta-null") &&
        typeof e.args[1] === "object" &&
        e.args[1] !== null &&
        (e.args[1] as Record<string, unknown>).source === "player-overlay"
    );
    expect(metaNullPlayerLogs.length).toBe(1);
    expect(metaNullPlayerLogs[0].level).toBe("warn");
    expect(metaNullPlayerLogs[0].args[1]).toMatchObject({
      source: "player-overlay",
      reason: "page-bridge-timeout",
    });

    expect(playerBtn.classList.contains("ymus-error")).toBe(true);
    expect(toastWatch.toastsAdded.length).toBeGreaterThanOrEqual(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

// =================================================================
//  Property 2 — Preservation (existing happy-path contract)
//  These MUST PASS on UNFIXED code today.
// =================================================================

describe("Property 2 — Preservation: happy-path contract is preserved", () => {
  let sendMessage: jest.Mock;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.removeAttribute("data-ymus-last-error");
    sendMessage = installChromeRuntimeMock();
  });

  /**
   * P5 — payload byte-equality
   *
   * For any meta record (random ownerId/audioId/artist/title with optional
   * encryptedUrl/accessKey), the payload sent to the background contains
   * exactly the canonical fields the original handler dispatches.
   *
   * Observed on UNFIXED code: the row click handler calls
   * `onClickRef(meta, btn)` which (in vk-content.ts) routes through
   * `onTrackClick` → `downloadTrackViaBackground` →
   * `chrome.runtime.sendMessage({ type: "VK_DOWNLOAD_TRACK", payload: { ownerId, audioId, artist, title, encryptedUrl } })`.
   *
   * Here we assert at the injector boundary: `onClickRef` is invoked with
   * a meta object whose key set matches the canonical VkTrackMeta shape.
   * (The downstream sendMessage shape is preserved by vk-content.ts and
   * is asserted in the integration test, not here, since this PBT scopes
   * to the injector.)
   */
  it("P5 payload-shape: onClickRef receives meta with canonical key set", () => {
    fc.assert(
      fc.property(
        ownerIdArb,
        audioIdArb,
        nonEmptyStrArb,
        nonEmptyStrArb,
        (ownerId, audioId, artist, title) => {
          document.body.innerHTML = "";
          const row = createAudioRow({ ownerId, audioId, artist, title });
          document.body.appendChild(row);

          const onClick = jest.fn();
          const { startVkTrackInjector } = loadInjector();
          startVkTrackInjector(onClick);

          const btn = row.querySelector(
            ".ymus-vk-dl-btn"
          ) as HTMLButtonElement;
          clickButton(btn);

          expect(onClick).toHaveBeenCalledTimes(1);
          const [meta, btnArg] = onClick.mock.calls[0];
          expect(btnArg).toBe(btn);

          // Canonical key set: ownerId, audioId, artist, title (encryptedUrl
          // and accessKey only appear when present in data-audio).
          expect(meta.ownerId).toBe(String(ownerId));
          expect(meta.audioId).toBe(String(audioId));
          expect(meta.artist).toBe(artist);
          expect(meta.title).toBe(title);

          // No surprise extra fields on the meta object the handler hands off.
          const allowedKeys = new Set([
            "ownerId",
            "audioId",
            "artist",
            "title",
            "encryptedUrl",
            "accessKey",
          ]);
          for (const k of Object.keys(meta)) {
            expect(allowedKeys.has(k)).toBe(true);
          }
        }
      ),
      { numRuns: 25 }
    );
  });

  /**
   * Event-propagation guards: `preventDefault`, `stopPropagation`, and
   * `stopImmediatePropagation` are called for every click that reaches
   * the handler — happy or silent-exit. Observed on UNFIXED code: the
   * three guards run at the top of the listener before any branch logic.
   */
  it("event-propagation: preventDefault/stopPropagation/stopImmediatePropagation are called on every click", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        ownerIdArb,
        audioIdArb,
        nonEmptyStrArb,
        nonEmptyStrArb,
        (preLoading, ownerId, audioId, artist, title) => {
          document.body.innerHTML = "";
          const row = createAudioRow({ ownerId, audioId, artist, title });
          document.body.appendChild(row);

          const onClick = jest.fn();
          const { startVkTrackInjector } = loadInjector();
          startVkTrackInjector(onClick);

          const btn = row.querySelector(
            ".ymus-vk-dl-btn"
          ) as HTMLButtonElement;
          if (preLoading) btn.classList.add("ymus-loading");

          // Build a click event and spy on its propagation methods.
          const ev = new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
          });
          const preventDefault = jest.spyOn(ev, "preventDefault");
          const stopPropagation = jest.spyOn(ev, "stopPropagation");
          const stopImmediate = jest.spyOn(ev, "stopImmediatePropagation");

          btn.dispatchEvent(ev);

          expect(preventDefault).toHaveBeenCalled();
          expect(stopPropagation).toHaveBeenCalled();
          expect(stopImmediate).toHaveBeenCalled();
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * No double-dispatch: a button already bearing `ymus-loading` does NOT
   * trigger a second `onClickRef` call across N clicks. Observed on
   * UNFIXED code: the early-return on `ymus-loading` prevents re-entry.
   */
  it("no-double-dispatch: ymus-loading suppresses subsequent onClickRef calls", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        ownerIdArb,
        audioIdArb,
        nonEmptyStrArb,
        nonEmptyStrArb,
        (clicks, ownerId, audioId, artist, title) => {
          document.body.innerHTML = "";
          const row = createAudioRow({ ownerId, audioId, artist, title });
          document.body.appendChild(row);

          const onClick = jest.fn();
          const { startVkTrackInjector } = loadInjector();
          startVkTrackInjector(onClick);

          const btn = row.querySelector(
            ".ymus-vk-dl-btn"
          ) as HTMLButtonElement;
          btn.classList.add("ymus-loading");

          for (let i = 0; i < clicks; i++) clickButton(btn);

          expect(onClick).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 15 }
    );
  });

  /**
   * Player strategy order: strategy 1 = `.audio_row_current[data-full-id]`,
   * strategy 2 = vkit playing/current row, strategy 3 = page-bridge.
   *
   * We assert: when strategy 1 is satisfied (a current row is in the DOM),
   * `onClickRef` is invoked synchronously with the meta from that row,
   * without dispatching the page-bridge `ymus-get-current-track` event.
   */
  it("player strategy order: classic .audio_row_current resolves first (no page-bridge)", () => {
    const block = createPlayerOverlay();

    const onClick = jest.fn();
    const { startVkTrackInjector } = loadInjector();
    startVkTrackInjector(onClick);

    // Strategy 1 row
    const currentRow = createAudioRow({
      ownerId: -1,
      audioId: 42,
      artist: "Now Playing",
      title: "Track",
    });
    currentRow.classList.add("audio_row_current");
    document.body.appendChild(currentRow);

    let bridgeRequested = false;
    document.addEventListener("ymus-get-current-track", () => {
      bridgeRequested = true;
    });

    const playerBtn = block.querySelector(
      ".ymus-vk-player-dl-btn"
    ) as HTMLButtonElement;
    clickButton(playerBtn);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0][0]).toMatchObject({
      ownerId: "-1",
      audioId: "42",
    });
    // Strategy 1 satisfied → never dispatched to page-bridge
    expect(bridgeRequested).toBe(false);
  });

  /**
   * Background-response handling: success → `ymus-success`; failure →
   * `ymus-error` (the actual class transitions are wired in vk-content.ts
   * via the sendMessage callback, which is OUT of scope for the injector
   * PBT). Here we verify only that the injector hands off the meta to
   * `onClickRef` and lets the consumer decide. This preserves the
   * delegation contract: the injector never sets `ymus-success`/`ymus-error`
   * on the happy path.
   */
  it("background-response delegation: injector sets neither success nor error on the happy path", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        ownerIdArb,
        audioIdArb,
        nonEmptyStrArb,
        nonEmptyStrArb,
        (_unused, ownerId, audioId, artist, title) => {
          document.body.innerHTML = "";
          const row = createAudioRow({ ownerId, audioId, artist, title });
          document.body.appendChild(row);

          const onClick = jest.fn();
          const { startVkTrackInjector } = loadInjector();
          startVkTrackInjector(onClick);

          const btn = row.querySelector(
            ".ymus-vk-dl-btn"
          ) as HTMLButtonElement;
          clickButton(btn);

          expect(btn.classList.contains("ymus-success")).toBe(false);
          expect(btn.classList.contains("ymus-error")).toBe(false);
        }
      ),
      { numRuns: 15 }
    );
  });

  /**
   * SPA rescan dedup: a row already bearing `data-ymus-vk-bound="1"` is
   * not re-injected. Observed on UNFIXED code: `scanAndInject` reads the
   * `VK_BOUND_ATTR` and skips bound rows.
   *
   * We simulate a rescan by adding a NEW row to the DOM (which
   * `MutationObserver` + `debouncedScan` will pick up) and verifying
   * that the originally-bound row has exactly one button while the new
   * row also gets exactly one button (no duplicates anywhere).
   */
  it("SPA rescan dedup: originally bound row keeps exactly one button after a rescan", async () => {
    jest.useFakeTimers();
    try {
      document.body.innerHTML = "";
      const row1 = createAudioRow({
        ownerId: 1,
        audioId: 1,
        artist: "A",
        title: "T1",
      });
      document.body.appendChild(row1);

      const { startVkTrackInjector } = loadInjector();
      startVkTrackInjector(jest.fn());

      expect(row1.querySelectorAll(".ymus-vk-dl-btn").length).toBe(1);
      expect(row1.getAttribute("data-ymus-vk-bound")).toBe("1");

      // Simulate SPA insertion of a new row.
      const row2 = createAudioRow({
        ownerId: 2,
        audioId: 2,
        artist: "B",
        title: "T2",
      });
      document.body.appendChild(row2);

      // MutationObserver schedules a debouncedScan after 200 ms.
      jest.advanceTimersByTime(300);

      // Original row still has exactly one button (no double-inject).
      expect(row1.querySelectorAll(".ymus-vk-dl-btn").length).toBe(1);
      // New row has exactly one button.
      expect(row2.querySelectorAll(".ymus-vk-dl-btn").length).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
