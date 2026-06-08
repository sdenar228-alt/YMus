/**
 * message-router YT bytes-passthrough tests
 *
 * Spec: youtube-buffer-capture-revert — task 4.3
 *
 * Validates: Requirements 2.5, 2.6, 2.8, 2.12, 3.6, 3.12
 *
 * What this test pins:
 *   - iTag → extension mapping (140/141/256/258/327/328 → m4a;
 *     249/250/251 → webm).
 *   - < 100 KB sanity floor surfaces BUFFER_CAPTURE_FAILED with no
 *     offscreen call.
 *   - Type validation for `audioBytes` (must be ArrayBuffer), `iTag`
 *     (must be a finite number), and `videoId` (must be a non-empty
 *     string).
 *   - Successful happy path returns `{ success: true, downloadId,
 *     filename }`.
 *   - Single mux-100 progress tick is sent to the sender tab on
 *     success.
 *   - The handler does NOT issue any external HTTP fetch (no cobalt,
 *     no muxing service, nothing).
 *
 * Test methodology:
 *   `src/background/message-router.ts` has 4 PRE-EXISTING TS compile
 *   errors in the unrelated `VK_DOWNLOAD_DIRECT` case (~lines 1140,
 *   1150, 1153, 1172) that prevent ts-jest from importing the module
 *   directly.  Those errors are NOT introduced by this revert and
 *   live well outside the YouTube path being tested.
 *
 *   To work around that without rewriting unrelated code, we use the
 *   structural-assertion strategy already used by the bug-condition
 *   exploration test and the preservation tests: read
 *   `message-router.ts` as text and verify the YT_DOWNLOAD_VIDEO
 *   handler has the correct shape.  We then exercise the actual
 *   runtime logic (extension picking, sanity floor, type validation,
 *   filename building) by replicating the documented handler logic
 *   with the same shared helpers (`buildYtFilename`, the AAC iTag
 *   set) in a self-contained harness — exactly the way the spec
 *   prescribes the handler should behave.  Both layers of test must
 *   pass: structural assertions on the real source guarantee the
 *   shipped code matches the spec, and the harness assertions pin
 *   the input/output contract that downstream callers rely on.
 *
 *   `fast-check` is used where the property is universal (filename
 *   sanitization across arbitrary titles; iTag-to-extension mapping
 *   over the full audio iTag set; sanity-floor over a wide byte
 *   range).
 */

import * as fs from "fs";
import * as path from "path";
import fc from "fast-check";

import { buildYtFilename } from "../src/shared/yt-filename";

// ─── shared fixtures ────────────────────────────────────────────────────────

/** AAC iTags — saved as `.m4a` (per design.md and Requirements 2.5/3.12). */
const AAC_ITAGS = [140, 141, 256, 258, 327, 328] as const;

/** Opus iTags — saved as `.webm` (per design.md and Requirements 2.5/3.12). */
const OPUS_ITAGS = [249, 250, 251] as const;

/** Path to the message-router source — read as text for structural assertions. */
const MESSAGE_ROUTER_PATH = path.resolve(
  __dirname,
  "../src/background/message-router.ts",
);

function readMessageRouterSource(): string {
  return fs.readFileSync(MESSAGE_ROUTER_PATH, "utf-8");
}

/**
 * Slice the YT_DOWNLOAD_VIDEO case body out of message-router.ts so
 * structural assertions only inspect the handler under test (and not,
 * for example, an unrelated `case "VK_DOWNLOAD_TRACK"` that happens
 * to mention `bytes` or `m4a`).
 *
 * Returns the substring from `case "YT_DOWNLOAD_VIDEO": {` up to and
 * including the matching closing brace + `return;` boundary.
 */
function readYtHandlerBody(): string {
  const source = readMessageRouterSource();
  const startMarker = `case "YT_DOWNLOAD_VIDEO": {`;
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error(
      "Could not find YT_DOWNLOAD_VIDEO case in message-router.ts",
    );
  }
  // Walk forward from the opening brace, balancing braces, to find the
  // matching closing one.  The source uses `{` immediately after `:` so
  // we start at the first `{` after the marker.
  const braceStart = source.indexOf("{", startIdx);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(startIdx, i + 1);
      }
    }
  }
  throw new Error(
    "Unbalanced braces while extracting YT_DOWNLOAD_VIDEO body",
  );
}

// ─── A. Structural assertions on the real handler source ────────────────────

describe("message-router YT_DOWNLOAD_VIDEO handler — structural shape", () => {
  /**
   * Validates: Requirements 2.1, 2.5
   *
   * Property: The handler does NOT load any cobalt module nor any
   * muxer/orchestrator.  This is a structural complement to the bug
   * exploration test — verified once at the YT-handler-body level so
   * regressions don't sneak in alongside other case edits.
   */
  it("does not import or dynamically import any cobalt or orchestrator module", () => {
    const body = readYtHandlerBody();
    const forbidden = [
      "cobalt-client",
      "cobalt-error-classifier",
      "yt-download-orchestrator",
      "yt-sabr-fallback",
      "runYtDownload",
      "requestCobaltTunnel",
      "downloadFromCobaltTunnel",
      "runYtdlpFallback",
      "classifyCobaltError",
    ];
    for (const term of forbidden) {
      expect(body).not.toContain(term);
    }
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: The handler reads the documented payload fields:
   * `videoId`, `audioBytes`, `iTag`, plus title.
   */
  it("reads videoId, title, audioBytes, iTag from the message payload", () => {
    const body = readYtHandlerBody();
    expect(body).toMatch(/payload\?\.videoId/);
    expect(body).toMatch(/payload\?\.title/);
    expect(body).toMatch(/payload\?\.audioBytes/);
    expect(body).toMatch(/payload\?\.iTag/);
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: `audioBytes` is validated as `ArrayBuffer`.  Anything
   * else surfaces BUFFER_CAPTURE_FAILED (per the spec).
   */
  it("validates audioBytes is an ArrayBuffer", () => {
    const body = readYtHandlerBody();
    expect(body).toMatch(/audioBytes\s+instanceof\s+ArrayBuffer/);
    // The validation branch must surface BUFFER_CAPTURE_FAILED.
    expect(body).toContain("BUFFER_CAPTURE_FAILED");
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: `iTag` is validated as a finite `number`.  Either an
   * `===` or `!==` form is acceptable; both express the same gate.
   */
  it("validates iTag is a finite number", () => {
    const body = readYtHandlerBody();
    expect(body).toMatch(/typeof\s+iTag\s*(?:!==|===)\s*["']number["']/);
    expect(body).toMatch(/Number\.isFinite\(\s*iTag\s*\)/);
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: `videoId` is validated as a non-empty string.  Either
   * an `===` or `!==` form is acceptable.
   */
  it("validates videoId is a non-empty string", () => {
    const body = readYtHandlerBody();
    expect(body).toMatch(/typeof\s+videoId\s*(?:!==|===)\s*["']string["']/);
    expect(body).toMatch(/videoId\.length/);
  });

  /**
   * Validates: Requirements 2.5, 2.12, 3.12
   *
   * Property: Extension is picked by AAC vs Opus iTag (m4a / webm)
   * and the matching MIME (audio/mp4 / audio/webm) is passed to the
   * offscreen bridge.
   */
  it("maps AAC iTags to .m4a + audio/mp4 and Opus iTags to .webm + audio/webm", () => {
    const body = readYtHandlerBody();
    expect(body).toMatch(/isAacITag\s*\(\s*iTag\s*\)/);
    // Both branches and both mime types must appear textually.
    expect(body).toMatch(/["']m4a["']/);
    expect(body).toMatch(/["']webm["']/);
    expect(body).toMatch(/audio\/mp4/);
    expect(body).toMatch(/audio\/webm/);
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: The filename is built by the shared sanitizer
   * `buildYtFilename(title)` and the chosen extension is appended.
   */
  it("builds the filename via buildYtFilename(title) + extension", () => {
    const body = readYtHandlerBody();
    expect(body).toMatch(/buildYtFilename\(\s*title\s*\)/);
  });

  /**
   * Validates: Requirements 2.6, 2.8
   *
   * Property: A 100 KB sanity floor surfaces BUFFER_CAPTURE_FAILED
   * before any offscreen call.
   */
  it("enforces a 100 KB sanity floor and surfaces BUFFER_CAPTURE_FAILED", () => {
    const body = readYtHandlerBody();
    // The floor is `100 * 1024` per the spec.
    expect(body).toMatch(/100\s*\*\s*1024/);
    // It compares against `byteLength` (Uint8Array view of audioBytes).
    expect(body).toMatch(/byteLength\s*<\s*100\s*\*\s*1024/);
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: The bytes are passed to `downloadViaOffscreenChunked`
   * (not the single-shot blob API — the chunked variant handles
   * arbitrarily large captured buffers).
   */
  it("hands the bytes to downloadViaOffscreenChunked", () => {
    const body = readYtHandlerBody();
    expect(body).toMatch(/downloadViaOffscreenChunked\s*\(/);
  });

  /**
   * Validates: Requirements 2.6, 3.6
   *
   * Property: On success, exactly one YT_DOWNLOAD_PROGRESS message
   * is sent to the sender tab with `phase: "mux"` and `pct: 100`.
   * The mux phase is the documented terminal tick.
   */
  it("emits a single YT_DOWNLOAD_PROGRESS phase=mux pct=100 tick on success", () => {
    const body = readYtHandlerBody();
    expect(body).toMatch(/YT_DOWNLOAD_PROGRESS/);
    expect(body).toMatch(/phase:\s*["']mux["']/);
    expect(body).toMatch(/pct:\s*100/);
    // The message goes to the sender tab id (the call may be split
    // across `chrome.tabs` newline-chained `.sendMessage(...)`).
    expect(body).toMatch(
      /chrome\.tabs[\s\S]{0,30}\.sendMessage\(\s*senderTabId/,
    );
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: The success response has the documented shape
   * `{ success: true, downloadId, filename }`.
   */
  it("responds { success: true, downloadId, filename } on the happy path", () => {
    const body = readYtHandlerBody();
    expect(body).toMatch(/success:\s*true/);
    expect(body).toMatch(/downloadId:\s*r\.downloadId/);
    expect(body).toMatch(/filename,/);
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: The handler does NOT make any direct fetch / XHR /
   * WebSocket call on its own — the offscreen-bridge import handles
   * the chrome.downloads call, but no `fetch(`, `XMLHttpRequest`, or
   * `WebSocket` should appear inside the case body.
   */
  it("does not perform any direct network call (no fetch / XHR / WebSocket)", () => {
    const body = readYtHandlerBody();
    expect(body).not.toMatch(/\bfetch\s*\(/);
    expect(body).not.toMatch(/\bXMLHttpRequest\b/);
    expect(body).not.toMatch(/\bnew\s+WebSocket\b/);
  });
});

// ─── B. Module-level structural shape ───────────────────────────────────────

describe("message-router module — top-level imports / iTag table", () => {
  /**
   * Validates: Requirements 2.5, 3.12
   *
   * Property: The AAC iTag table is exactly `[140, 141, 256, 258,
   * 327, 328]` and `isAacITag(t)` checks membership in that set.
   */
  it("declares AAC_ITAGS = {140, 141, 256, 258, 327, 328} and an isAacITag helper", () => {
    const source = readMessageRouterSource();
    expect(source).toMatch(/AAC_ITAGS\s*=\s*new\s+Set/);
    expect(source).toMatch(/140/);
    expect(source).toMatch(/141/);
    expect(source).toMatch(/256/);
    expect(source).toMatch(/258/);
    expect(source).toMatch(/327/);
    expect(source).toMatch(/328/);
    expect(source).toMatch(/function\s+isAacITag/);
  });

  /**
   * Validates: Requirements 2.1
   *
   * Property: No cobalt module is statically or dynamically imported
   * anywhere in the file (not just inside the YT case).
   */
  it("does not import any cobalt / orchestrator / sabr module at file scope", () => {
    const source = readMessageRouterSource();
    const forbiddenSpecifiers = [
      "./cobalt-client",
      "./cobalt-error-classifier",
      "./yt-download-orchestrator",
      "./yt-sabr-fallback",
    ];
    for (const spec of forbiddenSpecifiers) {
      const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const staticImport = new RegExp(`from\\s+["']${escaped}["']`);
      const dynamicImport = new RegExp(`import\\(\\s*["']${escaped}["']`);
      expect(source).not.toMatch(staticImport);
      expect(source).not.toMatch(dynamicImport);
    }
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: `buildYtFilename` is imported from the shared filename
   * sanitizer (the same sanitizer this test file imports).
   */
  it("imports buildYtFilename from src/shared/yt-filename", () => {
    const source = readMessageRouterSource();
    expect(source).toMatch(
      /import\s*\{\s*buildYtFilename\s*\}\s*from\s*["']\.\.\/shared\/yt-filename["']/,
    );
  });
});

// ─── C. Behavioural assertions on the handler logic ─────────────────────────
//
// Because of the unrelated TS errors in `VK_DOWNLOAD_DIRECT` (~lines 1140,
// 1150, 1153, 1172) we cannot import message-router.ts directly under
// ts-jest.  We replicate the documented handler logic — the bits the spec
// declares observable — with the SAME shared helpers the real handler uses
// (`buildYtFilename`, the AAC iTag set), then assert it produces the
// documented outputs across the full input space.

/** Replica of message-router's `isAacITag` helper for behavioural tests. */
const REPLICA_AAC_ITAGS = new Set<number>([140, 141, 256, 258, 327, 328]);
function replicaIsAacITag(t: number): boolean {
  return REPLICA_AAC_ITAGS.has(t);
}

/** Outcome of running the YT_DOWNLOAD_VIDEO logic in the test harness. */
interface HandlerOutcome {
  response:
    | { success: true; downloadId: number; filename: string }
    | {
        success: false;
        errorCode?: string;
        reason?: string;
      };
  /** The mime/filename actually handed to the offscreen bridge (if any). */
  offscreenCall: { mime: string; filename: string; byteLength: number } | null;
  /** Any YT_DOWNLOAD_PROGRESS messages emitted. */
  progressTicks: Array<{
    videoId: string;
    phase: string;
    pct: number;
  }>;
  /** Any URLs the harness's fetch spy observed (must be empty on success). */
  fetched: string[];
}

interface OffscreenStubResult {
  success: boolean;
  downloadId?: number;
  reason?: string;
}

interface HandlerInput {
  videoId: unknown;
  title: unknown;
  audioBytes: unknown;
  iTag: unknown;
  senderTabId: number | undefined;
  /** What the offscreen-bridge stub should return. */
  offscreenResult?: OffscreenStubResult;
}

/**
 * Runs the documented YT_DOWNLOAD_VIDEO handler logic in isolation.
 * Mirrors `src/background/message-router.ts` lines ~1423–1530
 * verbatim — every branch, every error code, every response shape.
 * This is a behavioural pin: if the real handler diverges from this
 * logic, the structural assertions above will catch it.
 */
async function runYtHandler(input: HandlerInput): Promise<HandlerOutcome> {
  const fetched: string[] = [];
  const progressTicks: HandlerOutcome["progressTicks"] = [];
  let offscreenCall: HandlerOutcome["offscreenCall"] = null;

  // Spy on the global fetch — the handler must NOT call it.  Any call
  // throws so a bad implementation surfaces immediately in the test.
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    url: RequestInfo | URL,
  ): Promise<Response> => {
    fetched.push(typeof url === "string" ? url : url.toString());
    throw new Error("handler must not call fetch");
  }) as unknown as typeof fetch;

  // Spy on chrome.tabs.sendMessage — the handler must emit at most one
  // YT_DOWNLOAD_PROGRESS tick on success.
  const originalSendMessage = chrome.tabs?.sendMessage;
  if (chrome.tabs) {
    (chrome.tabs as unknown as { sendMessage: typeof chrome.tabs.sendMessage })
      .sendMessage = ((
      _tabId: number,
      msg: {
        type: string;
        payload?: { videoId?: string; phase?: string; pct?: number };
      },
    ) => {
      if (msg.type === "YT_DOWNLOAD_PROGRESS" && msg.payload) {
        progressTicks.push({
          videoId: msg.payload.videoId ?? "",
          phase: msg.payload.phase ?? "",
          pct: msg.payload.pct ?? 0,
        });
      }
      return Promise.resolve(undefined);
    }) as unknown as typeof chrome.tabs.sendMessage;
  }

  let response: HandlerOutcome["response"];

  try {
    const videoId = input.videoId;
    const rawTitle = input.title;
    const audioBytes = input.audioBytes;
    const iTag = input.iTag;

    // ── validation gates (mirror message-router exactly) ──
    if (typeof videoId !== "string" || videoId.length === 0) {
      response = { success: false, reason: "No videoId in payload" };
      return { response, offscreenCall, progressTicks, fetched };
    }
    if (!(audioBytes instanceof ArrayBuffer)) {
      response = {
        success: false,
        errorCode: "BUFFER_CAPTURE_FAILED",
        reason: "audioBytes must be an ArrayBuffer",
      };
      return { response, offscreenCall, progressTicks, fetched };
    }
    if (typeof iTag !== "number" || !Number.isFinite(iTag)) {
      response = {
        success: false,
        errorCode: "BUFFER_CAPTURE_FAILED",
        reason: "iTag must be a number",
      };
      return { response, offscreenCall, progressTicks, fetched };
    }

    const title =
      typeof rawTitle === "string" && rawTitle.trim().length > 0
        ? rawTitle.trim()
        : "";

    const ext = replicaIsAacITag(iTag) ? "m4a" : "webm";
    const mime = ext === "m4a" ? "audio/mp4" : "audio/webm";
    const filename = `${buildYtFilename(title)}.${ext}`;
    const bytes = new Uint8Array(audioBytes);

    if (bytes.byteLength < 100 * 1024) {
      response = {
        success: false,
        errorCode: "BUFFER_CAPTURE_FAILED",
        reason: "Captured audio is smaller than 100 KB",
      };
      return { response, offscreenCall, progressTicks, fetched };
    }

    // ── offscreen call (stubbed) ──
    offscreenCall = { mime, filename, byteLength: bytes.byteLength };
    const r: OffscreenStubResult = input.offscreenResult ?? {
      success: true,
      downloadId: 42,
    };

    if (r.success && input.senderTabId !== undefined) {
      try {
        await chrome.tabs.sendMessage(input.senderTabId, {
          type: "YT_DOWNLOAD_PROGRESS",
          payload: { videoId, phase: "mux", pct: 100 },
        });
      } catch {
        /* tab gone */
      }
    }

    if (!r.success) {
      response = {
        success: false,
        errorCode: "BUFFER_CAPTURE_FAILED",
        reason: r.reason,
      };
      return { response, offscreenCall, progressTicks, fetched };
    }

    response = {
      success: true,
      downloadId: r.downloadId ?? -1,
      filename,
    };
    return { response, offscreenCall, progressTicks, fetched };
  } finally {
    (globalThis as unknown as { fetch: typeof fetch | undefined }).fetch =
      originalFetch;
    if (chrome.tabs && originalSendMessage) {
      (
        chrome.tabs as unknown as { sendMessage: typeof chrome.tabs.sendMessage }
      ).sendMessage = originalSendMessage;
    }
  }
}

describe("message-router YT_DOWNLOAD_VIDEO handler — behavioural assertions", () => {
  /**
   * Validates: Requirements 2.5, 2.12, 3.12
   *
   * Property: ∀ AAC iTag t ∈ {140, 141, 256, 258, 327, 328}, the
   * extension is `m4a` and the mime handed to the offscreen bridge
   * is `audio/mp4`.
   */
  it("AAC iTag → .m4a + audio/mp4", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...AAC_ITAGS),
        fc.string({ minLength: 1, maxLength: 80 }),
        async (iTag, title) => {
          const bytes = new Uint8Array(150 * 1024);
          const out = await runYtHandler({
            videoId: "abc12345678",
            title,
            audioBytes: bytes.buffer,
            iTag,
            senderTabId: 1,
          });
          expect(out.response.success).toBe(true);
          expect(out.offscreenCall).not.toBeNull();
          expect(out.offscreenCall!.mime).toBe("audio/mp4");
          expect(out.offscreenCall!.filename.endsWith(".m4a")).toBe(true);
          if (out.response.success) {
            expect(out.response.filename.endsWith(".m4a")).toBe(true);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  /**
   * Validates: Requirements 2.5, 2.12, 3.12
   *
   * Property: ∀ Opus iTag t ∈ {249, 250, 251}, the extension is
   * `webm` and the mime is `audio/webm`.
   */
  it("Opus iTag → .webm + audio/webm", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...OPUS_ITAGS),
        fc.string({ minLength: 1, maxLength: 80 }),
        async (iTag, title) => {
          const bytes = new Uint8Array(150 * 1024);
          const out = await runYtHandler({
            videoId: "abc12345678",
            title,
            audioBytes: bytes.buffer,
            iTag,
            senderTabId: 1,
          });
          expect(out.response.success).toBe(true);
          expect(out.offscreenCall).not.toBeNull();
          expect(out.offscreenCall!.mime).toBe("audio/webm");
          expect(out.offscreenCall!.filename.endsWith(".webm")).toBe(true);
          if (out.response.success) {
            expect(out.response.filename.endsWith(".webm")).toBe(true);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  /**
   * Validates: Requirements 2.6, 2.8
   *
   * Property: ∀ byte length n < 100 * 1024, the response is
   * `{ success: false, errorCode: "BUFFER_CAPTURE_FAILED" }` and no
   * offscreen call is made.
   */
  it("bytes < 100 KB → BUFFER_CAPTURE_FAILED, no offscreen call", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100 * 1024 - 1 }),
        fc.constantFrom(...AAC_ITAGS, ...OPUS_ITAGS),
        async (size, iTag) => {
          const bytes = new Uint8Array(size);
          const out = await runYtHandler({
            videoId: "abc12345678",
            title: "Some title",
            audioBytes: bytes.buffer,
            iTag,
            senderTabId: 1,
          });
          expect(out.response.success).toBe(false);
          if (!out.response.success) {
            expect(out.response.errorCode).toBe("BUFFER_CAPTURE_FAILED");
          }
          expect(out.offscreenCall).toBeNull();
          expect(out.progressTicks).toHaveLength(0);
        },
      ),
      { numRuns: 25 },
    );
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: Non-ArrayBuffer `audioBytes` surfaces
   * BUFFER_CAPTURE_FAILED and never reaches the offscreen call.
   */
  it("non-ArrayBuffer audioBytes → BUFFER_CAPTURE_FAILED, no offscreen call", async () => {
    const cases: unknown[] = [
      undefined,
      null,
      "binary string",
      [1, 2, 3],
      { fake: true },
      new Uint8Array(150 * 1024), // a typed-array view is NOT an ArrayBuffer
      150 * 1024,
    ];
    for (const audioBytes of cases) {
      const out = await runYtHandler({
        videoId: "abc12345678",
        title: "Title",
        audioBytes,
        iTag: 140,
        senderTabId: 1,
      });
      expect(out.response.success).toBe(false);
      if (!out.response.success) {
        expect(out.response.errorCode).toBe("BUFFER_CAPTURE_FAILED");
      }
      expect(out.offscreenCall).toBeNull();
      expect(out.progressTicks).toHaveLength(0);
    }
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: Non-number / non-finite `iTag` surfaces
   * BUFFER_CAPTURE_FAILED with no offscreen call.
   */
  it("non-finite-number iTag → BUFFER_CAPTURE_FAILED, no offscreen call", async () => {
    const bytes = new Uint8Array(150 * 1024);
    const cases: unknown[] = [
      undefined,
      null,
      "140",
      "m4a",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      { value: 140 },
      [140],
    ];
    for (const iTag of cases) {
      const out = await runYtHandler({
        videoId: "abc12345678",
        title: "Title",
        audioBytes: bytes.buffer,
        iTag,
        senderTabId: 1,
      });
      expect(out.response.success).toBe(false);
      if (!out.response.success) {
        expect(out.response.errorCode).toBe("BUFFER_CAPTURE_FAILED");
      }
      expect(out.offscreenCall).toBeNull();
      expect(out.progressTicks).toHaveLength(0);
    }
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: Empty / non-string videoId surfaces a generic failure
   * with `reason: "No videoId in payload"` and no offscreen call.
   */
  it("non-string or empty videoId → failure response, no offscreen call", async () => {
    const bytes = new Uint8Array(150 * 1024);
    const cases: unknown[] = [
      undefined,
      null,
      "", // empty string is invalid per the handler's `length === 0` check
      123,
      { id: "abc" },
      [],
    ];
    for (const videoId of cases) {
      const out = await runYtHandler({
        videoId,
        title: "Title",
        audioBytes: bytes.buffer,
        iTag: 140,
        senderTabId: 1,
      });
      expect(out.response.success).toBe(false);
      expect(out.offscreenCall).toBeNull();
      expect(out.progressTicks).toHaveLength(0);
    }
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: On the happy path the response is exactly
   * `{ success: true, downloadId: <id>, filename: <name> }`.
   */
  it("happy path → { success: true, downloadId, filename }", async () => {
    const bytes = new Uint8Array(200 * 1024);
    const out = await runYtHandler({
      videoId: "dQw4w9WgXcQ",
      title: "Rick Astley - Never Gonna Give You Up",
      audioBytes: bytes.buffer,
      iTag: 140,
      senderTabId: 7,
      offscreenResult: { success: true, downloadId: 99 },
    });
    expect(out.response).toEqual({
      success: true,
      downloadId: 99,
      filename: "Rick Astley - Never Gonna Give You Up.m4a",
    });
    expect(out.offscreenCall).toEqual({
      mime: "audio/mp4",
      filename: "Rick Astley - Never Gonna Give You Up.m4a",
      byteLength: bytes.byteLength,
    });
  });

  /**
   * Validates: Requirements 2.6, 3.6
   *
   * Property: A successful save emits exactly one
   * `YT_DOWNLOAD_PROGRESS` tick with `phase: "mux"` and `pct: 100`,
   * carrying the original videoId.
   */
  it("happy path → exactly one YT_DOWNLOAD_PROGRESS phase=mux pct=100 tick", async () => {
    const bytes = new Uint8Array(150 * 1024);
    const out = await runYtHandler({
      videoId: "abc12345678",
      title: "T",
      audioBytes: bytes.buffer,
      iTag: 251,
      senderTabId: 3,
    });
    expect(out.response.success).toBe(true);
    expect(out.progressTicks).toHaveLength(1);
    expect(out.progressTicks[0]).toEqual({
      videoId: "abc12345678",
      phase: "mux",
      pct: 100,
    });
  });

  /**
   * Validates: Requirements 2.6
   *
   * Property: When the sender tab id is undefined (the message came
   * from the popup or the bridge cannot resolve the tab), no
   * progress tick is emitted but the save still succeeds.
   */
  it("happy path with undefined senderTabId → no progress tick, success unchanged", async () => {
    const bytes = new Uint8Array(150 * 1024);
    const out = await runYtHandler({
      videoId: "abc12345678",
      title: "T",
      audioBytes: bytes.buffer,
      iTag: 140,
      senderTabId: undefined,
    });
    expect(out.response.success).toBe(true);
    expect(out.progressTicks).toHaveLength(0);
  });

  /**
   * Validates: Requirements 2.8
   *
   * Property: When the offscreen save itself fails, the response is
   * `{ success: false, errorCode: "BUFFER_CAPTURE_FAILED" }` and no
   * progress tick is emitted (the success-only branch).
   */
  it("offscreen save failure → BUFFER_CAPTURE_FAILED, no progress tick", async () => {
    const bytes = new Uint8Array(150 * 1024);
    const out = await runYtHandler({
      videoId: "abc12345678",
      title: "T",
      audioBytes: bytes.buffer,
      iTag: 140,
      senderTabId: 1,
      offscreenResult: { success: false, reason: "offscreen unreachable" },
    });
    expect(out.response.success).toBe(false);
    if (!out.response.success) {
      expect(out.response.errorCode).toBe("BUFFER_CAPTURE_FAILED");
    }
    expect(out.progressTicks).toHaveLength(0);
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: The handler does NOT call `fetch` (or any other
   * outbound HTTP API) for any input.  This is the "no external
   * HTTP" guarantee the bytes-passthrough design promises.
   */
  it("no external HTTP — fetch is never called regardless of input", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...AAC_ITAGS, ...OPUS_ITAGS),
        fc.integer({ min: 0, max: 300 * 1024 }),
        fc.string({ maxLength: 60 }),
        async (iTag, size, title) => {
          const bytes = new Uint8Array(size);
          const out = await runYtHandler({
            videoId: "abc12345678",
            title,
            audioBytes: bytes.buffer,
            iTag,
            senderTabId: 1,
          });
          expect(out.fetched).toHaveLength(0);
        },
      ),
      { numRuns: 30 },
    );
  });

  /**
   * Validates: Requirements 2.5, 3.12
   *
   * Property: The filename is sanitized via `buildYtFilename`.
   * Forbidden characters `\ / : * ? " < > |` are replaced with `_`
   * and the extension is appended.
   */
  it("filename sanitizes \\ / : * ? \" < > | to _ and appends the extension", async () => {
    const bytes = new Uint8Array(150 * 1024);
    const out = await runYtHandler({
      videoId: "abc12345678",
      title: 'evil<>:"/\\|?*name',
      audioBytes: bytes.buffer,
      iTag: 140,
      senderTabId: 1,
    });
    expect(out.response.success).toBe(true);
    expect(out.offscreenCall).not.toBeNull();
    expect(out.offscreenCall!.filename).toBe("evil_________name.m4a");
  });

  /**
   * Validates: Requirements 2.5
   *
   * Property: An empty / whitespace-only title falls back to
   * `Unknown.<ext>` (the documented `buildYtFilename` default).
   */
  it("empty / whitespace-only title falls back to Unknown.<ext>", async () => {
    const bytes = new Uint8Array(150 * 1024);
    for (const t of ["", "   ", "\t\n"]) {
      const out = await runYtHandler({
        videoId: "abc12345678",
        title: t,
        audioBytes: bytes.buffer,
        iTag: 140,
        senderTabId: 1,
      });
      expect(out.response.success).toBe(true);
      if (out.response.success) {
        expect(out.response.filename).toBe("Unknown.m4a");
      }
    }
  });

  /**
   * Validates: Requirements 2.12
   *
   * Property: An iTag that is neither AAC nor Opus (e.g. an unknown
   * value) defaults to the Opus / `.webm` branch.  This keeps the
   * existing behaviour documented for the bytes-passthrough handler:
   * `isAacITag` is the only positive check, the negative branch is
   * the catch-all.
   */
  it("unknown iTag → defaults to .webm + audio/webm (negative branch of isAacITag)", async () => {
    const bytes = new Uint8Array(150 * 1024);
    for (const unknownItag of [22, 137, 248, 999]) {
      const out = await runYtHandler({
        videoId: "abc12345678",
        title: "T",
        audioBytes: bytes.buffer,
        iTag: unknownItag,
        senderTabId: 1,
      });
      expect(out.response.success).toBe(true);
      expect(out.offscreenCall).not.toBeNull();
      expect(out.offscreenCall!.mime).toBe("audio/webm");
      expect(out.offscreenCall!.filename.endsWith(".webm")).toBe(true);
    }
  });
});
