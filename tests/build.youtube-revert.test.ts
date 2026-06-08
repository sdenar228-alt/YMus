/**
 * Build static test — youtube-buffer-capture-revert (Task 5.3)
 *
 * **Validates: Requirements 2.1, 2.2, 2.10**
 *
 * After Task 3.10 ships, `build.mjs` MUST register a `yt-page-bridge` entry
 * in its `ENTRIES` map so the MAIN-world bridge gets bundled and copied to
 * `dist/extension/yt-page-bridge.js` and into the unpacked `YMus/` folder.
 *
 *   1. `ENTRIES` contains a `"yt-page-bridge"` key with format `"iife"`,
 *      entry path ending with `src/yt-content/yt-page-bridge.ts`, and
 *      output filename `yt-page-bridge.js`.
 *   2. `ENTRIES` retains the existing `"yt-content"` entry (the isolated-
 *      world content script), since the revert refactors that file but
 *      does not remove it.
 *   3. `ENTRIES` does NOT register entries for any of the deleted cobalt
 *      modules (`cobalt-client`, `cobalt-error-classifier`,
 *      `yt-download-orchestrator`, `yt-sabr-fallback`,
 *      `yt-download-manager`). They were never explicit entries since they
 *      were imported transitively from `background.ts`, but a regression
 *      that promotes them back to `ENTRIES` would surface here.
 *   4. The previously built `dist/extension/yt-page-bridge.js` artifact
 *      exists, is non-empty, opens with the `"use strict"; (() => {` IIFE
 *      preamble (esbuild's IIFE format), DOES contain the strings
 *      `googlevideo.com` and `videoplayback` (proves the fetch hook
 *      shipped) and DOES NOT contain any of the cobalt host substrings.
 *
 * Property-based assertions iterate over each forbidden / required name
 * with `fast-check` so a violation surfaces as a specific counterexample.
 *
 * NOTE: We do NOT shell out to `node build.mjs` here — that is the
 * expensive happy path covered by Task 6 (`npm run build`). Instead we
 * statically parse `build.mjs` as text and verify the previously produced
 * artifact, which is fast and deterministic.
 */

import * as fc from "fast-check";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── File loading ────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, "..");
const BUILD_MJS_PATH = path.join(REPO_ROOT, "build.mjs");
const BUILD_MJS_SOURCE = fs.readFileSync(BUILD_MJS_PATH, "utf8");

const DIST_BRIDGE_PATH = path.join(
  REPO_ROOT,
  "dist",
  "extension",
  "yt-page-bridge.js",
);

// ─── Constants ───────────────────────────────────────────────────────────────

const REQUIRED_ENTRY_NAMES = ["yt-page-bridge", "yt-content"] as const;

/** Cobalt-style modules that must NEVER appear as ENTRIES keys in build.mjs.
 *  They were transitive imports from `background.ts` in the unfixed build,
 *  not explicit entries — but if a regression promotes them, this surfaces. */
const FORBIDDEN_ENTRY_NAMES = [
  "cobalt-client",
  "cobalt-error-classifier",
  "yt-download-orchestrator",
  "yt-sabr-fallback",
  "yt-download-manager",
] as const;

const FORBIDDEN_COBALT_SUBSTRINGS = [
  "ymuslink.duckdns.org",
  "cobalt-api.ayo.tf",
  "cobalt-api.luver.pw",
  "cobapi.elrant.team",
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pulls the body of a top-level `const ENTRIES = { … };` declaration from
 * `build.mjs` by counting balanced braces. Avoids a brittle regex that
 * would be confused by nested objects.
 */
function extractEntriesBlock(source: string): string {
  const startMarker = "const ENTRIES";
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) {
    throw new Error("build.mjs is missing a `const ENTRIES` declaration");
  }
  const openBrace = source.indexOf("{", startIdx);
  if (openBrace === -1) {
    throw new Error(
      "build.mjs `const ENTRIES` declaration has no opening brace",
    );
  }
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(openBrace, i + 1);
      }
    }
  }
  throw new Error("build.mjs `const ENTRIES` block is unterminated");
}

/**
 * Returns `true` iff `entriesBlock` declares a key matching `name`. Matches
 * both quoted (`"yt-page-bridge"`) and unquoted (`background:`) forms,
 * anchored to a `:` so we don't match incidental occurrences in nested
 * paths.
 */
function entriesHasKey(entriesBlock: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // "name": …  OR  'name': …  OR  bareName: …
  const re = new RegExp(
    `(^|\\s|,|\\{)("${escaped}"|'${escaped}'|${escaped})\\s*:`,
    "m",
  );
  return re.test(entriesBlock);
}

/**
 * Extracts the body of the inner-object literal for a given ENTRIES key.
 * Returns `null` if the key is not present.
 */
function extractEntryBody(
  entriesBlock: string,
  name: string,
): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerRe = new RegExp(
    `("${escaped}"|'${escaped}'|${escaped})\\s*:\\s*\\{`,
    "m",
  );
  const headerMatch = entriesBlock.match(headerRe);
  if (!headerMatch || headerMatch.index === undefined) return null;
  const openBrace = entriesBlock.indexOf("{", headerMatch.index);
  if (openBrace === -1) return null;
  let depth = 0;
  for (let i = openBrace; i < entriesBlock.length; i++) {
    const ch = entriesBlock[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return entriesBlock.slice(openBrace, i + 1);
      }
    }
  }
  return null;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("build.mjs — YouTube buffer-capture revert (Task 5.3)", () => {
  // ─── Required ENTRIES keys ──────────────────────────────────────────────

  /**
   * **Validates: Requirements 2.2, 2.10**
   *
   * Property: ∀ name ∈ REQUIRED_ENTRY_NAMES, name ∈ ENTRIES.
   *
   * The MAIN-world bridge (`yt-page-bridge`) and the isolated-world content
   * script (`yt-content`) must both be registered as build entries — the
   * bridge ports the cobalt-killing UMP fetch hook, the content script
   * routes clicks through it.
   */
  it("ENTRIES contains required entries (yt-page-bridge + yt-content)", () => {
    const entriesBlock = extractEntriesBlock(BUILD_MJS_SOURCE);
    fc.assert(
      fc.property(fc.constantFrom(...REQUIRED_ENTRY_NAMES), (name) => {
        expect(entriesHasKey(entriesBlock, name)).toBe(true);
      }),
      { numRuns: REQUIRED_ENTRY_NAMES.length },
    );
  });

  // ─── yt-page-bridge entry shape ─────────────────────────────────────────

  /**
   * **Validates: Requirements 2.2, 2.10**
   *
   * The bridge entry MUST point to `src/yt-content/yt-page-bridge.ts` so
   * esbuild bundles the right module, MUST emit `yt-page-bridge.js` as the
   * output filename so `manifest.json`'s `content_scripts.js` reference
   * resolves, and MUST use IIFE format because it ships in `world: "MAIN"`
   * at `document_start` — ESM would not work in that context.
   */
  it("yt-page-bridge entry has correct entry path, output filename, and IIFE format", () => {
    const entriesBlock = extractEntriesBlock(BUILD_MJS_SOURCE);
    const body = extractEntryBody(entriesBlock, "yt-page-bridge");
    expect(body).not.toBeNull();
    const bodyText = body!;

    // entry: …yt-page-bridge.ts (path may be built via path.join with
    // comma-separated arguments, so we don't restrict the chars).
    expect(bodyText).toMatch(/\bentry\s*:[^\n]*yt-page-bridge\.ts/);

    // The entry path joins through src/yt-content (legacy /YMus-legacy
    // would be the wrong source).
    expect(bodyText).toMatch(/["']yt-content["']/);
    expect(bodyText).toContain("yt-page-bridge.ts");

    // out: …yt-page-bridge.js
    expect(bodyText).toMatch(/\bout\s*:[^\n]*yt-page-bridge\.js/);

    // format: "iife"
    expect(bodyText).toMatch(/\bformat\s*:\s*["']iife["']/);
  });

  // ─── yt-content entry preserved ─────────────────────────────────────────

  /**
   * **Validates: Requirements 3.2, 3.3**
   *
   * The isolated-world content script entry stays intact — Task 3.4
   * refactored its source but did not remove the build entry.
   */
  it("yt-content entry is preserved with IIFE format and correct output", () => {
    const entriesBlock = extractEntriesBlock(BUILD_MJS_SOURCE);
    const body = extractEntryBody(entriesBlock, "yt-content");
    expect(body).not.toBeNull();
    const bodyText = body!;
    expect(bodyText).toMatch(/\bentry\s*:[^\n]*yt-content\.ts/);
    expect(bodyText).toMatch(/\bout\s*:[^\n]*yt-content\.js/);
    expect(bodyText).toMatch(/\bformat\s*:\s*["']iife["']/);
  });

  // ─── No deleted cobalt modules in ENTRIES ───────────────────────────────

  /**
   * **Validates: Requirements 2.1**
   *
   * Property: ∀ name ∈ FORBIDDEN_ENTRY_NAMES, name ∉ ENTRIES.
   *
   * Sanity check that the cobalt modules deleted in Task 3.8 were never
   * promoted to explicit build entries. They were transitive imports from
   * `background.ts`, so they would not normally appear here, but a
   * regression that re-introduces them would surface as a counterexample.
   */
  it("ENTRIES does NOT contain any deleted cobalt module name", () => {
    const entriesBlock = extractEntriesBlock(BUILD_MJS_SOURCE);
    fc.assert(
      fc.property(fc.constantFrom(...FORBIDDEN_ENTRY_NAMES), (name) => {
        expect(entriesHasKey(entriesBlock, name)).toBe(false);
      }),
      { numRuns: FORBIDDEN_ENTRY_NAMES.length },
    );
  });

  /**
   * **Validates: Requirements 2.1**
   *
   * Negative substring check on the entire `build.mjs` source: no cobalt
   * host appears in any path, comment, or default value.
   */
  it("build.mjs source contains no cobalt host substring", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FORBIDDEN_COBALT_SUBSTRINGS),
        (badSubstring) => {
          expect(BUILD_MJS_SOURCE).not.toContain(badSubstring);
        },
      ),
      { numRuns: FORBIDDEN_COBALT_SUBSTRINGS.length },
    );
  });

  // ─── Built artifact in dist/extension/ ──────────────────────────────────

  /**
   * **Validates: Requirements 2.2, 2.10**
   *
   * The previously built artifact `dist/extension/yt-page-bridge.js` must
   * exist and be non-empty. We do not shell out to `node build.mjs` here
   * — that is the expensive happy path covered by Task 6's
   * `npm run build`. The artifact is already produced as part of Task 3.10.
   */
  it("dist/extension/yt-page-bridge.js exists and is non-empty", () => {
    expect(fs.existsSync(DIST_BRIDGE_PATH)).toBe(true);
    const stat = fs.statSync(DIST_BRIDGE_PATH);
    expect(stat.size).toBeGreaterThan(0);
  });

  /**
   * **Validates: Requirements 2.2, 2.10**
   *
   * esbuild emits IIFE bundles with a `"use strict"; (() => { … })();`
   * preamble. The bundle MUST start with that wrapper because `world:
   * "MAIN"` content scripts run in the page's global scope, where ESM
   * `export` would throw.
   */
  it("dist/extension/yt-page-bridge.js opens with an IIFE wrapper", () => {
    const bundle = fs.readFileSync(DIST_BRIDGE_PATH, "utf8");
    expect(bundle).toMatch(/^"use strict";\s*\(\(\)\s*=>\s*\{/);
  });

  /**
   * **Validates: Requirements 2.1**
   *
   * Property: ∀ s ∈ FORBIDDEN_COBALT_SUBSTRINGS, s ∉ bundle.
   *
   * The cobalt modules are deleted; their host strings must not survive
   * into the bundled output.
   */
  it("dist/extension/yt-page-bridge.js does NOT contain any cobalt host substring", () => {
    const bundle = fs.readFileSync(DIST_BRIDGE_PATH, "utf8");
    fc.assert(
      fc.property(
        fc.constantFrom(...FORBIDDEN_COBALT_SUBSTRINGS),
        (badSubstring) => {
          expect(bundle).not.toContain(badSubstring);
        },
      ),
      { numRuns: FORBIDDEN_COBALT_SUBSTRINGS.length },
    );
  });

  /**
   * **Validates: Requirements 2.2**
   *
   * The bundle ships the fetch hook that intercepts `videoplayback`
   * responses on `*.googlevideo.com`. Both substrings should survive
   * bundling; their absence would mean the fetch hook was tree-shaken
   * away or the wrong file was bundled.
   */
  it("dist/extension/yt-page-bridge.js contains googlevideo.com + videoplayback strings", () => {
    const bundle = fs.readFileSync(DIST_BRIDGE_PATH, "utf8");
    expect(bundle).toContain("googlevideo.com");
    expect(bundle).toContain("videoplayback");
  });
});
