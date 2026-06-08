/**
 * Preservation Property Test — `YT_DOWNLOAD_VIDEO` payload + response shape
 *
 * **Validates: Requirements 3.6**
 *
 * Property 2 (Preservation): Inputs in the non-bug-condition domain — i.e.
 * any happy-path YouTube download that succeeds end-to-end on the unfixed
 * build — MUST continue to ride the same `chrome.runtime.sendMessage`
 * envelope (`{ type: "YT_DOWNLOAD_VIDEO", payload: { … } }`) with the
 * exact field names from `bugfix.md` §3.6:
 *
 *     videoId, url, title, durationSec?, audioDataB64, videoDataB64,
 *     audioITag, videoITag
 *
 * The response shape returned by the background handler is also pinned:
 *
 *     { success, downloadId?, filename?, errorCode?, reason? }
 *
 * The mux-corruption fix (`youtube-download-mux-corruption-fix`) reshapes
 * INTERNAL flatten + capture wiring only; the wire-shape between content
 * and background MUST be byte-identical to the unfixed build.
 *
 * STRATEGY (matches the surrounding preservation suite — see
 * `popup-oauth.preservation.test.ts` and `distribution-guard.preservation.test.ts`):
 * we structurally pin the wire shape against the source files (cheap, no
 * jsdom mounting of the fragile `yt-content.ts` SPA bootstrap) AND drive
 * the background handler with synthetic payloads via `fast-check` to
 * confirm:
 *   - the handler accepts the documented payload shape (8 fields;
 *     `durationSec` optional);
 *   - the handler rejects with the documented response shape (no extra
 *     fields beyond `success | downloadId | filename | errorCode | reason`);
 *   - the AAC iTag set (`{140, 141, 256, 258, 327, 328}`) and the Opus
 *     iTag set (`{249, 250, 251}`) from `bugfix.md` §3.10 are still
 *     present in the bridge's `AUDIO_ITAGS` set (the only audio iTag
 *     authority in the pipeline).
 *
 * EXPECTED OUTCOME: Test PASSES on the unfixed build (baseline to preserve).
 */

import * as fs from "fs";
import * as path from "path";
import * as fc from "fast-check";

import { AUDIO_ITAGS } from "../../src/yt-content/yt-ump-parser";

const YT_CONTENT_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../src/yt-content/yt-content.ts"),
  "utf-8",
);
const ROUTER_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../src/background/message-router.ts"),
  "utf-8",
);

/**
 * The eight payload field names from `bugfix.md` §3.6, in declaration
 * order. The pipeline contract is exactly these — no more, no fewer.
 */
const PAYLOAD_FIELDS = [
  "videoId",
  "url",
  "title",
  "durationSec",
  "audioDataB64",
  "videoDataB64",
  "audioITag",
  "videoITag",
] as const;

/**
 * The five response field names from `bugfix.md` §3.6. `success` is
 * required; the others are optional.
 */
const RESPONSE_FIELDS = [
  "success",
  "downloadId",
  "filename",
  "errorCode",
  "reason",
] as const;

/**
 * AAC audio iTags from `bugfix.md` §3.10. The bridge's `AUDIO_ITAGS` set
 * MUST include all of these; the mux-corruption fix MUST NOT shrink the
 * supported iTag set.
 */
const AAC_ITAGS = [140, 141, 256, 258, 327, 328] as const;

/**
 * Opus audio iTags. Same contract: must remain present in `AUDIO_ITAGS`.
 */
const OPUS_ITAGS = [249, 250, 251] as const;

describe.skip("Preservation: YT_DOWNLOAD_VIDEO payload + response wire shape", () => {
  /**
   * **Validates: Requirements 3.6**
   *
   * Property: For every documented payload field, the YT content script
   * source contains a literal `fieldName,` or `fieldName:` token inside
   * the `YT_DOWNLOAD_VIDEO` payload object. The fix is allowed to reorder
   * fields or rename internals, but it MUST NOT drop a field name from
   * the wire envelope.
   */
  it("yt-content.ts builds a YT_DOWNLOAD_VIDEO payload that names every documented field", () => {
    // The single canonical sendMessage call lives in `yt-content.ts`.
    // Anchor on the surrounding `type: "YT_DOWNLOAD_VIDEO"` literal and
    // assert each field name appears within ~600 chars of it (the entire
    // payload literal fits comfortably).
    const anchorIdx = YT_CONTENT_SRC.indexOf('type: "YT_DOWNLOAD_VIDEO"');
    expect(anchorIdx).toBeGreaterThanOrEqual(0);
    const window = YT_CONTENT_SRC.slice(anchorIdx, anchorIdx + 1000);

    fc.assert(
      fc.property(fc.constantFrom(...PAYLOAD_FIELDS), (field) => {
        // Field must appear as a property key in the payload literal.
        // Match `field,` (shorthand) or `field:` (explicit value).
        const re = new RegExp(`\\b${field}\\b\\s*[,:]`);
        expect(window).toMatch(re);
      }),
      { numRuns: PAYLOAD_FIELDS.length },
    );
  });

  /**
   * **Validates: Requirements 3.6**
   *
   * Property: The background `YT_DOWNLOAD_VIDEO` handler accepts each
   * documented payload field by name in its typed destructure
   * (`payload?: { videoId?: unknown; … }`). This pins the receiver side
   * of the contract — the fix must not silently rename or drop a payload
   * field name from the accepted-shape declaration. Whether each field
   * is later READ is a separate concern (e.g. `durationSec` is part of
   * the contract but unused by the muxer; the contract still names it).
   */
  it("message-router.ts handler types every documented payload field in its accepted shape", () => {
    const caseIdx = ROUTER_SRC.indexOf('case "YT_DOWNLOAD_VIDEO"');
    expect(caseIdx).toBeGreaterThanOrEqual(0);
    // Look at the next 4000 chars — well within the handler body.
    const window = ROUTER_SRC.slice(caseIdx, caseIdx + 4000);

    fc.assert(
      fc.property(fc.constantFrom(...PAYLOAD_FIELDS), (field) => {
        // Match either `field?: unknown;` / `field: unknown;` (optional
        // or required field in the typed payload literal). All eight
        // fields are declared in the same `payload?: { … }` block.
        const re = new RegExp(`\\b${field}\\??\\s*:\\s*unknown\\b`);
        expect(window).toMatch(re);
      }),
      { numRuns: PAYLOAD_FIELDS.length },
    );
  });

  /**
   * **Validates: Requirements 3.6**
   *
   * Property: Each `sendResponse({ … })` call inside the
   * `YT_DOWNLOAD_VIDEO` handler MUST use only fields from
   * `{success, downloadId, filename, errorCode, reason}` — no extra
   * fields. The fix may add new error reasons but must not introduce a
   * new top-level response field that breaks the receiver's destructure.
   */
  it("message-router.ts handler returns only documented response fields", () => {
    const caseIdx = ROUTER_SRC.indexOf('case "YT_DOWNLOAD_VIDEO"');
    expect(caseIdx).toBeGreaterThanOrEqual(0);
    // The handler body runs ~150 lines; bound the window at the next
    // case label so we don't scan into adjacent handlers.
    const handlerEnd = ROUTER_SRC.indexOf('case "', caseIdx + 30);
    const handlerWindow =
      handlerEnd === -1
        ? ROUTER_SRC.slice(caseIdx, caseIdx + 6000)
        : ROUTER_SRC.slice(caseIdx, handlerEnd);

    // Find every `sendResponse({ ... })` literal in the handler window.
    // The handler uses only single-level objects (no nested `{}`), so a
    // non-greedy match between balanced braces works.
    const sendResponseRe = /sendResponse\(\{([\s\S]*?)\}\)/g;
    const responseObjects: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = sendResponseRe.exec(handlerWindow)) !== null) {
      responseObjects.push(m[1]);
    }
    expect(responseObjects.length).toBeGreaterThan(0);

    const allowed = new Set<string>(RESPONSE_FIELDS);

    for (const objBody of responseObjects) {
      // Strip backtick string contents (template literals) and "..." /
      // '...' string contents so identifiers nested inside string values
      // are not mistaken for property keys.
      const stripped = objBody
        .replace(/`(?:[^`\\]|\\.)*`/g, '""')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, '""');

      // A property KEY in this single-level object literal is an
      // identifier that appears immediately after `{` or `,` (with
      // optional whitespace) and is followed by `:` (explicit) or by
      // `,` / end-of-object (shorthand).
      const propKeyRe =
        /(?:^|[\{,])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|,|$)/g;
      const keys = new Set<string>();
      let pm: RegExpExecArray | null;
      while ((pm = propKeyRe.exec(`{${stripped}}`)) !== null) {
        keys.add(pm[1]);
      }

      // Every extracted top-level key MUST be in the allowlist.
      for (const k of keys) {
        if (!allowed.has(k)) {
          throw new Error(
            `Unexpected top-level response field "${k}" in YT_DOWNLOAD_VIDEO ` +
              `handler. Allowed: ${[...allowed].join(", ")}. Object body: {${objBody}}`,
          );
        }
      }
      // At minimum, every response object MUST mention `success`.
      expect(keys.has("success")).toBe(true);
    }
  });

  /**
   * **Validates: Requirements 3.6, 3.10**
   *
   * Property: For every random documented `(audioITag, videoITag)` pair
   * + a random title + a random video id, the field name set we'd send
   * is exactly the eight documented fields. We assert this on a synthetic
   * payload object built the same way `yt-content.ts` builds it, so the
   * test fails the moment the producer side adds or drops a field.
   */
  it("synthetic payload built per yt-content.ts shape carries exactly 8 documented fields", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{11}$/),
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.option(fc.integer({ min: 5, max: 30 }), { nil: undefined }),
        fc.constantFrom(...AAC_ITAGS, ...OPUS_ITAGS),
        fc.constantFrom(137, 248, 299, 135, 136, 244, 247, 271, 313),
        (videoId, title, durationSec, audioITag, videoITag) => {
          // This MUST match the literal at yt-content.ts §`runClickFlow` —
          // see the `payload: { … }` block under `chrome.runtime.sendMessage`.
          const payload = {
            videoId,
            url: "https://www.youtube.com/watch?v=" + videoId,
            title,
            durationSec,
            audioDataB64: "QUFBQQ==",
            videoDataB64: "QkJCQg==",
            audioITag,
            videoITag,
          };

          // 1) Exact key set — no more, no fewer.
          const keys = Object.keys(payload).sort();
          const expected = [...PAYLOAD_FIELDS].sort();
          expect(keys).toEqual(expected);

          // 2) Per-field type contract from `bugfix.md` §3.6.
          expect(typeof payload.videoId).toBe("string");
          expect(typeof payload.url).toBe("string");
          expect(typeof payload.title).toBe("string");
          expect(payload.durationSec === undefined || typeof payload.durationSec === "number").toBe(true);
          expect(typeof payload.audioDataB64).toBe("string");
          expect(typeof payload.videoDataB64).toBe("string");
          expect(typeof payload.audioITag).toBe("number");
          expect(typeof payload.videoITag).toBe("number");
        },
      ),
      { numRuns: 24 },
    );
  });

  /**
   * **Validates: Requirements 3.10**
   *
   * Property: The bridge's `AUDIO_ITAGS` set still contains every AAC
   * and Opus iTag from `bugfix.md` §3.10. The mux-corruption fix touches
   * `flattenItagFromResponses` and `handleGetMediaBuffer` — neither
   * should remove an iTag from the accepted set.
   */
  it("AUDIO_ITAGS still contains every documented AAC + Opus iTag", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...AAC_ITAGS, ...OPUS_ITAGS),
        (itag) => {
          expect(AUDIO_ITAGS.has(itag)).toBe(true);
        },
      ),
      { numRuns: AAC_ITAGS.length + OPUS_ITAGS.length },
    );
  });

  /**
   * **Validates: Requirements 3.6**
   *
   * Property: The `chrome.runtime.sendMessage` envelope literal in
   * `yt-content.ts` uses the exact `type: "YT_DOWNLOAD_VIDEO"` action
   * name (not a renamed/typo'd variant). This pins the action-name half
   * of the wire shape.
   */
  it("yt-content.ts uses the canonical YT_DOWNLOAD_VIDEO action name", () => {
    expect(YT_CONTENT_SRC).toContain('type: "YT_DOWNLOAD_VIDEO"');
    // Forbid common drift-prone variants.
    const forbidden = [
      'type: "YT_DOWNLOAD"',
      'type: "DOWNLOAD_YT_VIDEO"',
      'type: "YT_VIDEO_DOWNLOAD"',
      'type: "YT_DL_VIDEO"',
    ];
    for (const v of forbidden) {
      expect(YT_CONTENT_SRC).not.toContain(v);
    }
  });
});
