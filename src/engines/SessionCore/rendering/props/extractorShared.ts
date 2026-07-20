/**
 * Shared utilities for data extractors.
 *
 * Contains: safe text extraction, success/failure helpers, language detection,
 * line-number stripping with cache, and unified-diff parsing.
 */
import { LRUCache } from "@src/util/cache/lruCache";

// ============================================
// Safe Text Extraction
// ============================================

/**
 * Safely extract text content from various formats.
 * Handles: string, {content: string}, {role, content}, arrays, etc.
 */
export function safeText(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.message === "string") return obj.message;
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = safeText(item);
        if (text) return text;
      }
    }
  }
  return undefined;
}

// ============================================
// Result Success/Failure Extraction
// ============================================

/**
 * Extract success data from tool result.
 * Handles both nested (result.output.success) and flat (result.success) formats.
 */
export function extractSuccessData(
  result: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!result) return {};
  const output = result.output as Record<string, unknown> | undefined;
  const nestedSuccess = (output?.success as Record<string, unknown>) || {};
  const directSuccess = (result.success as Record<string, unknown>) || {};
  return Object.keys(nestedSuccess).length > 0 ? nestedSuccess : directSuccess;
}

/**
 * Extract failure data from tool result.
 * Handles both nested (result.output.failure) and flat (result.failure) formats.
 */
export function extractFailureData(
  result: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!result) return {};
  const output = result.output as Record<string, unknown> | undefined;
  const nestedFailure = (output?.failure as Record<string, unknown>) || {};
  const directFailure = (result.failure as Record<string, unknown>) || {};
  return Object.keys(nestedFailure).length > 0 ? nestedFailure : directFailure;
}

// ============================================
// Language Detection
// ============================================

const LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  php: "php",
  css: "css",
  scss: "scss",
  html: "html",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  sh: "bash",
  sql: "sql",
};

export function detectLanguage(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  return LANG_MAP[ext] || "plaintext";
}

// ============================================
// Cache Utilities
// ============================================

export function cacheKey(content: string): string {
  return content.length > 200
    ? `${content.length}:${content.slice(0, 100)}:${content.slice(-100)}`
    : content;
}

export function evictAndSet<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxSize: number
): void {
  if (cache.size >= maxSize) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, value);
}

// ============================================
// Line Number Prefix Stripping
// ============================================

// Matches the right-aligned line-number prefix emitted by
// `foundation/tool_infra/file.rs::format_text_result`.
// Current separator: `│` (U+2502). Legacy: `→` (U+2192) for older sessions.
const LINE_PREFIX_REGEX = /^\s*\d+[│→]/;
// `read_file` (`agent_core/core/tools/impls/coding/files.rs`) prepends a
// classification marker line of the form `[action: read_text]` (or
// `read_image` / `read_pdf`). The marker is purely an LLM hint and must
// never reach the renderer.
const ACTION_MARKER_REGEX = /^\[action:[^\]]*\]$/;
const READ_FILE_FOOTER_REGEX =
  /^\[Showing lines \d+-\d+ of \d+ total \([^)]+\)(?:\. Use offset and limit to read other sections\.)?\]$/;
const MAX_STRIP_CACHE = 500;

const stripCache = new LRUCache<
  string,
  { content: string; lineCount: number; startLine?: number }
>(MAX_STRIP_CACHE);

/**
 * Strip the leading `[action: ...]` marker plus per-line `<digits><sep>`
 * prefixes from `read_file` content. Results are cached by a
 * length+head+tail key to avoid repeated work across re-renders.
 *
 * `startLine` is the 1-indexed line number parsed from the first numbered
 * line — for ranged reads (offset/limit) this is the read's start offset.
 * Undefined when the content carried no line-number prefixes.
 */
export function stripLineNumberPrefixes(content: string): {
  content: string;
  lineCount: number;
  startLine?: number;
} {
  const key = cacheKey(content);
  const cached = stripCache.get(key);
  if (cached) return cached;

  const lines = content.split("\n");
  const hasActionMarker =
    lines.length > 0 && ACTION_MARKER_REGEX.test(lines[0]);
  const bodyWithFooter = hasActionMarker ? lines.slice(1) : lines;
  const hasReadFileFooter =
    bodyWithFooter.length > 0 &&
    READ_FILE_FOOTER_REGEX.test(
      bodyWithFooter[bodyWithFooter.length - 1].trim()
    );
  const body = hasReadFileFooter ? bodyWithFooter.slice(0, -1) : bodyWithFooter;

  const firstNonEmpty = body.find((line) => line.trim().length > 0);
  const numbered =
    firstNonEmpty !== undefined && LINE_PREFIX_REGEX.test(firstNonEmpty);

  if (!numbered && !hasActionMarker && !hasReadFileFooter) {
    const result = { content, lineCount: lines.length };
    stripCache.set(key, result);
    return result;
  }

  const startLine =
    numbered && firstNonEmpty !== undefined
      ? Number.parseInt(firstNonEmpty.trimStart(), 10) || undefined
      : undefined;

  const stripped = numbered
    ? body.map((line) => line.replace(LINE_PREFIX_REGEX, "")).join("\n")
    : body.join("\n");
  const result = { content: stripped, lineCount: body.length, startLine };
  stripCache.set(key, result);
  return result;
}
