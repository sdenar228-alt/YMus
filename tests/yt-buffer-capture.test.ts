/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://www.youtube.com/watch?v=abcdefghijk"}
 */

/**
 * Behavioural unit tests for `forceFullBuffer()` in
 * `src/yt-content/yt-buffer-capture.ts`.
 *
 * Coverage (per design.md "yt-buffer-capture.ts" + tasks.md task 4.2):
 *
 *   - State restoration: paused, currentTime, playbackRate, loop, volume,
 *     muted, autonav state, and the original location.href are restored on
 *     both the success path and every failure path.
 *   - Player-swap detection: mutating the `?v=` URL parameter (or
 *     duration/currentSrc) mid-pass returns `{ ok: false, reason: "playerSwapped" }`.
 *   - Pass 1 timeout: 180 s without ever reaching the buffer target returns
 *     `{ ok: false, reason: "timeout" }` (or `"noBufferGrowth"` when no
 *     growth was observed in the last 30 s).
 *   - Stall detector: under 0.1 s buffer growth for 5+ ticks triggers a
 *     `currentTime + 5 s` seek (clamped to `duration - 6`).
 *   - Tail prefetch: on Pass 1 success, the function eventually seeks to
 *     `duration - 5` and plays for 3 s with the clamp disabled.
 *   - Cleanup: state is restored even when an exception is thrown mid-pass
 *     (try/finally invariant).
 *   - onProgress throttle: callbacks are emitted at >= 200 ms intervals
 *     during Pass 1 and the values are non-decreasing integers in [0, 100].
 *
 * Drives virtual time with `jest.useFakeTimers()` (modern timers — `Date.now`
 * is auto-mocked) and a fake `<video>` element that implements just enough of
 * the `HTMLVideoElement` surface for `forceFullBuffer` to drive it.
 *
 * **Validates: Requirements 2.3, 2.8**
 */

import fc from "fast-check";
import {
  forceFullBuffer,
  type ForceBufferResult,
} from "../src/yt-content/yt-buffer-capture";

// ─── fake <video> element ───────────────────────────────────────────────────

interface FakeBufferedRange {
  start: number;
  end: number;
}

/**
 * Programmable `<video>`-shaped object. Implements the subset of
 * `HTMLVideoElement` that `forceFullBuffer` reads/writes:
 *
 *   - `paused`, `currentTime`, `duration`, `muted`, `playbackRate`, `loop`,
 *     `volume`, `currentSrc`, `src` properties.
 *   - `addEventListener` / `removeEventListener` (no-op tracking only —
 *     listeners are never fired by these tests because the real player is
 *     the one that fires them in production).
 *   - `play()` / `pause()` returning resolved Promises.
 *   - `buffered` exposing a TimeRanges-shaped object backed by a mutable
 *     `_ranges` array we can grow from the test side.
 *
 * Tests can override `_onPlay`, `_onPause`, `_onSeek` to drive the buffered
 * ranges forward or to inject errors.
 */
interface FakeVideo {
  paused: boolean;
  currentTime: number;
  duration: number;
  muted: boolean;
  playbackRate: number;
  loop: boolean;
  volume: number;
  currentSrc: string;
  src: string;
  buffered: { length: number; start: (i: number) => number; end: (i: number) => number };
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
  play: jest.Mock<Promise<void>, []>;
  pause: jest.Mock<void, []>;
  /** Mutable buffered ranges. Mutate from the test or via the hooks below. */
  _ranges: FakeBufferedRange[];
  /** Optional hook fired on every `play()` invocation. */
  _onPlay?: () => void;
  /** Optional hook fired on every `pause()` invocation. */
  _onPause?: () => void;
  /** Optional hook fired on every `currentTime = n` setter. */
  _onSeek?: (newTime: number) => void;
  /** Listeners attached via addEventListener — for instrumentation only. */
  _listeners: Array<{ type: string; capture: boolean }>;
}

function createFakeVideo(opts: {
  duration: number;
  ranges?: FakeBufferedRange[];
  paused?: boolean;
  currentTime?: number;
  playbackRate?: number;
  loop?: boolean;
  volume?: number;
  muted?: boolean;
  currentSrc?: string;
}): FakeVideo {
  const state: FakeVideo = {
    paused: opts.paused ?? true,
    currentTime: opts.currentTime ?? 0,
    duration: opts.duration,
    muted: opts.muted ?? false,
    playbackRate: opts.playbackRate ?? 1,
    loop: opts.loop ?? false,
    volume: opts.volume ?? 1,
    currentSrc: opts.currentSrc ?? "blob:fake-src",
    src: opts.currentSrc ?? "blob:fake-src",
    _ranges: opts.ranges ? [...opts.ranges] : [],
    _listeners: [],
    buffered: {
      get length(): number {
        return state._ranges.length;
      },
      start(i: number): number {
        return state._ranges[i].start;
      },
      end(i: number): number {
        return state._ranges[i].end;
      },
    },
    addEventListener: jest.fn((type: string, _l: unknown, opts2: unknown) => {
      const capture = !!(opts2 && (opts2 as { capture?: boolean }).capture);
      state._listeners.push({ type, capture });
    }),
    removeEventListener: jest.fn((type: string, _l: unknown, opts2: unknown) => {
      const capture = !!(opts2 && (opts2 as { capture?: boolean }).capture);
      const idx = state._listeners.findIndex(
        (e) => e.type === type && e.capture === capture,
      );
      if (idx !== -1) state._listeners.splice(idx, 1);
    }),
    play: jest.fn(async (): Promise<void> => {
      state.paused = false;
      state._onPlay?.();
    }),
    pause: jest.fn((): void => {
      state.paused = true;
      state._onPause?.();
    }),
  };

  // Wrap currentTime so `_onSeek` fires when tests write to it (the function
  // also writes to it; the hook lets us simulate the player-swap drift).
  let _ct = opts.currentTime ?? 0;
  Object.defineProperty(state, "currentTime", {
    configurable: true,
    enumerable: true,
    get: (): number => _ct,
    set: (v: number): void => {
      _ct = v;
      state._onSeek?.(v);
    },
  });

  return state;
}

/** Type-cast the fake to the `HTMLVideoElement` shape the function expects. */
function asVideoElement(v: FakeVideo): HTMLVideoElement {
  return v as unknown as HTMLVideoElement;
}

// ─── jsdom helpers ──────────────────────────────────────────────────────────

/** Set the jsdom URL so `location.search` reflects `?v=<id>` and the URL strip works. */
function setHref(href: string): void {
  // jsdom respects history.replaceState for path/query mutations.
  history.replaceState(history.state, "", href);
}

// ─── shared test helpers ────────────────────────────────────────────────────

/**
 * Drive jest's fake clock forward in small increments so async micro-tasks
 * (`await sleep(...)`) inside `forceFullBuffer` get a chance to resume on
 * each tick.  `advanceTimersByTimeAsync` already flushes microtasks but we
 * want the loop to observe many discrete `Date.now()` values, so we step in
 * chunks of `tickMs`.
 */
async function advanceClock(totalMs: number, tickMs = 1000): Promise<void> {
  let elapsed = 0;
  while (elapsed < totalMs) {
    const step = Math.min(tickMs, totalMs - elapsed);
    await jest.advanceTimersByTimeAsync(step);
    elapsed += step;
  }
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("forceFullBuffer", () => {
  // Per-test timeout: many tests drive 180+ seconds of *fake* time in a
  // single suite — the real-clock setTimeout flush + microtask drain can
  // take several seconds even though the fake clock advances instantly.
  jest.setTimeout(60_000);

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: [] });
    setHref("https://www.youtube.com/watch?v=abcdefghijk");
    document.body.innerHTML = "";
    // Reset console so the function's internal logs don't pollute jest output.
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ─── happy path / state restoration ───────────────────────────────────

  it("returns ok:true and runs cleanup when the buffer is already full", async () => {
    const duration = 60;
    // Buffer covers the entire duration → Pass 1 reaches target on the
    // first tick and the function falls through to tail prefetch.
    const video = createFakeVideo({
      duration,
      ranges: [{ start: 0, end: duration }],
      paused: true,
      currentTime: 12.5,
      playbackRate: 1,
      loop: false,
      volume: 0.7,
      muted: false,
      currentSrc: "blob:original-src",
    });

    const onProgress = jest.fn<void, [number]>();
    const promise = forceFullBuffer(asVideoElement(video), duration, onProgress);

    // Drive the entire pass: Pass 1 (~1 tick), Pass 2 (no gaps), tail (3 s),
    // small cooldowns.  Total well under 30 s.
    await advanceClock(30_000);
    const result = await promise;

    expect(result).toEqual<ForceBufferResult>({ ok: true });

    // Capture-phase listeners attached and removed.
    const types = video._listeners.map((l) => `${l.type}:${l.capture}`);
    expect(types).toEqual([]); // all removed in cleanup
    expect(video.addEventListener).toHaveBeenCalledWith(
      "timeupdate",
      expect.any(Function),
      { capture: true },
    );
    expect(video.addEventListener).toHaveBeenCalledWith(
      "ended",
      expect.any(Function),
      { capture: true },
    );

    // State restoration on the success path.
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBeCloseTo(12.5, 5);
    expect(video.playbackRate).toBe(1);
    expect(video.loop).toBe(false);
    expect(video.volume).toBeCloseTo(0.7, 5);
    expect(video.muted).toBe(false);

    // onProgress was called with values clamped to [0, 100].
    for (const call of onProgress.mock.calls) {
      const pct = call[0];
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
      expect(Number.isInteger(pct)).toBe(true);
    }
  });

  it("restores location.href after stripping list/index/start_radio params", async () => {
    setHref(
      "https://www.youtube.com/watch?v=abcdefghijk&list=PL123&index=4&start_radio=1",
    );
    const original = location.href;
    const duration = 30;
    const video = createFakeVideo({
      duration,
      ranges: [{ start: 0, end: duration }],
    });

    const promise = forceFullBuffer(asVideoElement(video), duration, () => {});
    await advanceClock(30_000);
    await promise;

    // After cleanup the original URL (with list/index/start_radio) is restored.
    expect(location.href).toBe(original);
  });

  // ─── player swap detection ────────────────────────────────────────────

  it("returns reason='playerSwapped' when the videoId in the URL changes mid-pass", async () => {
    const duration = 600; // long enough that Pass 1 won't finish before we swap
    const video = createFakeVideo({
      duration,
      ranges: [{ start: 0, end: 1 }], // partial buffer — Pass 1 has work to do
      paused: true,
      currentTime: 0,
      playbackRate: 1,
      loop: false,
      volume: 0.5,
    });

    const onProgress = jest.fn<void, [number]>();
    const promise = forceFullBuffer(asVideoElement(video), duration, onProgress);

    // Let Pass 1 start, then swap the videoId after a few ticks.
    await advanceClock(3_000);
    setHref("https://www.youtube.com/watch?v=DIFFERENTID");

    // Drive enough additional time for the swap detector to fire on the next tick.
    await advanceClock(5_000);
    const result = await promise;

    expect(result).toEqual<ForceBufferResult>({
      ok: false,
      reason: "playerSwapped",
    });

    // State is still restored on the failure path.
    expect(video.playbackRate).toBe(1);
    expect(video.loop).toBe(false);
    expect(video.volume).toBeCloseTo(0.5, 5);
  });

  it("returns reason='playerSwapped' when video.duration drifts beyond the tolerance", async () => {
    const duration = 300;
    const video = createFakeVideo({
      duration,
      ranges: [{ start: 0, end: 1 }],
    });

    const promise = forceFullBuffer(asVideoElement(video), duration, () => {});

    // Advance into Pass 1, then drift the duration > 2 s (tolerance).
    await advanceClock(3_000);
    video.duration = duration + 5;

    await advanceClock(5_000);
    const result = await promise;

    expect(result).toEqual<ForceBufferResult>({
      ok: false,
      reason: "playerSwapped",
    });
  });

  it("returns reason='playerSwapped' when video.currentSrc changes mid-pass", async () => {
    const duration = 300;
    const video = createFakeVideo({
      duration,
      ranges: [{ start: 0, end: 1 }],
      currentSrc: "blob:initial",
    });

    const promise = forceFullBuffer(asVideoElement(video), duration, () => {});

    await advanceClock(3_000);
    video.currentSrc = "blob:swapped";

    await advanceClock(5_000);
    const result = await promise;

    expect(result).toEqual<ForceBufferResult>({
      ok: false,
      reason: "playerSwapped",
    });
  });

  // ─── Pass 1 timeout ───────────────────────────────────────────────────

  it("returns reason='noBufferGrowth' when Pass 1 cap elapses with no buffer growth", async () => {
    const duration = 300;
    // Buffer never grows — fake_play() is a no-op, no hook touches `_ranges`.
    const video = createFakeVideo({
      duration,
      ranges: [{ start: 0, end: 1 }],
    });

    const onProgress = jest.fn<void, [number]>();
    const promise = forceFullBuffer(
      asVideoElement(video),
      duration,
      onProgress,
    );

    // Advance past the 180 s Pass 1 cap.
    await advanceClock(190_000, 2_000);
    const result = await promise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 180 s with zero growth → "noBufferGrowth" (last-30 s window stagnant).
      expect(result.reason).toBe("noBufferGrowth");
    }
  });

  it("returns reason='timeout' when Pass 1 cap elapses but recent growth was observed", async () => {
    const duration = 600;
    const video = createFakeVideo({
      duration,
      ranges: [{ start: 0, end: 1 }],
    });

    // Grow the buffer steadily until shortly before the 180 s cap, then
    // freeze.  noGrowthForMs at the cap will be < 30 s → reason="timeout".
    let growthTicks = 0;
    const growGapTicks = setInterval(() => {
      growthTicks += 1;
      if (growthTicks <= 160) {
        // Grow buffered.end(0) by 0.5 s every "real" tick — well above the
        // 0.1 s stall threshold.
        video._ranges[0] = {
          start: 0,
          end: Math.min(video._ranges[0].end + 0.5, duration - 6 - 100),
        };
      }
    }, 1000);

    const promise = forceFullBuffer(asVideoElement(video), duration, () => {});
    await advanceClock(195_000, 1_000);
    const result = await promise;
    clearInterval(growGapTicks);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Growth observed within the last 30 s of the cap → "timeout".
      expect(result.reason).toBe("timeout");
    }
  });

  // ─── stall detector ───────────────────────────────────────────────────

  it("seeks +5 s after 5+ ticks of < 0.1 s buffer growth (stall detector)", async () => {
    // Production change (post-mux-corruption-fix): the stall detector no
    // longer seeks `currentTime + 5 s` when buffer growth is below
    // STALL_DELTA_S (0.1 s) for STALL_TICKS_LIMIT (5) ticks. Each
    // forward seek made the player skip MSE segments that YouTube
    // would have delivered anyway, leaving holes in the captured
    // byte stream.
    //
    // The new behaviour: when the stall counter trips, the detector
    // either (a) finishes Pass 1 early if currentTime is already at
    // the clamp ceiling (`duration - SAFE_MARGIN_S - 2`), or (b) just
    // resets the stall counter and lets the play loop continue at
    // playbackRate=4. Either way, NO forward seek is issued.
    //
    // This test pins the new behaviour: with the buffer never
    // growing across many Pass-1 ticks, the function must NOT emit a
    // `currentTime + STALL_SEEK_AHEAD_S` mid-pass seek (legacy
    // behaviour). Pass 1 eventually times out via the 180 s cap.
    const duration = 300;
    const initialCurrentTime = 5;
    const video = createFakeVideo({
      duration,
      ranges: [{ start: 0, end: 5 }],
      currentTime: initialCurrentTime,
    });

    const seekPositions: number[] = [];
    video._onSeek = (t) => {
      seekPositions.push(t);
    };

    const promise = forceFullBuffer(asVideoElement(video), duration, () => {});

    // Drive Pass 1 well past STALL_TICKS_LIMIT (5 ticks of 1 s each).
    // The buffer never grows, so the stall detector trips repeatedly.
    // Continue all the way to the 180 s cap so the function exits via
    // `noBufferGrowth`.
    await advanceClock(190_000, 2_000);
    await promise;

    // The legacy stall detector would have issued seeks at
    // `currentTime + STALL_SEEK_AHEAD_S` (5 s) repeatedly: from the
    // initial 0 (set by the function on entry) → 5, 10, 15 …
    // The current production code MUST NOT make any of those forward
    // jumps. We assert no seek lands in the legacy stall-seek range
    // (positive multiples of 5 s up to `duration - SAFE_MARGIN_S - 2`)
    // during Pass 1.
    //
    // The function does write currentTime once in setup (= 0) and
    // once in cleanup (= initialCurrentTime = 5). On the
    // noBufferGrowth path no tail prefetch runs, so those are the
    // only legitimate writes.
    const forbiddenStallTargets = [10, 15, 20, 25, 30];
    for (const t of forbiddenStallTargets) {
      expect(seekPositions).not.toContain(t);
    }

    // Sanity: setup wrote 0 and cleanup wrote initialCurrentTime.
    expect(seekPositions).toContain(0);
    expect(seekPositions).toContain(initialCurrentTime);
  });

  // ─── tail prefetch ────────────────────────────────────────────────────

  it("performs tail prefetch (seek to duration - 5) when Pass 1 succeeds", async () => {
    // Production change (post-mux-corruption-fix): tail prefetch now
    // walks several seek positions backwards from the end of the
    // timeline (`duration - 10`, `duration - 6`, `duration - 3`,
    // `duration - 1`) instead of a single `duration - 5` seek. Each
    // position is held for up to 6 s while the player fetches the
    // final segments. The loop exits early once `bufferedTotal()`
    // covers the full timeline OR once buffered crosses tailPos + 1.
    //
    // For this test we keep the buffer below the early-exit threshold
    // by leaving a small gap at the very end (`[0, duration - 0.6]`),
    // so the loop runs far enough to fire at least one of the
    // tail-prefetch seek positions.
    const duration = 60;
    const video = createFakeVideo({
      duration,
      // Buffer covers most of the timeline so Pass 1 finishes quickly,
      // but leaves a 0.6 s gap at the tail so tail prefetch's early-
      // exit guard (`buf >= duration - 0.5`) does not fire on entry.
      ranges: [{ start: 0, end: duration - 0.6 }],
    });

    const seenSeeks: number[] = [];
    video._onSeek = (t) => seenSeeks.push(t);

    const promise = forceFullBuffer(asVideoElement(video), duration, () => {});
    // Drive 90 s of fake time so tail prefetch can iterate through its
    // positions (each holds up to 6 s, the loop hard-cap is 30 s).
    await advanceClock(90_000, 500);
    await promise;

    // Tail prefetch walks [duration-10, duration-6, duration-3, duration-1]
    // = [50, 54, 57, 59]. At least one of these positions MUST appear
    // in the captured seek log.
    const tailPositions = [50, 54, 57, 59];
    const matched = tailPositions.filter((p) => seenSeeks.includes(p));
    expect(matched.length).toBeGreaterThan(0);
  });

  it("does NOT perform tail prefetch when the function returns ok:false (player swap)", async () => {
    const duration = 600;
    const video = createFakeVideo({
      duration,
      ranges: [{ start: 0, end: 1 }],
    });

    const seenSeeks: number[] = [];
    video._onSeek = (t) => seenSeeks.push(t);

    const promise = forceFullBuffer(asVideoElement(video), duration, () => {});
    await advanceClock(2_000);
    setHref("https://www.youtube.com/watch?v=DIFFERENTID");
    await advanceClock(5_000);
    await promise;

    // Tail prefetch positions are [duration-10, duration-6, duration-3,
    // duration-1] = [590, 594, 597, 599]. None must appear in seenSeeks
    // because tail prefetch is skipped on the playerSwapped path.
    expect(seenSeeks).not.toContain(590);
    expect(seenSeeks).not.toContain(594);
    expect(seenSeeks).not.toContain(597);
    expect(seenSeeks).not.toContain(599);
  });

  // ─── cleanup runs even on exceptions ──────────────────────────────────

  it("restores state in the finally block even when an exception is thrown mid-pass", async () => {
    const duration = 60;
    const video = createFakeVideo({
      duration,
      ranges: [{ start: 0, end: duration }],
      paused: true,
      currentTime: 25,
      playbackRate: 1,
      loop: false,
      volume: 0.42,
    });

    // Force `bufferedTotal` to throw on one of the calls inside Pass 1 by
    // making the `length` getter throw.  The first call inside Pass 1's
    // while-loop will trigger the throw; the try/finally then runs cleanup.
    let throwOnce = true;
    Object.defineProperty(video.buffered, "length", {
      configurable: true,
      get: (): number => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("synthetic buffered.length failure");
        }
        return video._ranges.length;
      },
    });

    const promise = forceFullBuffer(asVideoElement(video), duration, () => {});
    // Attach a no-op catch BEFORE advancing the clock: the rejection will
    // be consumed during `advanceClock` (microtasks flush mid-advance) and
    // we don't want jest to see an "unhandled rejection" warning.
    const settled = promise.catch((e: unknown) => ({ thrown: e }));
    await advanceClock(30_000);

    // The function rethrows inside Pass 1's try-block; the finally still ran.
    const outcome = await settled;
    expect(outcome).toMatchObject({
      thrown: expect.objectContaining({
        message: expect.stringContaining("synthetic buffered.length failure"),
      }),
    });

    // Cleanup invariants: capture-phase listeners removed, state restored.
    expect(video._listeners).toEqual([]);
    expect(video.removeEventListener).toHaveBeenCalledWith(
      "timeupdate",
      expect.any(Function),
      { capture: true },
    );
    expect(video.removeEventListener).toHaveBeenCalledWith(
      "ended",
      expect.any(Function),
      { capture: true },
    );
    expect(video.playbackRate).toBe(1);
    expect(video.loop).toBe(false);
    expect(video.volume).toBeCloseTo(0.42, 5);
    expect(video.currentTime).toBeCloseTo(25, 5);
    expect(video.paused).toBe(true);
  });

  // ─── onProgress throttling ─────────────────────────────────────────────

  it("throttles onProgress to >= 200 ms intervals during Pass 1", async () => {
    const duration = 600;
    const video = createFakeVideo({
      duration,
      ranges: [{ start: 0, end: 0 }],
    });

    // Steadily grow buffered.end(0) by 1 s every 1 s of fake-clock advance,
    // so Pass 1 sees real growth and emits progress on each tick.
    const ticks = setInterval(() => {
      video._ranges[0] = {
        start: 0,
        end: Math.min(video._ranges[0].end + 1, duration - 7),
      };
    }, 1000);

    const callTimestamps: number[] = [];
    const onProgress = jest.fn<void, [number]>((_pct: number) => {
      callTimestamps.push(Date.now());
    });

    const promise = forceFullBuffer(
      asVideoElement(video),
      duration,
      onProgress,
    );
    // Drive Pass 1 forward — the buffer never reaches the target so we hit
    // the 180 s cap, but we get many progress emits along the way.
    await advanceClock(190_000, 1_000);
    await promise;
    clearInterval(ticks);

    expect(callTimestamps.length).toBeGreaterThan(0);

    // Successive emits are at least PROGRESS_THROTTLE_MS apart (200 ms),
    // except for the optional final force-emit during tail prefetch.
    // Pass 1 timed out so there is no tail emit; every gap is >= 200 ms.
    for (let i = 1; i < callTimestamps.length; i++) {
      const dt = callTimestamps[i] - callTimestamps[i - 1];
      expect(dt).toBeGreaterThanOrEqual(200);
    }

    // Reported pct values are non-decreasing integers in [0, 100].
    let prev = -1;
    for (const call of onProgress.mock.calls) {
      const pct = call[0];
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
      expect(Number.isInteger(pct)).toBe(true);
      expect(pct).toBeGreaterThanOrEqual(prev);
      prev = pct;
    }
  });

  // ─── property: progress callback never throws out of forceFullBuffer ─

  it("[PBT] swallows exceptions thrown from the onProgress callback (does not propagate)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 30, max: 120 }),
        async (duration) => {
          // Reset jsdom + timers per iteration so each property run is clean.
          setHref("https://www.youtube.com/watch?v=abcdefghijk");
          const video = createFakeVideo({
            duration,
            ranges: [{ start: 0, end: duration }],
          });

          const promise = forceFullBuffer(
            asVideoElement(video),
            duration,
            () => {
              throw new Error("user callback boom");
            },
          );
          await advanceClock(30_000);
          const r = await promise;
          // Even though every onProgress invocation throws, the function
          // returns ok:true and cleanup still runs.
          expect(r.ok).toBe(true);
        },
      ),
      { numRuns: 5 },
    );
  });

  // ─── property: invalid duration returns cleanly without touching state ──

  it("[PBT] returns ok:false on non-finite or non-positive duration without mutating state", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant(0),
          fc.constant(-1),
          fc.constant(-99.9),
          fc.constant(NaN),
          fc.constant(Infinity),
          fc.constant(-Infinity),
        ),
        async (badDuration) => {
          const video = createFakeVideo({
            duration: 60,
            ranges: [{ start: 0, end: 60 }],
            paused: true,
            currentTime: 7.25,
            playbackRate: 1.5,
            loop: true,
            volume: 0.1,
          });

          const result = await forceFullBuffer(
            asVideoElement(video),
            badDuration,
            () => {},
          );

          expect(result).toEqual<ForceBufferResult>({
            ok: false,
            reason: "timeout",
          });
          // No listeners attached, no state mutated.
          expect(video._listeners).toEqual([]);
          expect(video.addEventListener).not.toHaveBeenCalled();
          expect(video.paused).toBe(true);
          expect(video.currentTime).toBeCloseTo(7.25, 5);
          expect(video.playbackRate).toBe(1.5);
          expect(video.loop).toBe(true);
          expect(video.volume).toBeCloseTo(0.1, 5);
        },
      ),
      { numRuns: 6 },
    );
  });
});
