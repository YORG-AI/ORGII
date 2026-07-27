/**
 * Syntax highlighting utilities with caching
 */
import hljs from "highlight.js";

import { MAX_CACHE_SIZE } from "../config";

/** Cache for highlighted lines to prevent re-computation */
interface HighlightCacheEntry {
  html: string;
  bytes: number;
}

const MAX_HIGHLIGHT_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_CACHEABLE_SOURCE_BYTES = 64 * 1024;
const MAX_CACHEABLE_HTML_BYTES = 256 * 1024;
const highlightCache = new Map<string, HighlightCacheEntry>();
let highlightCacheBytes = 0;

function estimatedUtf16Bytes(value: string): number {
  return value.length * 2;
}

function cacheHighlight(cacheKey: string, html: string): void {
  const sourceBytes = estimatedUtf16Bytes(cacheKey);
  const htmlBytes = estimatedUtf16Bytes(html);
  if (
    sourceBytes > MAX_CACHEABLE_SOURCE_BYTES ||
    htmlBytes > MAX_CACHEABLE_HTML_BYTES
  ) {
    return;
  }

  const bytes = sourceBytes + htmlBytes;
  while (
    highlightCache.size >= MAX_CACHE_SIZE ||
    highlightCacheBytes + bytes > MAX_HIGHLIGHT_CACHE_BYTES
  ) {
    const oldestKey = highlightCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = highlightCache.get(oldestKey);
    highlightCache.delete(oldestKey);
    highlightCacheBytes -= oldest?.bytes ?? 0;
  }
  highlightCache.set(cacheKey, { html, bytes });
  highlightCacheBytes += bytes;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}

/**
 * Highlight a single line of code with caching
 */
export function highlightLine(content: string, language?: string): string {
  if (!content.trim() || !language) {
    return escapeHtml(content);
  }
  if (estimatedUtf16Bytes(content) > MAX_CACHEABLE_SOURCE_BYTES) {
    return escapeHtml(content);
  }

  // Create cache key
  const cacheKey = `${language}:${content}`;

  // Check cache
  const cached = highlightCache.get(cacheKey);
  if (cached) {
    highlightCache.delete(cacheKey);
    highlightCache.set(cacheKey, cached);
    return cached.html;
  }

  try {
    const result = hljs.highlight(content, {
      language,
      ignoreIllegals: true,
    });

    cacheHighlight(cacheKey, result.value);

    return result.value;
  } catch {
    // Fallback to escaped HTML if highlighting fails
    return escapeHtml(content);
  }
}

/** Narrow test seam for the byte-aware cache contract. */
export const syntaxHighlightCacheTestApi = {
  stats(): { entries: number; bytes: number } {
    return { entries: highlightCache.size, bytes: highlightCacheBytes };
  },
  reset(): void {
    highlightCache.clear();
    highlightCacheBytes = 0;
  },
  limits: {
    entries: MAX_CACHE_SIZE,
    bytes: MAX_HIGHLIGHT_CACHE_BYTES,
    sourceBytes: MAX_CACHEABLE_SOURCE_BYTES,
    htmlBytes: MAX_CACHEABLE_HTML_BYTES,
  },
};
