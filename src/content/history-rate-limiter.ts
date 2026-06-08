/**
 * Rate limiter and debouncer for History_Injector DOM evaluations.
 * Prevents performance degradation from rapid MutationObserver callbacks.
 */

export interface RateLimiter {
  /** Returns true if the call is allowed, false if rate-limited. */
  tryAcquire(): boolean;
  /** Resets all state (for cleanup on deactivation). */
  reset(): void;
}

export interface Debouncer {
  /** Schedules the callback, resetting the timer on each call. */
  schedule(callback: () => void): void;
  /** Cancels any pending scheduled callback. */
  cancel(): void;
}

/**
 * Creates a rate limiter: max 150 evaluations in a 15-second sliding window.
 * Requirement 7.2
 */
export function createRateLimiter(): RateLimiter {
  const windowMs = 15_000;
  const maxEvaluations = 150;
  const evaluations: number[] = [];

  return {
    tryAcquire(): boolean {
      const now = Date.now();
      // Remove expired timestamps outside the window
      while (evaluations.length > 0 && evaluations[0] <= now - windowMs) {
        evaluations.shift();
      }
      if (evaluations.length >= maxEvaluations) {
        return false;
      }
      evaluations.push(now);
      return true;
    },
    reset(): void {
      evaluations.length = 0;
    },
  };
}

/**
 * Creates a debouncer: delays execution by `delayMs`, resets on each new call.
 * Requirement 7.3
 */
export function createDebouncer(delayMs: number): Debouncer {
  let timerId: ReturnType<typeof setTimeout> | null = null;

  return {
    schedule(callback: () => void): void {
      if (timerId !== null) {
        clearTimeout(timerId);
      }
      timerId = setTimeout(() => {
        timerId = null;
        callback();
      }, delayMs);
    },
    cancel(): void {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
    },
  };
}
