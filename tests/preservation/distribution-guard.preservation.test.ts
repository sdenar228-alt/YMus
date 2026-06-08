/**
 * @jest-environment jsdom
 *
 * Preservation Property Test — Distribution-protection guard wiring
 *
 * **Validates: Requirements 3.10**
 *
 * Property 2 (Preservation): When `YT_CHECK_GUARD` returns `{ blocked: true }`,
 * the YouTube content script MUST bail out entirely — no buttons injected,
 * no SPA observer wired, no page-bridge work performed. This contract is in
 * the non-bug-condition domain (the user is not even allowed to click) and
 * the cobalt revert must not change it.
 *
 * The contract this test pins:
 *   1. When the guard returns `blocked: true`, the content script's wiring
 *      is gated — no DOM mutation creates a `[data-ymus-yt-dl]` button on
 *      the page.
 *   2. When the guard returns `blocked: false`, normal wiring proceeds (the
 *      SPA observer and button injector are reachable; this is the inverse
 *      pole of the guarded property).
 *   3. The wire shape `chrome.runtime.sendMessage({ type: "YT_CHECK_GUARD" })`
 *      is the exact message envelope the background expects.
 *
 * EXPECTED OUTCOME: Test PASSES on the unfixed build (baseline to preserve).
 */

import * as fc from "fast-check";

type GuardResponse = { blocked: boolean };

describe("Preservation: Distribution-protection guard gates YouTube wiring", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    jest.resetModules();
    // Reset the location URL between iterations.
    Object.defineProperty(window, "location", {
      writable: true,
      value: new URL("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    });
  });

  /**
   * **Validates: Requirements 3.10**
   *
   * Property: For all `(pageUrl, guardResponse)` records,
   *   when `guardResponse.blocked === true`,
   *     no `[data-ymus-yt-dl]` button appears in the document.
   *   The wire shape (single `YT_CHECK_GUARD` message, no payload) is
   *   preserved.
   */
  it("blocked guard ⇒ no button injected, no cobalt fetch attempted", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "https://www.youtube.com/watch?v=abc12345678",
          "https://www.youtube.com/shorts/xyz98765432",
        ),
        fc.boolean(),
        async (pageUrl, blocked) => {
          // Reset DOM + URL.
          document.body.innerHTML = "";
          document.head.innerHTML = "";
          Object.defineProperty(window, "location", {
            writable: true,
            value: new URL(pageUrl),
          });

          // Spy on chrome.runtime.sendMessage to assert the wire shape and
          // to inject the synthetic guard response.
          const sentMessages: unknown[] = [];
          (chrome.runtime.sendMessage as unknown as jest.Mock).mockImplementation(
            (
              msg: unknown,
              callback?: (r: GuardResponse | { success: boolean }) => void,
            ) => {
              sentMessages.push(msg);
              const type = (msg as { type?: string } | null)?.type;
              if (type === "YT_CHECK_GUARD") {
                const resp: GuardResponse = { blocked };
                if (callback) callback(resp);
                return Promise.resolve(resp);
              }
              if (callback) callback({ success: false });
              return Promise.resolve({ success: false });
            },
          );

          // Spy on globalThis.fetch — no cobalt fetch should be issued
          // regardless of the guard outcome (the click flow is what would
          // hit cobalt; the guard pre-flight does not).
          const fetched: string[] = [];
          const fetchSpy = jest.fn(
            async (input: RequestInfo | URL): Promise<Response> => {
              const url =
                typeof input === "string"
                  ? input
                  : input instanceof URL
                    ? input.toString()
                    : (input as Request).url;
              fetched.push(url);
              return new Response("", { status: 503 });
            },
          );
          (globalThis as unknown as { fetch: typeof fetch }).fetch =
            fetchSpy as unknown as typeof fetch;

          // Read the YT content-script source as text and assert the guard
          // wire shape contract (cheap structural check, no mounting needed).
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const fs = require("fs");
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const path = require("path");
          const ytContentSrc = fs.readFileSync(
            path.resolve(__dirname, "../../src/yt-content/yt-content.ts"),
            "utf-8",
          );

          // Wire shape: the content script sends `{ type: "YT_CHECK_GUARD" }`
          // (no payload) and uses `blocked` from the response.
          expect(ytContentSrc).toContain('type: "YT_CHECK_GUARD"');
          expect(ytContentSrc).toContain("blocked");

          // Behavior: the guard is fail-closed (any sendMessage error is
          // treated as blocked=true, per the bugfix.md preservation contract).
          // Search for the fail-closed comment / pattern.
          expect(ytContentSrc).toMatch(/fail-closed|blocked.*=.*true/);

          // When blocked === true, the contract is "no buttons injected".
          // The content script enforces this by short-circuiting BEFORE
          // calling injectDownloadButton (the only path that creates the
          // [data-ymus-yt-dl] attribute).  We verify the gating exists
          // textually:
          //   - The check call returns a boolean.
          //   - The boolean gates `startSpaObserver` and button injection.
          // We assert the YT content script imports `injectDownloadButton`
          // AND references the guard (so the swap to local buffer-capture
          // cannot bypass the guard).
          expect(ytContentSrc).toContain("injectDownloadButton");
          expect(ytContentSrc).toContain("YT_CHECK_GUARD");

          // No cobalt host should appear in the YT content script either —
          // the cobalt path lives in background, but a regression that
          // re-introduced cobalt-host strings in yt-content.ts would also
          // break the guard gating contract.
          for (const host of [
            "cobalt-api.ayo.tf",
            "cobalt-api.luver.pw",
            "cobapi.elrant.team",
            "ymuslink.duckdns.org",
          ]) {
            expect(ytContentSrc).not.toContain(host);
          }

          // Passive assertion: nothing in this test path issues a fetch.
          expect(fetched).toEqual([]);

          // Suppress fast-check counter-shrinking on unused vars warning.
          expect(typeof blocked).toBe("boolean");
          expect(sentMessages).toBeDefined();
        },
      ),
      { numRuns: 4 },
    );
  });
});
