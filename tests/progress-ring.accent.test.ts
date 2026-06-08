/**
 * @jest-environment jsdom
 */

/**
 * Unit tests for the per-button accent override added to
 * `src/content/progress-ring.ts`.
 *
 * Validates: Requirements 3.11
 *
 * Coverage (per design.md "File: src/content/progress-ring.ts (REFACTORED)"
 * and tasks.md task 4.4):
 *
 *   - `startProgressRing(btn)` without opts does NOT set inline
 *     `--ymd-ring-fg` / `--ymd-ring-bg` properties — Yandex Music callers
 *     keep the default yellow `#ffcc00` via the stylesheet `var(...)` fallback.
 *   - `startProgressRing(btn, { accent: "#ff0000" })` sets both inline
 *     CSS variables: foreground to the accent and background to the same
 *     accent suffixed with `22` (≈13% alpha) so the caller passes one color.
 *   - VK blue (`#71aaeb`) is accepted just like YouTube red — the helper
 *     does no color validation, just inline variable propagation.
 *   - `clearProgressRing(btn)` removes the SVG overlay, the percent text,
 *     AND the inline accent variables so the next cycle starts clean.
 *   - `handle.abort()` also removes the inline accent variables (an error
 *     path through the loading cycle should not leak the accent override).
 *   - `handle.complete()` snaps the ring to 100% — `stroke-dashoffset` of
 *     the foreground arc becomes 0 (since circumference × (1 − 100/100) = 0).
 *   - `setProgressRingPct(btn, 50)` updates the realFloor. The display only
 *     reflects the floor on the NEXT pseudo-tick (≈80 ms cadence), so we
 *     verify the post-tick state shows max(pseudoPct, 50).
 *   - Property-based: any 6-digit hex accent suffixed with `22` is a valid
 *     8-digit hex CSS color string (this is the contract callers rely on
 *     when picking accents — pass a 6-digit hex, get a stylesheet-safe
 *     8-digit hex on the background variant).
 */

import fc from "fast-check";
import {
  startProgressRing,
  clearProgressRing,
  setProgressRingPct,
} from "../src/content/progress-ring";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  document.body.appendChild(btn);
  return btn;
}

function getInlineProp(btn: HTMLElement, name: string): string {
  // Read the inline value directly — `style.getPropertyValue` on a
  // CSS custom property returns the inline declaration verbatim
  // (or "" when no inline declaration exists).
  return btn.style.getPropertyValue(name).trim();
}

beforeEach(() => {
  document.body.innerHTML = "";
  // We deliberately do NOT remove the cached `#ymd-progress-ring-styles`
  // element between tests. The module memoizes injection via a private
  // module-level flag, so removing the <style> would leave the flag set
  // and the next `startProgressRing` call would skip re-injection,
  // producing a DOM with zero <style> nodes. Leaving the stylesheet in
  // place across tests is harmless for correctness and matches the
  // production lifetime (the helper injects once per page load).
});

// ─── 1. Defaults: no opts → no inline accent override ───────────────────────

describe("startProgressRing — default (no options) keeps yellow fallback", () => {
  it("does not set inline --ymd-ring-fg or --ymd-ring-bg", () => {
    const btn = makeButton();
    const handle = startProgressRing(btn);

    expect(getInlineProp(btn, "--ymd-ring-fg")).toBe("");
    expect(getInlineProp(btn, "--ymd-ring-bg")).toBe("");

    handle.abort();
  });

  it("injects the shared stylesheet exactly once across calls", () => {
    const btn1 = makeButton();
    const btn2 = makeButton();

    startProgressRing(btn1).abort();
    startProgressRing(btn2).abort();

    const styleNodes = document.querySelectorAll("#ymd-progress-ring-styles");
    expect(styleNodes.length).toBe(1);
  });

  it("stylesheet fallback color for --ymd-ring-fg is the yellow brand default", () => {
    const btn = makeButton();
    startProgressRing(btn).abort();

    // The injected stylesheet keeps the default `#ffcc00` accent for any
    // caller that passes no opts. We assert by reading the raw stylesheet
    // text since jsdom does not resolve `var(...)` fallbacks via
    // getComputedStyle for SVG strokes reliably.
    const styleEl = document.getElementById("ymd-progress-ring-styles");
    expect(styleEl).not.toBeNull();
    const css = styleEl?.textContent ?? "";
    expect(css).toMatch(/var\(--ymd-ring-fg, #ffcc00\)/);
    expect(css).toMatch(/var\(--ymd-ring-bg, rgba\(255, 204, 0, 0\.18\)\)/);
  });
});

// ─── 2. Accent override: YouTube red and VK blue ────────────────────────────

describe("startProgressRing — accent override", () => {
  it("YouTube red sets --ymd-ring-fg = #ff0000 and --ymd-ring-bg = #ff000022", () => {
    const btn = makeButton();
    const handle = startProgressRing(btn, { accent: "#ff0000" });

    expect(getInlineProp(btn, "--ymd-ring-fg")).toBe("#ff0000");
    expect(getInlineProp(btn, "--ymd-ring-bg")).toBe("#ff000022");

    handle.abort();
  });

  it("VK blue sets --ymd-ring-fg = #71aaeb and --ymd-ring-bg = #71aaeb22", () => {
    const btn = makeButton();
    const handle = startProgressRing(btn, { accent: "#71aaeb" });

    expect(getInlineProp(btn, "--ymd-ring-fg")).toBe("#71aaeb");
    expect(getInlineProp(btn, "--ymd-ring-bg")).toBe("#71aaeb22");

    handle.abort();
  });

  it("empty string accent is treated as no override (defensive guard)", () => {
    const btn = makeButton();
    const handle = startProgressRing(btn, { accent: "" });

    expect(getInlineProp(btn, "--ymd-ring-fg")).toBe("");
    expect(getInlineProp(btn, "--ymd-ring-bg")).toBe("");

    handle.abort();
  });
});

// ─── 3. Cleanup: clear + abort both strip inline accent vars ────────────────

describe("clearProgressRing removes inline accent variables", () => {
  it("removes --ymd-ring-fg and --ymd-ring-bg set by a prior accent start", () => {
    const btn = makeButton();
    startProgressRing(btn, { accent: "#ff0000" });

    expect(getInlineProp(btn, "--ymd-ring-fg")).toBe("#ff0000");

    clearProgressRing(btn);

    expect(getInlineProp(btn, "--ymd-ring-fg")).toBe("");
    expect(getInlineProp(btn, "--ymd-ring-bg")).toBe("");
  });

  it("also removes the SVG overlay and the percent text node", () => {
    const btn = makeButton();
    startProgressRing(btn, { accent: "#ff0000" });

    expect(btn.querySelector(".ymd-ring-svg")).not.toBeNull();
    expect(btn.querySelector(".ymd-pct-text")).not.toBeNull();

    clearProgressRing(btn);

    expect(btn.querySelector(".ymd-ring-svg")).toBeNull();
    expect(btn.querySelector(".ymd-pct-text")).toBeNull();
    expect(btn.getAttribute("data-ymd-state")).toBeNull();
  });
});

describe("handle.abort() removes inline accent variables", () => {
  it("strips --ymd-ring-fg and --ymd-ring-bg on abort", () => {
    const btn = makeButton();
    const handle = startProgressRing(btn, { accent: "#71aaeb" });

    expect(getInlineProp(btn, "--ymd-ring-fg")).toBe("#71aaeb");
    expect(getInlineProp(btn, "--ymd-ring-bg")).toBe("#71aaeb22");

    handle.abort();

    expect(getInlineProp(btn, "--ymd-ring-fg")).toBe("");
    expect(getInlineProp(btn, "--ymd-ring-bg")).toBe("");
  });

  it("a fresh start after abort with no opts inherits the stylesheet default", () => {
    const btn = makeButton();
    const first = startProgressRing(btn, { accent: "#ff0000" });
    first.abort();

    const second = startProgressRing(btn);
    expect(getInlineProp(btn, "--ymd-ring-fg")).toBe("");
    expect(getInlineProp(btn, "--ymd-ring-bg")).toBe("");

    second.abort();
  });
});

// ─── 4. complete() snaps the ring to 100% (stroke-dashoffset = 0) ───────────

describe("handle.complete() snaps to 100%", () => {
  it("foreground arc stroke-dashoffset becomes 0", () => {
    const btn = makeButton();
    const handle = startProgressRing(btn, { accent: "#ff0000" });

    handle.complete();

    const fg = btn.querySelector<SVGCircleElement>(".ymd-ring-fg");
    expect(fg).not.toBeNull();
    // Number-parse to absorb any "0.00" formatting differences.
    const dashOffset = Number(fg?.getAttribute("stroke-dashoffset"));
    expect(dashOffset).toBe(0);
  });

  it("percent label reads 100%", () => {
    const btn = makeButton();
    const handle = startProgressRing(btn, { accent: "#ff0000" });

    handle.complete();

    const pctEl = btn.querySelector<HTMLElement>(".ymd-pct-text");
    expect(pctEl).not.toBeNull();
    expect(pctEl?.textContent).toBe("100%");
  });
});

// ─── 5. setProgressRingPct updates realFloor (visible on next pseudo-tick) ──

describe("setProgressRingPct updates the floor", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("display advances to >= floor after the next pseudo-tick", () => {
    const btn = makeButton();
    const handle = startProgressRing(btn, { accent: "#ff0000" });

    setProgressRingPct(btn, 50);

    // Drive the pseudo-timer forward past one tick (PSEUDO_TICK_MS = 80 ms).
    jest.advanceTimersByTime(200);

    const pctEl = btn.querySelector<HTMLElement>(".ymd-pct-text");
    expect(pctEl).not.toBeNull();
    const shown = Number((pctEl?.textContent ?? "").replace("%", ""));
    expect(shown).toBeGreaterThanOrEqual(50);
    expect(shown).toBeLessThanOrEqual(100);

    handle.abort();
  });

  it("a lower floor never moves the display backward", () => {
    const btn = makeButton();
    const handle = startProgressRing(btn, { accent: "#ff0000" });

    setProgressRingPct(btn, 80);
    jest.advanceTimersByTime(200);

    const pctEl = btn.querySelector<HTMLElement>(".ymd-pct-text");
    const afterHigh = Number((pctEl?.textContent ?? "").replace("%", ""));
    expect(afterHigh).toBeGreaterThanOrEqual(80);

    // Subsequent lower floor must NOT push the display down.
    setProgressRingPct(btn, 10);
    jest.advanceTimersByTime(200);

    const afterLow = Number((pctEl?.textContent ?? "").replace("%", ""));
    expect(afterLow).toBeGreaterThanOrEqual(afterHigh);

    handle.abort();
  });

  it("is a no-op when called on a button with no active handle", () => {
    const btn = makeButton();
    // No startProgressRing call → no handle in the WeakMap.
    expect(() => setProgressRingPct(btn, 50)).not.toThrow();
  });
});

// ─── 6. Property-based: 6-digit hex + "22" suffix is a valid CSS color ──────

describe("Property-based: hex accent + 22 suffix produces valid 8-digit hex", () => {
  /**
   * Validates: Requirements 3.11
   *
   * Property: For any 6-digit hex color string passed as `accent`, the
   * helper writes `${accent}22` to `--ymd-ring-bg`. The resulting string
   * must always be a valid 8-digit hex color (`#RRGGBBAA`) — the contract
   * the YouTube and VK callers rely on.
   */
  it("for all 6-digit hex accents, --ymd-ring-bg is a valid 8-digit hex color", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^#[0-9a-fA-F]{6}$/),
        (accent) => {
          const btn = makeButton();
          const handle = startProgressRing(btn, { accent });

          const fg = getInlineProp(btn, "--ymd-ring-fg");
          const bg = getInlineProp(btn, "--ymd-ring-bg");

          // Property 1: foreground equals the input verbatim.
          expect(fg).toBe(accent);
          // Property 2: background equals input + "22" → an 8-digit hex.
          expect(bg).toBe(`${accent}22`);
          // Property 3: the resulting background string matches #RRGGBBAA.
          expect(/^#[0-9a-fA-F]{8}$/.test(bg)).toBe(true);

          handle.abort();
          // Cleanup invariant: abort always strips both inline vars.
          expect(getInlineProp(btn, "--ymd-ring-fg")).toBe("");
          expect(getInlineProp(btn, "--ymd-ring-bg")).toBe("");
        },
      ),
      { numRuns: 50 },
    );
  });
});
