// Message serialization guard for Chrome Extension Messaging.
// Implements rules described in Requirement 6.6: only serializable data
// (strings, numbers, plain objects/arrays without methods or prototypes)
// may be exchanged between Content Script and Service Worker.
//
// The chrome.runtime messaging layer silently corrupts non-serializable
// values (functions become undefined, undefined values disappear, Date
// instances become {}). We prefer to fail loudly during development so
// such bugs never reach production.

/**
 * Returns true if `value` is a plain object — created via object literal,
 * `Object.create(null)`, or otherwise has `Object.prototype` (or null) as
 * its prototype. Class instances, Maps, Sets, Dates, etc. fail this check.
 */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Best-effort name for a non-plain object so the thrown error points the
 * caller at the offending value (e.g. "Date", "Map", "URLSearchParams").
 */
function describeNonPlainObject(value: object): string {
  const ctor = (value as { constructor?: { name?: string } }).constructor;
  if (ctor && typeof ctor.name === "string" && ctor.name.length > 0) {
    return ctor.name;
  }
  return "object";
}

/**
 * Recursively walks `value`, throwing on the first non-serializable node.
 *
 * `ancestors` tracks the path from the root to the current node — this lets
 * us detect cycles (a node referencing one of its own ancestors) while still
 * permitting shared sub-trees (the same object referenced from two siblings),
 * which `JSON.stringify` itself handles fine.
 */
function walk(value: unknown, ancestors: WeakSet<object>): void {
  if (value === null) {
    return;
  }

  const kind = typeof value;

  if (kind === "function") {
    throw new Error("Non-serializable: function");
  }
  if (kind === "undefined") {
    throw new Error("Non-serializable: undefined");
  }
  if (kind === "symbol") {
    throw new Error("Non-serializable: symbol");
  }
  if (kind === "bigint") {
    throw new Error("Non-serializable: bigint");
  }
  if (kind === "number") {
    // JSON.stringify silently converts NaN / ±Infinity to `null`, so reject
    // them up front to avoid lossy round-trips across the messaging boundary.
    if (!Number.isFinite(value as number)) {
      throw new Error("Non-serializable: non-finite number");
    }
    return;
  }
  if (kind === "string" || kind === "boolean") {
    return;
  }

  // Anything left is an object or array.
  const obj = value as object;

  if (ancestors.has(obj)) {
    throw new Error("Non-serializable: cyclic reference");
  }
  ancestors.add(obj);

  try {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        walk(obj[i], ancestors);
      }
      return;
    }

    if (!isPlainObject(obj)) {
      throw new Error(`Non-serializable: ${describeNonPlainObject(obj)}`);
    }

    for (const key of Object.keys(obj)) {
      walk((obj as Record<string, unknown>)[key], ancestors);
    }
  } finally {
    // Pop the node off the ancestor path so sibling sub-trees may share
    // references without being misclassified as cycles.
    ancestors.delete(obj);
  }
}

/**
 * Asserts that `message` consists solely of values safe to round-trip
 * through `JSON.parse(JSON.stringify(...))` — strings, finite numbers,
 * booleans, `null`, plain objects, and arrays of the same.
 *
 * Throws `Error("Non-serializable: <reason>")` on the first offending
 * value, where `<reason>` is one of: `function`, `undefined`, `symbol`,
 * `bigint`, `non-finite number`, `cyclic reference`, or the constructor
 * name of a non-plain object (e.g. `Date`, `Map`).
 *
 * Validates: Requirement 6.6.
 */
export function assertSerializable(message: unknown): void {
  walk(message, new WeakSet<object>());
}

/**
 * Thin wrapper around `chrome.runtime.sendMessage` that asserts the
 * message is fully serializable before dispatching it.
 *
 * Use this in place of the raw API at every send-site so non-serializable
 * payloads fail loudly at the call-site instead of silently arriving as
 * corrupted data on the receiving end.
 *
 * Validates: Requirement 6.6.
 */
export function safeSendMessage<TResponse = unknown>(
  message: unknown
): Promise<TResponse> {
  assertSerializable(message);
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
}
