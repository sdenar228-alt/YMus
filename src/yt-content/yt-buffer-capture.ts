/**
 * YouTube Buffer Capture — `forceFullBuffer()` extracted from the legacy
 * `YMus-legacy/yt-content.js`. Runs in the isolated content-script world
 * and drives the on-page `<video>` element so YouTube's own player fetches
 * every audio media segment (which `yt-page-bridge.ts` then intercepts in
 * the MAIN world via the `window.fetch` hook).
 *
 * Pure logic — no `chrome.*` calls, no `window.postMessage` to the bridge —
 * easy to unit-test against a fake `<video>` element.
 *
 * Protocol (mirrors the legacy reference verbatim):
 *
 *   1. Snapshot caller state (`paused`, `currentTime`, `muted`,
 *      `playbackRate`, `loop`, `volume`, autonav state) so we can restore
 *      on exit. `volume` is forced to `0` and `muted` is forced to `true`
 *      for the entire pass so the user does not hear scrubbing audio,
 *      regardless of any user-gesture-triggered unmute by the YouTube
 *      player. Both are restored only inside the `finally` block.
 *   2. Install capture-phase `timeupdate` and `ended` listeners that
 *      `stopImmediatePropagation()` and seek back to `max(0, duration - 6)`
 *      whenever `currentTime >= duration - 4`. This overrides YouTube's
 *      own clamp without trying to remove its listeners.
 *   3. Strip `list`, `index`, `start_radio` query params via
 *      `history.replaceState` (so YouTube's autoplay queue can't swap
 *      videos mid-pass) and remember the original `location.href`.
 *   4. Pass 1 — fast playback: `playbackRate` is chosen adaptively from
 *      `qualityHeight`: ≤ 1080 → 16, 1440 (2K) → 4, ≥ 2160 (4K) → 2 (with
 *      a fallback to `2` if the picked rate is rejected). `currentTime
 *      = 0`, `play()`. Loop until coverage ≥ 95 % of `duration` (i.e.
 *      `bufferedTotal() / duration ≥ 0.95`) or 600 s elapse. Stall
 *      detector: if buffer growth stays below 0.1 s for 3 ticks, reset.
 *   5. Pass 2 — gap fill: walk `t = 0, 2, 4, …` collecting unbuffered
 *      points; for the first 200, seek + `play()` + wait up to 8 s for
 *      the buffer to cover `t`, then pause and 100 ms cooldown.
 *   6. Tail prefetch: set `clampDisabled = true`, seek through positions
 *      [duration-10, duration-6, duration-3, duration-1, duration-0.2]
 *      so the player fetches the final 6 s of media, then jump back to
 *      mid-video so the clamp can re-engage cleanly.
 *   7. Cleanup (in `try/finally`): remove capture listeners, restore
 *      `loop`, `playbackRate`, `currentTime`, `paused`, `volume`,
 *      `muted`, autonav state, and original URL.
 *
 * Hard caps: 600 s for Pass 1, 200 × 8 s = 1600 s for Pass 2, 30 s for
 * tail prefetch. In practice Pass 1 finishes in seconds-to-minutes
 * depending on duration and quality; Pass 2 fires zero or a handful of
 * seeks.
 *
 * Validates: Requirements 2.3, 2.8 — the click flow must drive the
 * on-page player to fill `video.buffered` for the entire duration so the
 * MAIN-world `fetch` hook captures every audio segment, and must surface
 * `BUFFER_CAPTURE_FAILED` on terminal failure.
 */

const TAG = "[YMus YT Buffer]";

/**
 * Captured buffer status returned by `forceFullBuffer`.
 *
 * - `ok: true` — buffer is full enough that all audio segments should
 *   have been observed by the page bridge. The caller proceeds to
 *   `GET_MEDIA_BUFFER`.
 * - `ok: false, reason: "playerSwapped"` — YouTube swapped the underlying
 *   `<video>` (autonav, history navigation) mid-pass. State is restored
 *   defensively but the caller should surface
 *   `BUFFER_CAPTURE_FAILED` to the user.
 * - `ok: false, reason: "timeout"` — Pass 1's 600 s cap elapsed before
 *   coverage reached 95 % of `duration`.
 * - `ok: false, reason: "noBufferGrowth"` — Pass 1 timed out AND no
 *   buffer growth was observed in the last ~30 s, suggesting the
 *   video is silently failing to deliver more data (DRM-style edge or
 *   network stall).
 */
export type ForceBufferResult =
  | { ok: true }
  | { ok: false; reason: "playerSwapped" | "timeout" | "noBufferGrowth" };

/** Distance from `duration` (seconds) at which the clamp engages. */
const SAFE_MARGIN_S = 4;
/** When the clamp fires we seek back this far from `duration`. */
const SNAP_BACK_TO_S = 6;

/** Pass 1 hard cap (10 minutes — fits long videos at lower playbackRate). */
const PASS1_TIMEOUT_MS = 600_000;
/** Pass 1 polling interval. */
const PASS1_TICK_MS = 1_000;
/** Pass 1 success threshold expressed as a fraction of `duration`.
 *  Set to 0.999 — we want Pass 1 to keep playing right up to the end of
 *  the timeline so the player issues SABR POSTs for every segment,
 *  including the final 5–10 seconds. Earlier values (0.95) left a tail
 *  gap that downstream gap-fill could not cover because YouTube never
 *  fetched those segments in the first place. */
const PASS1_COVERAGE_TARGET = 0.999;
/** Stall threshold — buffer growth below this for `STALL_TICKS_LIMIT` ticks triggers a seek. */
const STALL_DELTA_S = 0.1;
const STALL_TICKS_LIMIT = 3;
/** Stall detector seek-forward distance. */
const STALL_SEEK_AHEAD_S = 5;
/** "No growth" suspicion window — if Pass 1 timed out and buffer hasn't grown for at least this long, flag `noBufferGrowth`. */
const NO_GROWTH_SUSPICION_MS = 30_000;

/** Pass 2 step (seconds) when scanning for gaps. */
const PASS2_STEP_S = 2;
/** Pass 2 maximum number of gap seeks. */
const MAX_GAP_SEEKS = 200;
/** Pass 2 per-seek wait cap. */
const GAP_WAIT_MS = 8_000;
/** Pass 2 cooldown after each gap seek. */
const GAP_COOLDOWN_MS = 100;

/** Tail prefetch playback duration. */
const TAIL_PREFETCH_MS = 3_000;

/** Progress callback throttle — Pass 1 emits at most every this many ms. */
const PROGRESS_THROTTLE_MS = 200;

/** Player-swap drift tolerance on `video.duration` (seconds). */
const DURATION_DRIFT_TOLERANCE_S = 2;

/**
 * Minimal subset of the YouTube `movie_player` API used here. The real
 * player exposes many more methods; we only declare what we touch.
 */
interface YouTubePlayer {
  getAutonavState?: () => number;
  setAutonavState?: (state: number) => void;
}

/**
 * Drive the page's `<video>` element so YouTube fetches every audio
 * segment for the current videoId. The caller must arrange for
 * `yt-page-bridge.ts` to be intercepting `videoplayback` responses in
 * the MAIN world before invoking this function.
 *
 * @param video        The on-page `<video>` element.
 * @param duration     Authoritative duration (seconds). Must be finite and > 0.
 * @param qualityHeight Selected video height in pixels (e.g. 480, 720,
 *                     1080, 1440, 2160). Used to pick a safe Pass 1
 *                     `playbackRate` — at 2K and 4K the player can't
 *                     keep up with 16x and starts skipping segments.
 *                     Pass `0` or omit-equivalent (`1080`) for the
 *                     default fast path.
 * @param onProgress   Throttled progress callback emitting integer
 *                     percent values 0–100 representing
 *                     `min(100, bufferedTotal() / duration * 100)`.
 */
export async function forceFullBuffer(
  video: HTMLVideoElement,
  duration: number,
  qualityHeight: number,
  onProgress: (pct: number) => void,
): Promise<ForceBufferResult> {
  if (!isFinite(duration) || duration <= 0) {
    // Defensive: caller should have screened live / DRM out, but if a
    // bad duration slips through we return cleanly without touching the
    // element.
    return { ok: false, reason: "timeout" };
  }

  // ---- Snapshot caller state for restoration -----------------------------
  // IMPORTANT: read `volume` and `muted` BEFORE we mutate them below so the
  // `finally` block restores the pre-buffering state, not our forced
  // (volume=0, muted=true) values.
  const wasPaused = video.paused;
  const wasTime = video.currentTime;
  const wasMuted = video.muted;
  const wasRate = video.playbackRate;
  const wasLoop = video.loop;
  const wasVolume = video.volume;

  // ---- Player-swap baseline ---------------------------------------------
  const initialVideoId = readVideoIdFromHref();
  const initialDuration = duration;
  const initialSrc = video.currentSrc || video.src;

  const playerSwapped = (): boolean => {
    const currentVid = readVideoIdFromHref();
    if (currentVid !== initialVideoId) return true;
    if (Math.abs((video.duration || 0) - initialDuration) > DURATION_DRIFT_TOLERANCE_S) return true;
    const currentSrc = video.currentSrc || video.src;
    if (currentSrc && initialSrc && currentSrc !== initialSrc) return true;
    return false;
  };

  // ---- Autonav state -----------------------------------------------------
  let autoplayWasOn = true;
  const player = getMoviePlayer();
  try {
    if (player?.getAutonavState && player.setAutonavState) {
      autoplayWasOn = player.getAutonavState() !== 3;
      if (autoplayWasOn) player.setAutonavState(3);
    }
  } catch {
    // Player API unavailable — proceed without autonav suppression.
  }

  // ---- Loop on while we drive ------------------------------------------
  try {
    video.loop = true;
  } catch {
    // Some embedded players reject `loop = true`; nothing to do.
  }

  // ---- Capture-phase clamp listeners ------------------------------------
  let clampDisabled = false;
  const onTimeUpdate = (e: Event): void => {
    if (clampDisabled) return;
    const dur = video.duration;
    if (!isFinite(dur) || dur <= SNAP_BACK_TO_S) return;
    if (video.currentTime >= dur - SAFE_MARGIN_S) {
      e.stopImmediatePropagation();
      try {
        video.currentTime = Math.max(0, dur - SNAP_BACK_TO_S);
      } catch {
        // Element may be detached mid-pass; cleanup will run.
      }
    }
  };
  const onEnded = (e: Event): void => {
    // Honour `clampDisabled` here too — during the tail-prefetch phase
    // we explicitly want the player to reach `duration` and fetch the
    // final SimpleBlock. Without this guard, `onEnded` would snap back
    // to `duration - SNAP_BACK_TO_S` and the final segments would never
    // be requested.
    if (clampDisabled) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    try {
      video.currentTime = Math.max(0, video.duration - SNAP_BACK_TO_S);
    } catch {
      // Element detached.
    }
  };
  video.addEventListener("timeupdate", onTimeUpdate, { capture: true });
  video.addEventListener("ended", onEnded, { capture: true });

  // ---- URL strip --------------------------------------------------------
  const originalHref = location.href;
  let urlStripped = false;
  try {
    const url = new URL(location.href);
    if (
      url.searchParams.has("list") ||
      url.searchParams.has("index") ||
      url.searchParams.has("start_radio")
    ) {
      url.searchParams.delete("list");
      url.searchParams.delete("index");
      url.searchParams.delete("start_radio");
      history.replaceState(history.state, "", url.toString());
      urlStripped = true;
    }
  } catch {
    // Non-standard URL — leave it alone.
  }

  // ---- Force mute for the entire pass ----------------------------------
  // YouTube's player can be unmuted by user gesture during playback, and
  // simply setting `video.muted = true` is not enough on its own — we
  // also drop volume to 0 so a future unmute (`muted = false` on user
  // click) does not produce audible scrubbing audio. The `finally` block
  // restores both from `wasVolume`/`wasMuted`.
  try {
    video.volume = 0;
  } catch {
    // Some players reject setVolume; the user may briefly hear scrubbing audio.
  }
  try {
    video.muted = true;
  } catch {
    // ignore — combined with volume = 0 above, audio should still be silent.
  }

  // ---- Buffer helpers (closure over `video`) ----------------------------
  const isTimeBuffered = (t: number): boolean => {
    for (let i = 0; i < video.buffered.length; i++) {
      if (t >= video.buffered.start(i) && t <= video.buffered.end(i)) return true;
    }
    return false;
  };
  const bufferedTotal = (): number => {
    let total = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      total += video.buffered.end(i) - video.buffered.start(i);
    }
    return total;
  };
  /** Highest position the buffer has ever reached on the timeline,
   *  across the entire pass. YouTube's ABR / SABR session reset can
   *  shrink `video.buffered` back to a window around the current
   *  playhead — but the SW's webRequest hook has already captured the
   *  POSTs for those segments, so the bytes are safe in
   *  `__ytSabrBodies`. We use this watermark for progress and Pass 1
   *  termination so a transient buffer collapse doesn't cause us to
   *  spin or terminate early. */
  let maxBufferedEnd = 0;
  /** Highest TOTAL buffered seconds the timeline has ever shown. Used
   *  for the same reason as `maxBufferedEnd` but tracks the union of
   *  all buffered ranges. */
  let maxBufferedTotal = 0;
  const updateBufferedHighWaterMark = (): void => {
    let endHere = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      const e = video.buffered.end(i);
      if (e > endHere) endHere = e;
    }
    if (endHere > maxBufferedEnd) maxBufferedEnd = endHere;
    const total = bufferedTotal();
    if (total > maxBufferedTotal) maxBufferedTotal = total;
  };
  const waitForBuffer = async (t: number, maxWaitMs: number): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (isTimeBuffered(t)) return true;
      await sleep(200);
    }
    return false;
  };

  // ---- Throttled progress emitter ---------------------------------------
  // We report `max(currentTotal, watermark)` because the user-facing
  // progress bar must never go backwards: even if YouTube briefly
  // shrinks `video.buffered`, the SW already captured those segments.
  let lastProgressEmit = 0;
  let lastProgressPct = -1;
  const emitProgress = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastProgressEmit < PROGRESS_THROTTLE_MS) return;
    updateBufferedHighWaterMark();
    const effective = Math.max(bufferedTotal(), maxBufferedTotal);
    const pct = Math.round(Math.min(100, (effective / duration) * 100));
    if (pct === lastProgressPct && !force) return;
    lastProgressEmit = now;
    lastProgressPct = pct;
    try {
      onProgress(pct);
    } catch {
      // Caller-supplied callback threw; swallow so we don't abort the pass.
    }
  };

  // ---- Pass 1 — fast playback -----------------------------------------
  let result: ForceBufferResult = { ok: true };
  try {
    // Pick a safe playbackRate based on the selected quality height.
    // At ≤ 1080p the player can comfortably fetch segments at 16x, but
    // 1440p (2K) and 2160p (4K) bitrates are large enough that 16x
    // race-skips media — segments are decoded out of order and the
    // bridge captures gaps. Scale down accordingly.
    const targetRate =
      qualityHeight >= 2160
        ? 2
        : qualityHeight >= 1440
          ? 4
          : 16;
    try {
      // 16x / 4x / 2x — fast enough for the bridge to fetch every
      // segment for the chosen quality without race-skipping.
      video.playbackRate = targetRate;
    } catch {
      try {
        // Fallback: 2x is the safest rate the spec mandates browsers
        // support without quirks.
        video.playbackRate = 2;
      } catch {
        // Some players reject any rate change; proceed at default rate.
      }
    }
    try {
      video.currentTime = 0;
    } catch {
      // Seeking might fail if the source isn't ready yet; the play loop
      // below will still drive the buffer.
    }
    try {
      await video.play();
    } catch {
      // Autoplay policy may block; the clamp listener will keep the
      // video alive once it does start playing.
    }

    const playStart = Date.now();
    // Coverage-based target: stop Pass 1 as soon as the buffer covers
    // the entire timeline. The clamp keeps `currentTime` away from the
    // last few seconds, so this watermark is what a fully-fetched
    // session looks like in practice. We compare against
    // `maxBufferedEnd` (high-water mark) so a transient buffer
    // collapse from YouTube's ABR / SABR session reset doesn't reset
    // our progress.
    const PASS1_TARGET_END = duration * PASS1_COVERAGE_TARGET;
    let lastBuffered = -1;
    let lastGrowthAt = playStart;
    let stallCount = 0;
    let lastResumeAfterCollapseAt = 0;
    let lastForwardResumeAt = 0;
    let pass1ReachedTarget = false;

    while (Date.now() - playStart < PASS1_TIMEOUT_MS) {
      if (playerSwapped()) {
        console.warn(`${TAG} Player swapped video — aborting Pass 1`);
        result = { ok: false, reason: "playerSwapped" };
        break;
      }
      updateBufferedHighWaterMark();
      const buf = bufferedTotal();

      // Check whether YouTube's ABR or SABR session collapsed the
      // buffer back to a small window around the playhead. When this
      // happens `video.buffered` shrinks dramatically; the SW already
      // owns the bytes for the segments we lost, so the priority is
      // to keep the player moving forward and re-engaging fetches
      // beyond the collapsed range. We seek `currentTime` to the
      // previous high-water mark minus a small overlap so the player
      // resumes fetching past it.
      const collapseThreshold = Math.max(maxBufferedTotal - 30, 5);
      if (
        maxBufferedTotal > 30 &&
        buf < collapseThreshold &&
        Date.now() - lastResumeAfterCollapseAt > 5_000
      ) {
        const resumeAt = Math.max(0, Math.min(maxBufferedEnd - 2, duration - SAFE_MARGIN_S - 2));
        console.log(
          `${TAG} Pass 1: buffer collapse detected (${buf.toFixed(1)}s < ${collapseThreshold.toFixed(1)}s, watermark=${maxBufferedEnd.toFixed(1)}s) — seek to ${resumeAt.toFixed(1)}s and resume`,
        );
        try {
          video.currentTime = resumeAt;
        } catch { /* ignore */ }
        try {
          await video.play();
        } catch { /* ignore */ }
        lastResumeAfterCollapseAt = Date.now();
        stallCount = 0;
        lastGrowthAt = Date.now();
      }

      // Pass 1 success uses maxBufferedTotal (union of all buffered
      // ranges, monotonically increasing watermark). Even if YouTube
      // collapsed the buffer down, the SW already saw those SABR POSTs
      // — the bytes are safe in __ytSabrBodies. We exit Pass 1 once
      // the union ever covered >=99.9% of the timeline.
      if (maxBufferedTotal >= PASS1_TARGET_END) {
        pass1ReachedTarget = true;
        break;
      }

      if (Math.abs(buf - lastBuffered) < STALL_DELTA_S) {
        stallCount++;
        if (stallCount > STALL_TICKS_LIMIT) {
          const ct = video.currentTime;
          const ceiling = duration - SAFE_MARGIN_S - 2;
          if (ct >= ceiling - 1) {
            console.log(
              `${TAG} Pass 1: at clamp ceiling, finishing early (buf=${buf.toFixed(1)}s/${PASS1_TARGET_END.toFixed(1)}s, watermark=${maxBufferedTotal.toFixed(1)}s)`,
            );
            pass1ReachedTarget = true;
            break;
          }

          // Active forward resume: YouTube has cancelled or paused
          // segment fetches but the timeline is still incomplete. Find
          // the end of the last contiguous buffered range that
          // contains (or is closest after) `currentTime`, seek to that
          // edge minus 0.5 s of overlap, and resume playback. This
          // forces the player to issue a fresh SABR POST for the next
          // segment beyond the buffered tail.
          //
          // We throttle to one forward resume every 3 s so we do not
          // pile up seeks. After each forward resume we also briefly
          // drop `playbackRate` to 1 so the player can serve a clean
          // request without race-skipping.
          if (Date.now() - lastForwardResumeAt > 3_000) {
            // Find the rightmost buffered range end on the timeline.
            let lastRangeEnd = 0;
            for (let i = 0; i < video.buffered.length; i++) {
              const e = video.buffered.end(i);
              if (e > lastRangeEnd) lastRangeEnd = e;
            }
            const seekTo = Math.max(
              0,
              Math.min(lastRangeEnd - 0.5, duration - SAFE_MARGIN_S - 2),
            );
            console.log(
              `${TAG} Pass 1: stall detected (buf=${buf.toFixed(1)}s/${PASS1_TARGET_END.toFixed(1)}s, watermark=${maxBufferedTotal.toFixed(1)}s, lastRangeEnd=${lastRangeEnd.toFixed(1)}s) — forward resume seek to ${seekTo.toFixed(1)}s`,
            );
            // Drop to 1x for one tick so the next request goes out
            // cleanly; the loop will bump it back up via the post-
            // playStart targetRate set below if needed.
            try {
              video.playbackRate = 1;
            } catch { /* ignore */ }
            try {
              video.currentTime = seekTo;
            } catch { /* ignore */ }
            try {
              await video.play();
            } catch { /* ignore */ }
            // Give the player ~1.5 s at 1x to issue the SABR POST,
            // then bump back up to the chosen high rate.
            await sleep(1_500);
            try {
              video.playbackRate = targetRate;
            } catch { /* ignore */ }

            lastForwardResumeAt = Date.now();
            stallCount = 0;
            lastGrowthAt = Date.now();
          } else {
            // Still throttled — just reset the stall counter so we
            // don't bail prematurely.
            stallCount = 0;
          }
        }
      } else {
        stallCount = 0;
        lastGrowthAt = Date.now();
      }
      lastBuffered = buf;
      emitProgress();
      await sleep(PASS1_TICK_MS);
    }

    if (!result.ok) {
      // Player swapped during Pass 1 — skip Pass 2 and tail prefetch.
    } else if (!pass1ReachedTarget) {
      const noGrowthForMs = Date.now() - lastGrowthAt;
      const reason: "noBufferGrowth" | "timeout" =
        noGrowthForMs >= NO_GROWTH_SUSPICION_MS ? "noBufferGrowth" : "timeout";
      console.warn(
        `${TAG} Pass 1 timed out (buf=${bufferedTotal().toFixed(1)}s, watermark=${maxBufferedEnd.toFixed(1)}s/${PASS1_TARGET_END.toFixed(1)}s, noGrowthFor=${noGrowthForMs}ms) — reason=${reason}`,
      );
      result = { ok: false, reason };
    }

    try {
      video.pause();
    } catch {
      // Element detached.
    }

    // ---- Pass 2 — gap-fill seek (only if Pass 1 succeeded) -----------
    if (result.ok) {
      // Disable the clamp so seeks into the last 4 seconds of the
      // timeline are not snapped back to `duration - SNAP_BACK_TO_S`.
      // Without this the player can never request the final segments
      // and the saved file ends ~10 seconds short of the original
      // duration.
      clampDisabled = true;

      const gaps: number[] = [];
      for (let t = 0; t < duration; t += PASS2_STEP_S) {
        if (!isTimeBuffered(t)) gaps.push(t);
      }
      console.log(
        `${TAG} After fast playback: ${gaps.length} unbuffered points (out of ${Math.ceil(duration / PASS2_STEP_S)})`,
      );

      if (gaps.length > 0) {
        const targets = gaps.slice(0, MAX_GAP_SEEKS);
        for (const t of targets) {
          if (playerSwapped()) {
            console.warn(`${TAG} Player swapped video — aborting Pass 2`);
            result = { ok: false, reason: "playerSwapped" };
            break;
          }
          if (isTimeBuffered(t)) continue;
          try {
            video.currentTime = t;
          } catch {
            // Seek failed — skip this gap.
            continue;
          }
          try {
            await video.play();
          } catch {
            // play() rejected — wait anyway in case the buffer fills passively.
          }
          await waitForBuffer(t, GAP_WAIT_MS);
          try {
            video.pause();
          } catch {
            // Element detached.
          }
          emitProgress();
          await sleep(GAP_COOLDOWN_MS);
        }
      }

      // Second gap-fill pass — re-scan after the first sweep and pick
      // up anything that was still unbuffered. SABR delivery can lag
      // behind a single seek when the network is slow, so a second
      // visit to the same timestamps usually completes coverage.
      if (result.ok) {
        const remainingGaps: number[] = [];
        for (let t = 0; t < duration; t += PASS2_STEP_S) {
          if (!isTimeBuffered(t)) remainingGaps.push(t);
        }
        if (remainingGaps.length > 0) {
          console.log(
            `${TAG} Second gap-fill pass: ${remainingGaps.length} points still unbuffered`,
          );
          for (const t of remainingGaps) {
            if (playerSwapped()) {
              result = { ok: false, reason: "playerSwapped" };
              break;
            }
            if (isTimeBuffered(t)) continue;
            try {
              video.currentTime = t;
            } catch {
              continue;
            }
            try {
              await video.play();
            } catch {
              /* ignore */
            }
            await waitForBuffer(t, GAP_WAIT_MS);
            try {
              video.pause();
            } catch {
              /* ignore */
            }
            emitProgress();
            await sleep(GAP_COOLDOWN_MS);
          }
        }
      }
    }

    // ---- Tail prefetch -------------------------------------------------
    //
    // The clamp keeps `currentTime` away from the last 4 seconds so the
    // player doesn't fire `ended` and stop fetching segments. Once Pass 1
    // and Pass 2 are done we disable the clamp and aggressively scrub
    // through the tail to make YouTube fetch the final 6 seconds of
    // segments. We do this in a loop because a single seek + 3 s play
    // often only covers ~10 s of tail data on a fast-playback session —
    // we need to sit at progressively-later positions until
    // `bufferedEnd` reaches the final SimpleBlock boundary.
    if (result.ok && !playerSwapped() && duration > 6) {
      clampDisabled = true;
      // Drop playbackRate to 1 so each second of wall time corresponds
      // to one second of fetched data. At higher rates the player skips
      // segments as it races past them.
      try {
        video.playbackRate = 1;
      } catch {
        /* ignore */
      }

      const tailDeadline = Date.now() + 90_000; // hard cap 90 s
      // Walk seek positions in 1-second hops from `duration - 6` down
      // to the very end so we exercise every segment in the last 6 s.
      // The final position is `duration - 0.1` — close enough to the
      // end that the player has to fetch the final SimpleBlock without
      // firing `ended` (the clamp listener is disabled, but YouTube's
      // own `ended` handler is gated on the actual MSE playback head).
      const seekPositions: number[] = [
        Math.max(0, duration - 10),
        Math.max(0, duration - 6),
        Math.max(0, duration - 4),
        Math.max(0, duration - 2),
        Math.max(0, duration - 1),
        Math.max(0, duration - 0.5),
        Math.max(0, duration - 0.2),
        Math.max(0, duration - 0.1),
      ];
      for (const tailPos of seekPositions) {
        if (Date.now() > tailDeadline) break;
        if (playerSwapped()) break;

        // Compute how much of the timeline is already buffered. Stop early
        // if the entire timeline is covered.
        const buf = bufferedTotal();
        if (buf >= duration - 0.5) {
          console.log(
            `${TAG} Tail prefetch: buffer covers ${buf.toFixed(1)}s of ${duration.toFixed(1)}s — done`,
          );
          break;
        }

        console.log(
          `${TAG} Tail prefetch: seek to ${tailPos.toFixed(1)}s (buf=${buf.toFixed(1)}s/${duration.toFixed(1)}s)`,
        );
        try {
          video.currentTime = tailPos;
        } catch {
          /* ignore */
        }
        try {
          await video.play();
        } catch {
          /* ignore */
        }
        // Wait up to 10 seconds for the buffer to extend past tailPos.
        // We poll every 250 ms because some videos finish prefetching
        // the tail in well under a second once the seek lands; long
        // videos on slower networks need the full window.
        const waitDeadline = Date.now() + 10_000;
        while (Date.now() < waitDeadline) {
          await sleep(250);
          const newBuf = bufferedTotal();
          // Stop early once the buffer covers the rest of the timeline.
          if (newBuf >= duration - 0.5) break;
          // Or once the buffer crossed tailPos itself (we got SOME tail
          // data, can move to the next position to reach further).
          if (isTimeBuffered(tailPos + 1)) break;
        }
        try {
          video.pause();
        } catch {
          /* ignore */
        }
      }

      // Final dwell — sit at `duration - 0.05` for up to 5 seconds so
      // YouTube's player actually fetches the very last SimpleBlock.
      // Without this, on long videos the player tends to stop one
      // segment short.
      if (Date.now() < tailDeadline && !playerSwapped()) {
        const finalPos = Math.max(0, duration - 0.05);
        try {
          video.currentTime = finalPos;
        } catch {
          /* ignore */
        }
        try {
          await video.play();
        } catch {
          /* ignore */
        }
        await sleep(5_000);
        try {
          video.pause();
        } catch {
          /* ignore */
        }
      }

      // Jump back into the middle of the timeline so the clamp re-engages
      // cleanly if the caller resumes playback.
      try {
        video.currentTime = Math.max(0, Math.min(duration / 2, duration - SAFE_MARGIN_S - 2));
      } catch {
        /* ignore */
      }
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      emitProgress(/* force */ true);
    }
  } finally {
    // ---- Cleanup — ALWAYS restores caller state -----------------------
    try {
      video.removeEventListener("timeupdate", onTimeUpdate, { capture: true });
    } catch {
      // ignore
    }
    try {
      video.removeEventListener("ended", onEnded, { capture: true });
    } catch {
      // ignore
    }
    try {
      video.loop = wasLoop;
    } catch {
      // ignore
    }
    try {
      video.playbackRate = wasRate;
    } catch {
      // ignore
    }
    try {
      video.muted = wasMuted;
    } catch {
      // ignore
    }
    try {
      video.volume = wasVolume;
    } catch {
      // ignore
    }
    try {
      video.currentTime = wasTime;
    } catch {
      // ignore
    }
    try {
      if (wasPaused) {
        video.pause();
      }
    } catch {
      // ignore — `wasPaused` snapshot is only advisory after a swap.
    }
    try {
      if (urlStripped) {
        history.replaceState(history.state, "", originalHref);
      }
    } catch {
      // ignore
    }
    try {
      if (autoplayWasOn) {
        const p = getMoviePlayer();
        // Legacy uses state 2 to re-enable autonav. State 3 = disabled.
        p?.setAutonavState?.(2);
      }
    } catch {
      // ignore
    }
  }

  // ---- Final buffer log -------------------------------------------------
  try {
    const ranges: string[] = [];
    for (let i = 0; i < video.buffered.length; i++) {
      ranges.push(
        `[${video.buffered.start(i).toFixed(1)}-${video.buffered.end(i).toFixed(1)}]`,
      );
    }
    console.log(
      `${TAG} Force buffering complete (ok=${result.ok}). Buffered: ${ranges.join(" ")} of ${duration.toFixed(1)}s`,
    );
  } catch {
    // ignore — logging is best-effort
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the on-page YouTube `movie_player` element. Returns null when missing. */
function getMoviePlayer(): YouTubePlayer | null {
  try {
    const el = document.getElementById("movie_player");
    if (!el) return null;
    return el as unknown as YouTubePlayer;
  } catch {
    return null;
  }
}

/** Read `?v=` from the current href. Returns null when not on a watch page. */
function readVideoIdFromHref(): string | null {
  try {
    const params = new URLSearchParams(location.search);
    return params.get("v");
  } catch {
    return null;
  }
}

/** Promise-friendly setTimeout. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
