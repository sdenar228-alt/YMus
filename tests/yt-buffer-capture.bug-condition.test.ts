/**
 * Bug Condition Exploration Test — youtube-buffer-capture-revert
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1**
 *
 * Property 1 — Bug Condition (from design.md `isBugCondition`):
 *
 *   matchesYtPage(pageUrl) AND NOT isDrm AND NOT isLive AND clickRoutesThroughCobalt(input)
 *
 * On the unfixed build `clickRoutesThroughCobalt` is true unconditionally —
 * every non-DRM, non-live YouTube click drives the `YT_DOWNLOAD_VIDEO` handler
 * in `src/background/message-router.ts`, which dynamically imports
 * `cobalt-client.ts`, `cobalt-error-classifier.ts`, `yt-download-orchestrator.ts`,
 * and `yt-sabr-fallback.ts`, and the resulting `runYtDownload` call issues a
 * `POST https://ymuslink.duckdns.org/` request.  When that request fails (the
 * user's host is offline; the public mirrors `cobalt-api.ayo.tf`,
 * `cobalt-api.luver.pw`, `cobapi.elrant.team` are unreliable) the orchestrator
 * falls through to the SABR fallback stub which always throws
 * `NoSuitableQualityError` → the user sees `NO_SUITABLE_QUALITY` and no file is
 * produced.  That is the bug this spec reverts.
 *
 * **THIS TEST IS EXPECTED TO FAIL ON THE UNFIXED CODE**.  The failure surfaces
 * the counter-examples that prove every generated `videoId` routes through
 * cobalt.  After the revert (tasks 3.1–3.10) the same test must PASS unchanged
 * (task 3.11) — that is how Property 1 is validated.
 *
 * Three independent assertions, each scoped to `fast-check`-generated
 * `videoId ∈ [A-Za-z0-9_-]{11}` with a fixed page state
 * `{ pageUrl: "https://www.youtube.com/watch?v=<id>", isDrm: false, isLive: false,
 * pageAgeMs: 3000 }` so every input satisfies `isBugCondition`:
 *
 *   A. **fetch-spy**: invoke the cobalt module that the click flow lands in
 *      (`cobalt-client.requestCobaltTunnel`) and assert no fetched URL contains
 *      `cobalt-api.ayo.tf`, `cobalt-api.luver.pw`, `cobapi.elrant.team`, or
 *      `ymuslink.duckdns.org`.  Will FAIL on the unfixed build because
 *      `cobalt-client.ts` issues `POST https://ymuslink.duckdns.org/`.  On the
 *      fixed build the module is deleted → no fetch can happen → property
 *      holds vacuously.
 *
 *   B. **import-graph**: parse `src/background/message-router.ts` as text and
 *      assert it does NOT mention `./cobalt-client`, `./cobalt-error-classifier`,
 *      `./yt-download-orchestrator`, or `./yt-sabr-fallback` (static OR dynamic
 *      `import("...")`).  Will FAIL because the unfixed router lazily imports
 *      all four modules inside the `YT_DOWNLOAD_VIDEO` case.
 *
 *   C. **SABR-stub**: invoke `yt-sabr-fallback.runYtdlpFallback` (the cobalt-5xx
 *      fall-through path) and assert it does NOT throw a
 *      `NoSuitableQualityError`.  Will FAIL on the unfixed build because the
 *      stub unconditionally raises that error.  On the fixed build the module
 *      is deleted → no SABR stub → property holds vacuously.
 *
 * Per the spec we do NOT attempt to fix the failures from this test — the
 * failure IS the success criterion at this stage of the bugfix workflow.
 */

import * as fs from "fs";
import * as path from "path";
import fc from "fast-check";

// `jest-webextension-mock` is loaded by jest.config.js setupFiles, so
// `chrome.*` is already mocked when this file runs.

// ─── shared fixtures ─────────────────────────────────────────────────────────

/** Hosts that the bug condition forbids the fixed code from contacting. */
const COBALT_HOSTS = [
  "cobalt-api.ayo.tf",
  "cobalt-api.luver.pw",
  "cobapi.elrant.team",
  "ymuslink.duckdns.org",
] as const;

/** Cobalt module specifiers that must not be reachable from message-router.ts. */
const COBALT_MODULE_SPECIFIERS = [
  "./cobalt-client",
  "./cobalt-error-classifier",
  "./yt-download-orchestrator",
  "./yt-sabr-fallback",
] as const;

/** YouTube videoId arbitrary: 11 characters from `[A-Za-z0-9_-]`. */
const videoIdArb = fc.stringMatching(/^[A-Za-z0-9_-]{11}$/);

/**
 * Read `src/background/message-router.ts` as text.  Done synchronously so the
 * assertion runs deterministically inside `fc.property`.
 */
function readMessageRouterSource(): string {
  return fs.readFileSync(
    path.resolve(__dirname, "../src/background/message-router.ts"),
    "utf-8",
  );
}

// ─── fetch-spy harness ───────────────────────────────────────────────────────

interface FetchSpyHarness {
  fetched: string[];
  restore: () => void;
}

/**
 * Replace `globalThis.fetch` with a spy that records every requested URL and
 * returns a cobalt-style HTTP 503 response (simulating "all hosts offline" —
 * exactly the failure mode this spec reverts).
 */
function installFetchSpy(): FetchSpyHarness {
  const original = globalThis.fetch;
  const fetched: string[] = [];
  const spy = jest.fn(
    async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      fetched.push(url);
      return new Response("upstream offline", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      });
    },
  );
  (globalThis as unknown as { fetch: typeof fetch }).fetch =
    spy as unknown as typeof fetch;
  return {
    fetched,
    restore: () => {
      (globalThis as unknown as { fetch: typeof fetch | undefined }).fetch =
        original;
    },
  };
}

/**
 * Try to require the named module from the project source.  Returns `null` if
 * the module does not exist (which is the expected state after the revert).
 * Any other failure is re-thrown so genuine breakage is not silently masked.
 */
function tryRequire<T>(specifier: string): T | null {
  try {
    return require(specifier) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const msg = (err as Error | undefined)?.message ?? "";
    if (
      code === "MODULE_NOT_FOUND" ||
      msg.includes("Cannot find module")
    ) {
      return null;
    }
    throw err;
  }
}

// ─── A. fetch-spy ────────────────────────────────────────────────────────────

describe("Property 1 — Bug Condition: cobalt path is taken on every YouTube click", () => {
  // Each assertion is a separate `fc.property` so counter-examples are
  // surfaced independently.  Run counts are kept low (3–5) because every
  // iteration imports a cobalt module and replaces `globalThis.fetch`.

  it("A. click flow does NOT issue any fetch to a cobalt host (FAILS on unfixed)", async () => {
    await fc.assert(
      fc.asyncProperty(videoIdArb, async (videoId) => {
        // Lazy require so the module's load failure (after the fix deletes it)
        // is observed here rather than at the top of the test file.
        const cobaltClient = tryRequire<{
          requestCobaltTunnel: (args: {
            youtubeUrl: string;
            quality: "1080p";
            signal?: AbortSignal;
          }) => Promise<unknown>;
        }>("../src/background/cobalt-client");

        if (cobaltClient === null) {
          // Module is gone — the cobalt path cannot be exercised at all.
          // Property holds vacuously: no cobalt fetch can be issued.
          return;
        }

        const harness = installFetchSpy();
        const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
          // Drive the same code path the unfixed `YT_DOWNLOAD_VIDEO` handler
          // takes when it invokes `runYtDownload({ videoId, url, title }, …)`.
          // We swallow the rejection because cobalt-client throws on HTTP 503,
          // which is fine — we only care about which URL was fetched.
          await cobaltClient
            .requestCobaltTunnel({
              youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
              quality: "1080p",
            })
            .catch(() => {});

          for (const url of harness.fetched) {
            for (const host of COBALT_HOSTS) {
              if (url.includes(host)) {
                throw new Error(
                  `Bug Condition counterexample for videoId="${videoId}": ` +
                    `click issued fetch to cobalt host "${host}" — ${url}`,
                );
              }
            }
          }
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
          harness.restore();
        }
      }),
      { numRuns: 5 },
    );
  }, 30_000);

  // ─── B. import-graph ───────────────────────────────────────────────────────

  it("B. message-router.ts does NOT import any cobalt module (FAILS on unfixed)", () => {
    fc.assert(
      fc.property(videoIdArb, () => {
        // The assertion is independent of `videoId` — fast-check gives us
        // free shrinking and the input keeps the property typed against a
        // value satisfying isBugCondition.  Reading the source on every
        // iteration is cheap (~50 KB).
        const source = readMessageRouterSource();

        for (const spec of COBALT_MODULE_SPECIFIERS) {
          // Match both static (`from "./cobalt-client"`) and dynamic
          // (`import("./cobalt-client")`) forms.  Escape regex meta chars
          // in the specifier defensively.
          const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const staticImport = new RegExp(`from\\s+["']${escaped}["']`);
          const dynamicImport = new RegExp(
            `import\\(\\s*["']${escaped}["']\\s*\\)`,
          );
          if (staticImport.test(source) || dynamicImport.test(source)) {
            throw new Error(
              `Bug Condition counterexample: message-router.ts still imports ` +
                `from "${spec}" (the YT_DOWNLOAD_VIDEO handler routes through ` +
                `cobalt)`,
            );
          }
        }
      }),
      { numRuns: 3 },
    );
  });

  // ─── C. SABR stub ─────────────────────────────────────────────────────────

  it(
    "C. SABR fallback stub does NOT throw `NoSuitableQualityError` (FAILS on unfixed)",
    async () => {
      await fc.assert(
        fc.asyncProperty(videoIdArb, async (videoId) => {
          const sabr = tryRequire<{
            runYtdlpFallback: (args: {
              videoId: string;
              url: string;
              quality: "1080p";
              onProgress: (pct?: number) => void;
              signal?: AbortSignal;
            }) => Promise<Uint8Array>;
          }>("../src/background/yt-sabr-fallback");

          if (sabr === null) {
            // Module is gone — the SABR stub cannot throw because it does not
            // exist.  Property holds vacuously.
            return;
          }

          let thrown: unknown = undefined;
          try {
            await sabr.runYtdlpFallback({
              videoId,
              url: `https://www.youtube.com/watch?v=${videoId}`,
              quality: "1080p",
              onProgress: () => {},
            });
          } catch (e) {
            thrown = e;
          }

          // Guard against the exact failure pattern documented in
          // bugfix.md §1.3: "the SABR fallback in yt-sabr-fallback.ts is a
          // stub that throws NoSuitableQualityError in this build, and the
          // user sees NO_SUITABLE_QUALITY with no file produced".
          const name =
            thrown instanceof Error ? thrown.constructor.name : undefined;
          if (name === "NoSuitableQualityError") {
            throw new Error(
              `Bug Condition counterexample for videoId="${videoId}": ` +
                `SABR fallback threw NoSuitableQualityError — the user sees ` +
                `"NO_SUITABLE_QUALITY" and no file is produced. ` +
                `On the fixed build this code path does not exist.`,
            );
          }
        }),
        { numRuns: 5 },
      );
    },
    30_000,
  );
});
