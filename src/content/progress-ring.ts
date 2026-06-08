/**
 * Shared progress-ring helper for download buttons (Yandex Music, YouTube).
 *
 * Renders a thin SVG ring as an absolute-positioned overlay on the
 * button. Uses two circles: a faint background ring and a stroked arc
 * driven by `stroke-dasharray` to fill clockwise from the top. Inside
 * the ring sits a percent label.
 *
 * Yandex Music's download pipeline emits real byte-level progress for
 * the audio fetch (≈30–50% of total time), but the rest — resolve,
 * tag write, FLAC re-encode — has no observable progress. To keep the
 * ring smooth we always run a pseudo-timer underneath; `setReal` only
 * pushes the bar UPWARDS. The displayed percentage is `max(pseudo, real)`
 * so it never moves backward and never freezes.
 *
 * Accent color is controlled via two CSS variables:
 *   --ymd-ring-fg  → arc + percent text color (default `#ffff00`)
 *   --ymd-ring-bg  → faint background ring color (default `rgba(255, 255, 0, 0.18)`)
 * Pass `{ accent }` to `startProgressRing` to override per-button (e.g.
 * `#ff0000` for YouTube). Callers without options keep the default yellow.
 */

const RING_BG_COLOR_DEFAULT = "rgba(255, 255, 0, 0.18)";
const RING_FG_COLOR_DEFAULT = "#ffff00";
/** SVG viewBox is 36×36; circle radius 16 → circumference ≈ 100.5. We use
 *  100 so 1% maps to 1 unit of stroke-dasharray for clean math. */
const RING_RADIUS = 16;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const PSEUDO_TICK_MS = 80;
const PSEUDO_MAX_PCT = 97;
const PSEUDO_HALF_LIFE_MS = 700;
const PSEUDO_MAX_DURATION_MS = 60_000;

let stylesInjected = false;

export function injectProgressRingStyles(): void {
  if (stylesInjected) return;
  if (document.getElementById("ymd-progress-ring-styles") !== null) {
    stylesInjected = true;
    return;
  }
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "ymd-progress-ring-styles";
  style.textContent = `
    .ymd-progress-ring {
      position: relative;
    }
    /* SVG overlay sits on top of everything except the percent text.
     * Width/height match the button so the ring outline scales cleanly. */
    .ymd-ring-svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 1;
      display: none;
    }
    .ymd-progress-ring[data-ymd-state="loading"] .ymd-ring-svg {
      display: block;
    }
    .ymd-ring-bg {
      fill: none;
      stroke: var(--ymd-ring-bg, ${RING_BG_COLOR_DEFAULT});
      stroke-width: 2.5;
    }
    .ymd-ring-fg {
      fill: none;
      stroke: var(--ymd-ring-fg, ${RING_FG_COLOR_DEFAULT});
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-dasharray: ${RING_CIRCUMFERENCE.toFixed(2)};
      transform: rotate(-90deg);
      transform-origin: 50% 50%;
      transition: stroke-dashoffset 0.15s linear;
    }
    /* Hide the existing icon while loading; show percent in its place. */
    .ymd-progress-ring[data-ymd-state="loading"] > span:not(.ymd-pct-text):not(.ymd-ring-svg) {
      visibility: hidden;
    }
    .ymd-pct-text {
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 700;
      font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1;
      letter-spacing: -0.3px;
      color: var(--ymd-ring-fg, ${RING_FG_COLOR_DEFAULT});
      pointer-events: none;
      z-index: 2;
    }
    .ymd-progress-ring[data-ymd-state="loading"] .ymd-pct-text {
      display: flex;
    }
  `;
  document.head.appendChild(style);
}

export interface ProgressRingHandle {
  /** Snap to 100% and freeze. */
  complete: () => void;
  /** Hide the ring and clear timers. Use on error or cancel. */
  abort: () => void;
  /** Push the ring UP toward `percent` (real byte-level progress).
   *  Acts as a floor: each tick uses max(pseudo_curve, realFloor). */
  setReal: (percent: number) => void;
}

/**
 * Optional configuration for `startProgressRing`. Callers that pass no
 * options inherit the default yellow accent (`#ffff00`) used by Yandex
 * Music. YouTube passes `{ accent: "#ff0000" }` for a red ring.
 */
export interface ProgressRingOptions {
  /** Accent color for the foreground arc and percent text. The faint
   *  background ring is rendered as `accent + "22"` (≈13% alpha) so the
   *  caller only specifies one color. Accepts any CSS color string that
   *  also produces a valid value when suffixed with `22` for the
   *  background variant — typically a 6-digit hex like `#ff0000`. */
  accent?: string;
}

const handlesByButton = new WeakMap<HTMLElement, ProgressRingHandle>();

export function startProgressRing(
  btn: HTMLElement,
  opts?: ProgressRingOptions,
): ProgressRingHandle {
  injectProgressRingStyles();
  btn.classList.add("ymd-progress-ring");
  btn.setAttribute("data-ymd-state", "loading");

  // Apply per-button accent override via inline CSS variables. The
  // injected stylesheet reads `var(--ymd-ring-fg, #ffff00)` so callers
  // that pass no `opts` inherit the yellow default — backward compatible
  // with every existing Yandex Music caller.
  if (opts !== undefined && typeof opts.accent === "string" && opts.accent.length > 0) {
    btn.style.setProperty("--ymd-ring-fg", opts.accent);
    btn.style.setProperty("--ymd-ring-bg", `${opts.accent}22`);
  }

  // Build the SVG ring once per button. If it's already there from a
  // previous loading cycle, just reset the foreground arc and reuse.
  let svg = btn.querySelector<SVGSVGElement>(".ymd-ring-svg");
  let fg: SVGCircleElement | null;
  if (svg === null) {
    const SVG_NS = "http://www.w3.org/2000/svg";
    svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ymd-ring-svg");
    svg.setAttribute("viewBox", "0 0 36 36");
    const bg = document.createElementNS(SVG_NS, "circle");
    bg.setAttribute("class", "ymd-ring-bg");
    bg.setAttribute("cx", "18");
    bg.setAttribute("cy", "18");
    bg.setAttribute("r", String(RING_RADIUS));
    svg.appendChild(bg);
    fg = document.createElementNS(SVG_NS, "circle");
    fg.setAttribute("class", "ymd-ring-fg");
    fg.setAttribute("cx", "18");
    fg.setAttribute("cy", "18");
    fg.setAttribute("r", String(RING_RADIUS));
    fg.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE));
    svg.appendChild(fg);
    btn.appendChild(svg);
  } else {
    fg = svg.querySelector<SVGCircleElement>(".ymd-ring-fg");
  }
  // Reset to 0% so a re-entrant loading cycle doesn't start from the
  // last value of the previous one.
  if (fg !== null) {
    fg.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE));
  }

  let pctEl = btn.querySelector<HTMLElement>(".ymd-pct-text");
  if (pctEl === null) {
    pctEl = document.createElement("span");
    pctEl.className = "ymd-pct-text";
    btn.appendChild(pctEl);
  }
  pctEl.textContent = "0%";

  const start = performance.now();
  let stopped = false;
  let timer: number | null = null;
  let realFloor = 0;

  const setPct = (pct: number): void => {
    if (fg !== null) {
      const dashOffset = RING_CIRCUMFERENCE * (1 - pct / 100);
      fg.setAttribute("stroke-dashoffset", dashOffset.toFixed(2));
    }
    if (pctEl !== null) pctEl.textContent = `${pct}%`;
  };

  const tick = (): void => {
    if (stopped) return;
    const elapsed = performance.now() - start;
    if (elapsed > PSEUDO_MAX_DURATION_MS) return;
    const tau = PSEUDO_HALF_LIFE_MS / Math.LN2;
    const eased = 1 - Math.exp(-elapsed / tau);
    const pseudoPct = Math.round(eased * PSEUDO_MAX_PCT);
    setPct(Math.max(pseudoPct, realFloor));
    timer = window.setTimeout(tick, PSEUDO_TICK_MS);
  };
  tick();

  const stop = (): void => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const handle: ProgressRingHandle = {
    complete: () => {
      stop();
      setPct(100);
      handlesByButton.delete(btn);
    },
    abort: () => {
      stop();
      btn.removeAttribute("data-ymd-state");
      if (svg !== null) svg.remove();
      if (pctEl !== null) pctEl.remove();
      // Drop any inline accent overrides so the next cycle starts clean.
      btn.style.removeProperty("--ymd-ring-fg");
      btn.style.removeProperty("--ymd-ring-bg");
      handlesByButton.delete(btn);
    },
    setReal: (percent: number) => {
      const requested = Math.max(0, Math.min(99, Math.round(percent)));
      if (requested > realFloor) realFloor = requested;
    },
  };
  handlesByButton.set(btn, handle);
  return handle;
}

export function clearProgressRing(btn: HTMLElement): void {
  btn.removeAttribute("data-ymd-state");
  const svg = btn.querySelector<SVGSVGElement>(".ymd-ring-svg");
  if (svg !== null) svg.remove();
  const pctEl = btn.querySelector<HTMLElement>(".ymd-pct-text");
  if (pctEl !== null) pctEl.remove();
  // Strip per-button accent overrides set by `startProgressRing(btn, { accent })`
  // so a subsequent re-injection without `opts` falls back to the
  // stylesheet defaults instead of leaking the previous accent.
  btn.style.removeProperty("--ymd-ring-fg");
  btn.style.removeProperty("--ymd-ring-bg");
}

export function setProgressRingPct(btn: HTMLElement, percent: number): void {
  const handle = handlesByButton.get(btn);
  if (handle === undefined) return;
  handle.setReal(percent);
}
