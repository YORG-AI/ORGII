const MAX_TRACKED_STRING_CHARS = 8_192;
const MAX_TRACKED_ARRAY_ITEMS = 8;
const MAX_TRACKED_OBJECT_KEYS = 32;
const MAX_TRACKED_DEPTH = 4;

interface TrackedValueSummary {
  __orgiiTrackerSummary: string;
  length?: number;
  byteLength?: number;
  preview?: string;
  sample?: unknown[];
  keys?: string[];
}

function summarizeBinary(value: unknown): TrackedValueSummary | null {
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return {
      __orgiiTrackerSummary: value.constructor.name,
      byteLength: value.size,
    };
  }
  if (value instanceof ArrayBuffer) {
    return {
      __orgiiTrackerSummary: "ArrayBuffer",
      byteLength: value.byteLength,
    };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      __orgiiTrackerSummary: value.constructor.name,
      byteLength: value.byteLength,
    };
  }
  return null;
}

/**
 * API diagnostics must never become an owner of production payloads. Keep
 * exact small values for useful inspection, but replace large strings,
 * collections, binary bodies, cycles, and deep graphs with bounded metadata.
 */
export function summarizeTrackedValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "string") {
    if (value.length <= MAX_TRACKED_STRING_CHARS) return value;
    return {
      __orgiiTrackerSummary: "string",
      length: value.length,
      preview: value.slice(0, MAX_TRACKED_STRING_CHARS),
    } satisfies TrackedValueSummary;
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    return String(value);
  }
  if (typeof value === "function") {
    return { __orgiiTrackerSummary: "function" } satisfies TrackedValueSummary;
  }

  const binary = summarizeBinary(value);
  if (binary) return binary;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: summarizeTrackedValue(value.message, depth + 1, seen),
      stack: summarizeTrackedValue(value.stack, depth + 1, seen),
    };
  }
  if (value instanceof URLSearchParams) {
    return summarizeTrackedValue(value.toString(), depth, seen);
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) {
    return { __orgiiTrackerSummary: "circular" } satisfies TrackedValueSummary;
  }
  if (depth >= MAX_TRACKED_DEPTH) {
    return {
      __orgiiTrackerSummary: value.constructor?.name ?? "object",
    } satisfies TrackedValueSummary;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (value.length <= MAX_TRACKED_ARRAY_ITEMS) {
      return value.map((item) => summarizeTrackedValue(item, depth + 1, seen));
    }
    return {
      __orgiiTrackerSummary: "Array",
      length: value.length,
      sample: value
        .slice(0, 2)
        .map((item) => summarizeTrackedValue(item, depth + 1, seen)),
    } satisfies TrackedValueSummary;
  }

  const entries = Object.entries(value);
  const result: Record<string, unknown> = {};
  for (const [key, child] of entries.slice(0, MAX_TRACKED_OBJECT_KEYS)) {
    result[key] = summarizeTrackedValue(child, depth + 1, seen);
  }
  if (entries.length > MAX_TRACKED_OBJECT_KEYS) {
    result.__orgiiTrackerSummary = "Object";
    result.__orgiiTrackerOmittedKeys = entries.length - MAX_TRACKED_OBJECT_KEYS;
  }
  return result;
}
