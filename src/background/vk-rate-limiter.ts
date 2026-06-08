/**
 * VK Rate Limiter with backoff and circuit breaker.
 *
 * State machine:
 * - Normal: 500ms minimum between requests
 * - Elevated: 3000ms between requests (10 request window after a 429)
 * - Paused: All requests blocked for 30 seconds (circuit breaker)
 *
 * Transitions:
 * - Normal → Elevated: on report429()
 * - Elevated → Normal: after 10 requests served at elevated delay
 * - Elevated → Paused: on 3 consecutive 429s within 60s
 * - Paused → Normal: after 30s elapsed
 */

export interface VkRateLimiter {
  /** Wait until a request slot is available. Resolves after required delay. */
  acquire(): Promise<void>;
  /** Report a 429 response. Increases delay, may trigger circuit breaker. */
  report429(): void;
  /** Report a successful response. */
  reportSuccess(): void;
  /** Get retry delay for attempt number (1-based). Returns null if max retries exceeded. */
  getRetryDelay(attemptNumber: number): number | null;
  /** Reset all state. */
  reset(): void;
}

interface RateLimiterState {
  lastRequestTime: number;
  mode: "normal" | "elevated" | "paused";
  elevatedRemaining: number;
  consecutive429Count: number;
  first429Timestamp: number;
  pauseUntil: number;
}

const NORMAL_DELAY_MS = 500;
const ELEVATED_DELAY_MS = 3000;
const ELEVATED_WINDOW_SIZE = 10;
const PAUSE_DURATION_MS = 30_000;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_WINDOW_MS = 60_000;
const MAX_RETRIES = 3;

export function createVkRateLimiter(): VkRateLimiter {
  const state: RateLimiterState = {
    lastRequestTime: 0,
    mode: "normal",
    elevatedRemaining: 0,
    consecutive429Count: 0,
    first429Timestamp: 0,
    pauseUntil: 0,
  };

  function getDelay(): number {
    switch (state.mode) {
      case "normal":
        return NORMAL_DELAY_MS;
      case "elevated":
        return ELEVATED_DELAY_MS;
      case "paused":
        return 0; // handled separately
    }
  }

  function checkPauseExpired(): void {
    if (state.mode === "paused" && Date.now() >= state.pauseUntil) {
      state.mode = "normal";
      state.consecutive429Count = 0;
      state.first429Timestamp = 0;
    }
  }

  const limiter: VkRateLimiter = {
    acquire(): Promise<void> {
      checkPauseExpired();

      if (state.mode === "paused") {
        const waitTime = state.pauseUntil - Date.now();
        return new Promise((resolve) => {
          setTimeout(() => {
            state.mode = "normal";
            state.consecutive429Count = 0;
            state.first429Timestamp = 0;
            state.lastRequestTime = Date.now();
            resolve();
          }, Math.max(0, waitTime));
        });
      }

      const delay = getDelay();
      const now = Date.now();
      const elapsed = now - state.lastRequestTime;
      const waitTime = Math.max(0, delay - elapsed);

      return new Promise((resolve) => {
        setTimeout(() => {
          state.lastRequestTime = Date.now();

          if (state.mode === "elevated") {
            state.elevatedRemaining--;
            if (state.elevatedRemaining <= 0) {
              state.mode = "normal";
              state.consecutive429Count = 0;
              state.first429Timestamp = 0;
            }
          }

          resolve();
        }, waitTime);
      });
    },

    report429(): void {
      const now = Date.now();

      // Track consecutive 429s within the window
      if (state.first429Timestamp === 0) {
        state.first429Timestamp = now;
      }

      // Check if we're still within the 60s window
      if (now - state.first429Timestamp <= CIRCUIT_BREAKER_WINDOW_MS) {
        state.consecutive429Count++;
      } else {
        // Window expired, start new count
        state.consecutive429Count = 1;
        state.first429Timestamp = now;
      }

      // Check circuit breaker
      if (state.consecutive429Count >= CIRCUIT_BREAKER_THRESHOLD) {
        state.mode = "paused";
        state.pauseUntil = now + PAUSE_DURATION_MS;
        return;
      }

      // Transition to elevated
      state.mode = "elevated";
      state.elevatedRemaining = ELEVATED_WINDOW_SIZE;
    },

    reportSuccess(): void {
      // Reset consecutive 429 count on success
      state.consecutive429Count = 0;
      state.first429Timestamp = 0;
    },

    getRetryDelay(attemptNumber: number): number | null {
      if (attemptNumber < 1 || attemptNumber > MAX_RETRIES) {
        return null;
      }
      // 1000, 2000, 4000
      return 1000 * Math.pow(2, attemptNumber - 1);
    },

    reset(): void {
      state.lastRequestTime = 0;
      state.mode = "normal";
      state.elevatedRemaining = 0;
      state.consecutive429Count = 0;
      state.first429Timestamp = 0;
      state.pauseUntil = 0;
    },
  };

  return limiter;
}
