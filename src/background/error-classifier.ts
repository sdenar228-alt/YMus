// Error classification for the Service Worker.
//
// All errors raised inside the Service Worker (network failures, API errors,
// timeouts, etc.) are funneled through `classifyError` so the message router
// can attach a stable `errorCode` to the `ErrorResponse` returned to the
// Content Script.

import type { ErrorCode } from "../shared/types";

export type { ErrorCode };

/**
 * HTTP error originating from a Yandex API or CDN response.
 *
 * Carries the numeric HTTP status so `classifyError` can map it to the
 * appropriate `ErrorCode`.
 */
export class ApiError extends Error {
  public readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `API error: HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

/**
 * Timeout error raised when an operation exceeds its allotted time
 * (e.g. the 30-second budget for the Yandex API request in `getDownloadURL`).
 */
export class TimeoutError extends Error {
  constructor(message = "Operation timed out") {
    super(message);
    this.name = "TimeoutError";
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * Raised by the YouTube fallback pipeline when none of the available video
 * streams matches the requested quality. Mapped to `"NO_SUITABLE_QUALITY"`
 * so the user sees a non-retryable error in the content script.
 */
export class NoSuitableQualityError extends Error {
  constructor(message = "No suitable quality stream available") {
    super(message);
    this.name = "NoSuitableQualityError";
    Object.setPrototypeOf(this, NoSuitableQualityError.prototype);
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function hasNumericStatus(value: unknown): value is { status: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof (value as { status: unknown }).status === "number"
  );
}

function getMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  ) {
    return (value as { message: string }).message;
  }
  return "";
}

function getName(value: unknown): string {
  if (value instanceof Error) return value.name;
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as { name: unknown }).name === "string"
  ) {
    return (value as { name: string }).name;
  }
  return "";
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Classify an arbitrary error value into a stable `ErrorCode`.
 *
 * Mapping rules (first match wins):
 *  - `NoSuitableQualityError` (or name === "NoSuitableQualityError",
 *    or message containing "NO_SUITABLE_QUALITY") → `"NO_SUITABLE_QUALITY"`.
 *  - `TimeoutError`, name === "TimeoutError", or message containing "timeout"
 *    → `"TIMEOUT"`.
 *  - `ApiError` (or any object with a numeric `status`):
 *      - 401 / 403 → `"AUTH_REQUIRED"`
 *      - other     → `"API_ERROR"`
 *  - `TypeError` (fetch network failure) → `"NETWORK_ERROR"`.
 *  - Anything else → `"API_ERROR"`.
 */
export function classifyError(e: unknown): ErrorCode {
  // No-suitable-quality wins over generic API errors so callers can show a
  // clear message ("This quality is not available, try another one").
  if (e instanceof NoSuitableQualityError) {
    return "NO_SUITABLE_QUALITY";
  }
  if (getName(e) === "NoSuitableQualityError") {
    return "NO_SUITABLE_QUALITY";
  }
  if (getMessage(e).includes("NO_SUITABLE_QUALITY")) {
    return "NO_SUITABLE_QUALITY";
  }

  // Timeout takes precedence: a timeout that wraps a fetch error should still
  // surface as TIMEOUT.
  if (e instanceof TimeoutError) {
    return "TIMEOUT";
  }
  if (getName(e) === "TimeoutError") {
    return "TIMEOUT";
  }
  if (getMessage(e).toLowerCase().includes("timeout")) {
    return "TIMEOUT";
  }

  // HTTP errors carrying a numeric `status`.
  if (e instanceof ApiError || hasNumericStatus(e)) {
    const status = (e as { status: number }).status;
    if (status === 401 || status === 403) {
      return "AUTH_REQUIRED";
    }
    return "API_ERROR";
  }

  // `fetch` raises a plain `TypeError` on network failures (DNS, offline, CORS).
  if (e instanceof TypeError) {
    return "NETWORK_ERROR";
  }

  return "API_ERROR";
}
