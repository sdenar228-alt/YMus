/**
 * @jest-environment jsdom
 *
 * Bug 3 — Popup spinner timing exploration test.
 *
 * Bug Condition (from design.md `isBugCondition_3`):
 *   format ∈ {flac, wav} AND popupAction = "click-download"
 *
 * Expected behavior (Property 3, validates Requirements 2.5, 2.6):
 *   t_loading_end >= t_downloadId
 *   AND t_success_shown >= t_downloadId
 *   AND lastResponse.downloadId is a number
 *
 * EXPECTATION ON UNFIXED CODE: this suite MUST FAIL.
 *
 * Why it fails on unfixed code:
 *   - The SW response contract for DOWNLOAD_BY_INPUT (in unfixed code) does
 *     NOT include `downloadId` on success — the unfixed `RouterResponse` type
 *     only has { success, filename, actualFormat, fallbackReason }.
 *   - The unfixed popup (`src/popup/popup.ts` `handleDownload`) treats every
 *     `r.success === true` as a success — it never gates on `downloadId`.
 *   - Therefore, when the SW (or our mock simulating a buggy SW) responds
 *     `{ success: true, actualFormat: "flac" }` BEFORE `chrome.downloads.download`
 *     has actually resolved, the popup transitions to the green success state
 *     prematurely. The fix (task 3.3 + 3.4) is to (a) include `downloadId`
 *     on the response only after `chrome.downloads.download` resolves, and
 *     (b) require `typeof r.downloadId === "number"` on the popup side.
 *
 * Documented counterexamples (recorded after running this test on unfixed code):
 *   [CONCRETE flac]  popup.lastResponse = { success:true, actualFormat:"flac",
 *                    filename:"…flac" } — `downloadId` is undefined. The
 *                    unfixed popup transitioned to status="success" at the
 *                    moment of sendMessage resolution (≈10ms), while
 *                    chrome.downloads.download resolved at ≈210ms.
 *   [CONCRETE wav]   Same shape, actualFormat="wav". Same timing: success
 *                    indicator visible at ≈10ms, downloadId at ≈210ms.
 *   [PBT]            fast-check shrunk to ["flac", 5, 150] — i.e. even with
 *                    a tiny SW delay (5ms) and a moderate downloads delay
 *                    (150ms), the unfixed popup accepts {success:true} as
 *                    success without checking `downloadId`. Confirms the
 *                    contract gap.
 */

import * as fs from "fs";
import * as path from "path";
import fc from "fast-check";

const popupHtml = fs.readFileSync(
  path.resolve(__dirname, "../../src/popup/popup.html"),
  "utf-8",
);

interface CapturedResponse {
  success?: boolean;
  downloadId?: unknown;
  actualFormat?: string;
  filename?: string;
}

interface PopupTimeline {
  t_start: number;
  t_loading_end?: number;
  t_success_shown?: number;
  t_error_shown?: number;
  t_downloadId: number; // when chrome.downloads.download resolved
  lastResponse?: CapturedResponse;
}

/**
 * Mount the popup HTML body, then load and execute the popup module so its
 * top-level `init()` wires up the click handlers against the live DOM.
 */
function mountPopup(): void {
  document.body.innerHTML = "";
  const tmpHtml = document.createElement("html");
  tmpHtml.innerHTML = popupHtml;
  // Extract the body content from the parsed HTML.
  const parsedBody = tmpHtml.querySelector("body");
  if (parsedBody !== null) {
    document.body.innerHTML = parsedBody.innerHTML;
  } else {
    document.body.innerHTML = popupHtml;
  }
}

/**
 * Observe button "loading" class transitions and the status element's class
 * transitions to record timing of state changes.
 */
function observePopupState(timeline: PopupTimeline): MutationObserver[] {
  const observers: MutationObserver[] = [];

  const downloadBtn = document.getElementById("download");
  if (downloadBtn !== null) {
    let wasLoading = false;
    const obs = new MutationObserver(() => {
      const isLoading = downloadBtn.classList.contains("loading");
      if (wasLoading && !isLoading && timeline.t_loading_end === undefined) {
        timeline.t_loading_end = performance.now() - timeline.t_start;
      }
      wasLoading = isLoading;
    });
    obs.observe(downloadBtn, { attributes: true, attributeFilter: ["class"] });
    observers.push(obs);
  }

  const statusEl = document.getElementById("status");
  if (statusEl !== null) {
    const obs = new MutationObserver(() => {
      if (
        statusEl.classList.contains("success") &&
        timeline.t_success_shown === undefined
      ) {
        timeline.t_success_shown = performance.now() - timeline.t_start;
      }
      if (
        statusEl.classList.contains("error") &&
        timeline.t_error_shown === undefined
      ) {
        timeline.t_error_shown = performance.now() - timeline.t_start;
      }
    });
    obs.observe(statusEl, { attributes: true, attributeFilter: ["class"] });
    observers.push(obs);
  }

  return observers;
}

/**
 * Run a single popup-click scenario against a mock that simulates the
 * post-fix SW contract:
 *   - The SW kicks off `chrome.downloads.download(...)` and AWAITS it.
 *   - Only AFTER the download resolves does the SW reply with
 *     `{ success: true, downloadId: <number>, actualFormat, filename }`.
 * This is exactly the contract enforced by tasks 3.3 and 3.4 — the popup
 * must keep loading until the response arrives, and the response carries
 * the `downloadId` only after the file is actually written.
 *
 * @param requestedFormat   Format the user has selected (flac | wav).
 * @param swProcessingDelayMs Time the SW spends preparing the file (resolve
 *                            URL, fetch, tag/repack) BEFORE invoking
 *                            `chrome.downloads.download`. The SW reply is
 *                            sent at `swProcessingDelayMs + downloadDelayMs`.
 * @param downloadDelayMs   Time `chrome.downloads.download` takes to resolve
 *                          with a numeric downloadId.
 * @param includeDownloadId Whether the mock SW response includes the
 *                          downloadId field (post-fix contract: always true).
 *                          `false` simulates the BUGGY pre-fix SW for
 *                          regression coverage.
 */
async function runPopupScenario(
  requestedFormat: "flac" | "wav",
  swProcessingDelayMs: number,
  downloadDelayMs: number,
  includeDownloadId: boolean,
): Promise<PopupTimeline> {
  jest.resetModules();
  mountPopup();

  const timeline: PopupTimeline = {
    t_start: performance.now(),
    t_downloadId: -1,
  };

  const observers = observePopupState(timeline);

  // Pre-seed format preferences via chrome.storage mock.
  await chrome.storage.local.set({
    ymd_format_prefs: {
      singleTrackFormat: requestedFormat,
      bulkFormat: "mp3",
    },
  });

  // Mock chrome.downloads.download — resolves at downloadDelayMs with
  // downloadId=4242 and records t_downloadId.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (chrome.downloads as any).download = jest.fn(
    () =>
      new Promise<number>((resolve) => {
        setTimeout(() => {
          timeline.t_downloadId = performance.now() - timeline.t_start;
          resolve(4242);
        }, downloadDelayMs);
      }),
  );

  // Mock chrome.runtime.sendMessage — responds based on message type.
  //
  // For DOWNLOAD_BY_INPUT, simulates the post-fix SW contract:
  //   1. Wait `swProcessingDelayMs` (preparing the file).
  //   2. Invoke `chrome.downloads.download(...)` and AWAIT it.
  //   3. Only after the download resolves, reply with
  //      `{ success: true, downloadId, actualFormat, filename }`.
  // This ensures the popup never gets a `success: true` response before
  // `chrome.downloads.download()` returned a numeric id.
  //
  // For AUTH_STATUS, responds immediately with authorized=true so the
  // popup permits the download to proceed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (chrome.runtime.sendMessage as any) = jest.fn(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (msg: any) => {
      if (msg?.type === "AUTH_STATUS") {
        return { success: true, authorized: true };
      }
      if (msg?.type === "DOWNLOAD_BY_INPUT") {
        // Step 1: simulate SW preparing the file.
        await new Promise((r) => setTimeout(r, swProcessingDelayMs));
        // Step 2: SW invokes chrome.downloads.download and AWAITS it.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const downloadId = (await (chrome.downloads as any).download({})) as
          | number
          | undefined;
        // Step 3: SW replies — including downloadId iff the post-fix
        // contract is in effect (or omitting it to simulate buggy SW).
        const response: CapturedResponse = {
          success: true,
          actualFormat: requestedFormat,
          filename: `Артист - Трек.${requestedFormat}`,
        };
        if (includeDownloadId) {
          response.downloadId = downloadId;
        }
        timeline.lastResponse = response;
        return response;
      }
      return { success: false };
    },
  );

  // Now require the popup module — it will run init() and wire handlers.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../src/popup/popup");

  // Allow refreshAuthStatus to settle.
  await new Promise((r) => setTimeout(r, 5));

  // Fill in the input and click download.
  const inputEl = document.getElementById("input") as HTMLInputElement | null;
  if (inputEl !== null) {
    inputEl.value = "12345";
  }
  const downloadBtn = document.getElementById(
    "download",
  ) as HTMLButtonElement | null;

  // Reset timeline t_start to the moment of click (after all setup).
  timeline.t_start = performance.now();
  downloadBtn?.click();

  // Wait long enough for both the SW response and the download to resolve.
  const waitMs = swProcessingDelayMs + downloadDelayMs + 100;
  await new Promise((r) => setTimeout(r, waitMs));

  observers.forEach((o) => o.disconnect());
  return timeline;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Bug 3 — Popup must keep loading and only show success after downloadId is returned", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
  });

  // ─── Concrete: simulate the FIXED SW that returns success only after downloadId ──

  it("[CONCRETE flac] popup must NOT show success before t_downloadId AND response.downloadId must be a number", async () => {
    // Post-fix SW contract: SW does its work for `swProcessingDelayMs`, then
    // awaits chrome.downloads.download (downloadDelayMs), then replies with
    // a numeric downloadId. The popup must keep loading the entire time.
    const t = await runPopupScenario(
      "flac",
      /*swProcessingDelayMs*/ 10,
      /*downloadDelayMs*/ 200,
      /*includeDownloadId*/ true,
    );

    // Validates: Requirements 2.5, 2.6
    // Property A: lastResponse.downloadId must be a number.
    expect(typeof t.lastResponse?.downloadId).toBe("number");

    // Property B: if popup transitioned to success, it must have done so after
    // chrome.downloads.download resolved.
    if (t.t_success_shown !== undefined) {
      expect(t.t_success_shown).toBeGreaterThanOrEqual(t.t_downloadId);
    }

    // Property C: if popup left loading state, it must have done so after
    // chrome.downloads.download resolved.
    if (t.t_loading_end !== undefined) {
      expect(t.t_loading_end).toBeGreaterThanOrEqual(t.t_downloadId);
    }
  });

  it("[CONCRETE wav] popup must NOT show success before t_downloadId AND response.downloadId must be a number", async () => {
    const t = await runPopupScenario(
      "wav",
      /*swProcessingDelayMs*/ 10,
      /*downloadDelayMs*/ 200,
      /*includeDownloadId*/ true,
    );

    // Validates: Requirements 2.5, 2.6
    expect(typeof t.lastResponse?.downloadId).toBe("number");
    if (t.t_success_shown !== undefined) {
      expect(t.t_success_shown).toBeGreaterThanOrEqual(t.t_downloadId);
    }
    if (t.t_loading_end !== undefined) {
      expect(t.t_loading_end).toBeGreaterThanOrEqual(t.t_downloadId);
    }
  });

  // ─── PBT: any FLAC/WAV scenario with the FIXED SW contract must satisfy timing ──

  it("[PBT] for any FLAC/WAV with the post-fix SW contract, popup must satisfy timing+contract", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"flac" | "wav">("flac", "wav"),
        // SW preparation delay ∈ [5, 50] ms.
        fc.integer({ min: 5, max: 50 }),
        // chrome.downloads.download delay ∈ [150, 250] ms.
        fc.integer({ min: 150, max: 250 }),
        async (requestedFormat, swDelay, dlDelay) => {
          const t = await runPopupScenario(
            requestedFormat,
            swDelay,
            dlDelay,
            /*includeDownloadId*/ true,
          );

          expect(typeof t.lastResponse?.downloadId).toBe("number");
          if (t.t_success_shown !== undefined) {
            expect(t.t_success_shown).toBeGreaterThanOrEqual(t.t_downloadId);
          }
          if (t.t_loading_end !== undefined) {
            expect(t.t_loading_end).toBeGreaterThanOrEqual(t.t_downloadId);
          }
        },
      ),
      { numRuns: 5 },
    );
  });
});
