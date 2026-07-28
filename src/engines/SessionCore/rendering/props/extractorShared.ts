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

/** FNV-1a, 32-bit. Cheap enough to run on every lookup. */
function hashContent(content: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function cacheKey(content: string): string {
  if (content.length <= 200) return content;
  // Length + head + tail alone collide when the same file is read again after
  // an in-place edit that preserves its length (`(32px)` → `(36px)` in the
  // middle of a 2.3 KB file, observed in real sessions), which would serve the
  // stale version from cache. The hash covers the middle.
  return `${content.length}:${hashContent(content)}:${content.slice(0, 100)}:${content.slice(-100)}`;
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
// Claude Code's `Read` tool emits `cat -n` style prefixes instead: right-aligned
// line number + TAB. A tab is far weaker evidence than `│`, so this form is only
// stripped when the numbers run consecutively over the whole body — see
// `tabNumberedRange`.
const TAB_PREFIX_REGEX = /^\s*(\d+)\t/;
const SYSTEM_REMINDER_PREFIX = "<system-reminder>";
const SYSTEM_REMINDER_SUFFIX = "</system-reminder>";
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
 * Index just past a leading `<system-reminder>…</system-reminder>` block and
 * any blank lines that follow it. Claude Code prepends one to some `Read`
 * results (e.g. the staleness notice on memory files). Returns 0 when the body
 * does not open with a complete block — an unterminated tag means the string is
 * file content that merely mentions the marker, not a real reminder.
 */
function skipLeadingSystemReminder(body: string[]): number {
  if (body.length === 0) return 0;
  if (!body[0].trimStart().startsWith(SYSTEM_REMINDER_PREFIX)) return 0;

  const close = body.findIndex((line) => line.includes(SYSTEM_REMINDER_SUFFIX));
  if (close === -1) return 0;

  let start = close + 1;
  while (start < body.length && body[start].trim().length === 0) start += 1;
  return start;
}

/**
 * Range of `body` holding `<digits><TAB>` lines whose numbers increase by
 * exactly 1, or null when `body` is not `cat -n` output.
 *
 * A tab separator also occurs in ordinary data (a TSV with a sequential id
 * column), so the run must cover the whole body — only blank lines and a
 * `<system-reminder>` block may sit on either side of it. Anything else means
 * the content is a real file and must be left untouched.
 */
function tabNumberedRange(
  body: string[]
): { start: number; end: number } | null {
  const start = skipLeadingSystemReminder(body);
  let expected: number | null = null;
  let end = start;
  for (let i = start; i < body.length; i += 1) {
    const match = TAB_PREFIX_REGEX.exec(body[i]);
    if (!match) break;
    const lineNo = Number.parseInt(match[1], 10);
    if (expected !== null && lineNo !== expected) return null;
    expected = lineNo + 1;
    end += 1;
  }
  if (end === start) return null;

  for (let i = end; i < body.length; i += 1) {
    const rest = body[i].trim();
    if (rest.length === 0) continue;
    if (rest.startsWith(SYSTEM_REMINDER_PREFIX)) break;
    return null;
  }
  return { start, end };
}

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
  const tabRange = numbered ? null : tabNumberedRange(body);

  if (!numbered && !tabRange && !hasActionMarker && !hasReadFileFooter) {
    const result = { content, lineCount: lines.length };
    stripCache.set(key, result);
    return result;
  }

  if (tabRange) {
    const numberedBody = body.slice(tabRange.start, tabRange.end);
    const result = {
      content: numberedBody
        .map((line) => line.replace(TAB_PREFIX_REGEX, ""))
        .join("\n"),
      lineCount: numberedBody.length,
      startLine: Number.parseInt(numberedBody[0].trimStart(), 10) || undefined,
    };
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

// ============================================
// Unified diff → old/new content splitter
// ============================================

const EXTRACT_HUNK_HEADER_RE =
  /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Split a unified diff string into old/new plain-text values.
 * Shared by simulator variant rendering and playground file operations.
 *
 * Gap placeholder lines are inserted between hunks so that the absolute
 * line numbers from each @@ header are preserved in the output strings.
 * Without this, multi-hunk diffs produce wrong line numbers when the
 * diff viewer re-computes a diff from the old/new values.
 */
/**
 * Merge multiple unified-diff strings (each potentially multi-hunk) into a
 * single unified-diff string whose hunks are sorted by old-file line number.
 *
 * Later hunks that overlap with earlier ones win (edit-order semantics).
 */
export function mergeUnifiedDiffStrings(diffs: string[]): string {
  interface Hunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    bodyLines: string[];
  }

  const allHunks: Hunk[] = [];

  for (const diff of diffs) {
    const lines = diff.split("\n");
    let current: Hunk | null = null;
    for (const line of lines) {
      if (line.startsWith("---") || line.startsWith("+++")) continue;
      if (line.startsWith("diff ") || line.startsWith("index ")) continue;
      const hm = EXTRACT_HUNK_HEADER_RE.exec(line);
      if (hm) {
        if (current) allHunks.push(current);
        current = {
          oldStart: Number.parseInt(hm[1], 10),
          oldCount: hm[2] ? Number.parseInt(hm[2], 10) : 1,
          newStart: Number.parseInt(hm[3], 10),
          newCount: hm[4] ? Number.parseInt(hm[4], 10) : 1,
          bodyLines: [],
        };
        continue;
      }
      if (current) {
        current.bodyLines.push(line);
      }
    }
    if (current) allHunks.push(current);
  }

  if (allHunks.length === 0) return diffs.join("\n");

  // Sort by old-file start line; later hunks (higher index) win on overlap
  allHunks.sort((a, b) => a.oldStart - b.oldStart);

  // Deduplicate overlapping hunks: keep the later one (last writer wins)
  const merged: Hunk[] = [];
  for (const hunk of allHunks) {
    // Remove any previously-collected hunks that this one fully overlaps
    while (merged.length > 0) {
      const prev = merged[merged.length - 1];
      const prevEnd = prev.oldStart + prev.oldCount;
      if (prevEnd > hunk.oldStart) {
        merged.pop();
      } else {
        break;
      }
    }
    merged.push(hunk);
  }

  const parts: string[] = [];
  for (const hunk of merged) {
    parts.push(
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
    );
    parts.push(...hunk.bodyLines);
  }
  return parts.join("\n");
}

export function parseUnifiedDiffToOldNew(
  diffStr: string,
  options: { preserveHunkGaps?: boolean } = {}
): {
  oldValue: string;
  newValue: string;
  oldStartLine?: number;
  newStartLine?: number;
} {
  const lines = diffStr.split("\n");
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let oldStartLine: number | undefined;
  let newStartLine: number | undefined;
  let oldCursor = 0;
  let newCursor = 0;
  let firstHunk = true;

  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("diff ") || line.startsWith("index ")) continue;

    const hunkMatch = EXTRACT_HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      const hunkOldStart = Number.parseInt(hunkMatch[1], 10);
      const hunkNewStart = Number.parseInt(hunkMatch[3], 10);
      oldStartLine ??= hunkOldStart;
      newStartLine ??= hunkNewStart;
      if (firstHunk) {
        firstHunk = false;
      } else if (options.preserveHunkGaps === true) {
        const oldGap = hunkOldStart - oldCursor;
        const newGap = hunkNewStart - newCursor;
        const gapCount = Math.max(oldGap, newGap, 0);
        for (let i = 0; i < gapCount; i++) {
          if (i < oldGap) oldLines.push("");
          if (i < newGap) newLines.push("");
        }
      }
      oldCursor = hunkOldStart;
      newCursor = hunkNewStart;
      continue;
    }

    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      oldCursor++;
    } else if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      newCursor++;
    } else if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
      oldCursor++;
      newCursor++;
    }
  }
  return {
    oldValue: oldLines.join("\n"),
    newValue: newLines.join("\n"),
    oldStartLine,
    newStartLine,
  };
}

export interface ParsedDiffHunk {
  oldValue: string;
  newValue: string;
  oldStartLine: number;
  newStartLine: number;
}

/**
 * Split a unified diff string into one old/new pair PER HUNK.
 *
 * Unlike {@link parseUnifiedDiffToOldNew}, this does NOT fabricate empty
 * placeholder lines for the gaps between hunks. Each hunk becomes a
 * self-contained old/new pair carrying its own absolute start line, so a
 * multi-hunk diff renders as several adjacent diff regions instead of one
 * editor padded with phantom blank lines (which collapse into a bogus
 * "N unchanged lines" band that expands to nothing).
 */
export function parseUnifiedDiffToHunks(diffStr: string): ParsedDiffHunk[] {
  const lines = diffStr.split("\n");
  const hunks: ParsedDiffHunk[] = [];
  let current: ParsedDiffHunk | null = null;
  let oldBuf: string[] = [];
  let newBuf: string[] = [];

  const flush = () => {
    if (!current) return;
    current.oldValue = oldBuf.join("\n");
    current.newValue = newBuf.join("\n");
    hunks.push(current);
    current = null;
    oldBuf = [];
    newBuf = [];
  };

  for (const line of lines) {
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("diff ") || line.startsWith("index ")) continue;

    const hunkMatch = EXTRACT_HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      flush();
      current = {
        oldValue: "",
        newValue: "",
        oldStartLine: Number.parseInt(hunkMatch[1], 10),
        newStartLine: Number.parseInt(hunkMatch[3], 10),
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("-")) {
      oldBuf.push(line.slice(1));
    } else if (line.startsWith("+")) {
      newBuf.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      oldBuf.push(line.slice(1));
      newBuf.push(line.slice(1));
    }
  }
  flush();

  return hunks;
}
