import { createVkRateLimiter, VkRateLimiter } from "../../src/background/vk-rate-limiter";

describe("VkRateLimiter", () => {
  let limiter: VkRateLimiter;

  beforeEach(() => {
    jest.useFakeTimers();
    limiter = createVkRateLimiter();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("acquire() in normal mode", () => {
    it("resolves after ~500ms gap between consecutive calls", async () => {
      // First acquire should resolve quickly (no previous request)
      const p1 = limiter.acquire();
      jest.advanceTimersByTime(0);
      await p1;

      const startTime = Date.now();

      // Second acquire should wait 500ms
      const p2 = limiter.acquire();
      jest.advanceTimersByTime(500);
      await p2;

      expect(Date.now() - startTime).toBeGreaterThanOrEqual(500);
    });

    it("resolves immediately if enough time has passed", async () => {
      const p1 = limiter.acquire();
      jest.advanceTimersByTime(0);
      await p1;

      // Wait longer than the normal delay
      jest.advanceTimersByTime(1000);

      const startTime = Date.now();
      const p2 = limiter.acquire();
      jest.advanceTimersByTime(0);
      await p2;

      expect(Date.now() - startTime).toBe(0);
    });
  });

  describe("report429() transitions to elevated mode", () => {
    it("uses 3000ms delay after report429", async () => {
      const p1 = limiter.acquire();
      jest.advanceTimersByTime(0);
      await p1;

      limiter.report429();

      const startTime = Date.now();
      const p2 = limiter.acquire();
      jest.advanceTimersByTime(3000);
      await p2;

      expect(Date.now() - startTime).toBeGreaterThanOrEqual(3000);
    });

    it("does not resolve before 3000ms in elevated mode", async () => {
      const p1 = limiter.acquire();
      jest.advanceTimersByTime(0);
      await p1;

      limiter.report429();

      let resolved = false;
      limiter.acquire().then(() => { resolved = true; });

      jest.advanceTimersByTime(2999);
      await Promise.resolve(); // flush microtasks

      expect(resolved).toBe(false);

      jest.advanceTimersByTime(1);
      await Promise.resolve();

      expect(resolved).toBe(true);
    });
  });

  describe("elevated → normal after 10 requests", () => {
    it("returns to normal mode after 10 elevated requests", async () => {
      const p0 = limiter.acquire();
      jest.advanceTimersByTime(0);
      await p0;

      limiter.report429();

      // Serve 10 requests at elevated delay
      for (let i = 0; i < 10; i++) {
        const p = limiter.acquire();
        jest.advanceTimersByTime(3000);
        await p;
      }

      // Next request should use normal delay (500ms)
      const startTime = Date.now();
      const pNormal = limiter.acquire();
      jest.advanceTimersByTime(500);
      await pNormal;

      expect(Date.now() - startTime).toBeLessThanOrEqual(500);
    });
  });

  describe("circuit breaker: 3 consecutive 429s within 60s triggers pause", () => {
    it("blocks all requests for 30s after 3 consecutive 429s", async () => {
      const p0 = limiter.acquire();
      jest.advanceTimersByTime(0);
      await p0;

      // 3 consecutive 429s within 60s
      limiter.report429();
      jest.advanceTimersByTime(10_000);
      limiter.report429();
      jest.advanceTimersByTime(10_000);
      limiter.report429();

      // Now in paused mode - acquire should wait 30s
      let resolved = false;
      limiter.acquire().then(() => { resolved = true; });

      jest.advanceTimersByTime(29_999);
      await Promise.resolve();
      expect(resolved).toBe(false);

      jest.advanceTimersByTime(1);
      await Promise.resolve();
      expect(resolved).toBe(true);
    });

    it("does not trigger circuit breaker if 429s are outside 60s window", async () => {
      const p0 = limiter.acquire();
      jest.advanceTimersByTime(0);
      await p0;

      limiter.report429();
      jest.advanceTimersByTime(30_000);
      limiter.report429();
      jest.advanceTimersByTime(31_000); // > 60s from first
      limiter.report429(); // This starts a new window

      // Should be elevated, not paused
      const startTime = Date.now();
      const p = limiter.acquire();
      jest.advanceTimersByTime(3000);
      await p;

      // If it were paused, it would take 30s, not 3s
      expect(Date.now() - startTime).toBe(3000);
    });
  });

  describe("getRetryDelay", () => {
    it("returns 1000ms for attempt 1", () => {
      expect(limiter.getRetryDelay(1)).toBe(1000);
    });

    it("returns 2000ms for attempt 2", () => {
      expect(limiter.getRetryDelay(2)).toBe(2000);
    });

    it("returns 4000ms for attempt 3", () => {
      expect(limiter.getRetryDelay(3)).toBe(4000);
    });

    it("returns null for attempt 4 and beyond", () => {
      expect(limiter.getRetryDelay(4)).toBeNull();
      expect(limiter.getRetryDelay(5)).toBeNull();
      expect(limiter.getRetryDelay(100)).toBeNull();
    });

    it("returns null for attempt 0 or negative", () => {
      expect(limiter.getRetryDelay(0)).toBeNull();
      expect(limiter.getRetryDelay(-1)).toBeNull();
    });
  });

  describe("reset()", () => {
    it("clears all state and returns to normal mode", async () => {
      const p0 = limiter.acquire();
      jest.advanceTimersByTime(0);
      await p0;

      // Put into elevated mode
      limiter.report429();

      // Reset
      limiter.reset();

      // Should be back in normal mode with 500ms delay
      const startTime = Date.now();
      const p = limiter.acquire();
      jest.advanceTimersByTime(0);
      await p;

      // First call after reset should resolve immediately (lastRequestTime is 0)
      expect(Date.now() - startTime).toBe(0);
    });

    it("clears paused state", async () => {
      const p0 = limiter.acquire();
      jest.advanceTimersByTime(0);
      await p0;

      // Trigger circuit breaker
      limiter.report429();
      limiter.report429();
      limiter.report429();

      // Reset should clear paused state
      limiter.reset();

      // Should resolve quickly
      const p = limiter.acquire();
      jest.advanceTimersByTime(0);
      await p;
      // If still paused, this would throw or hang
    });
  });
});
