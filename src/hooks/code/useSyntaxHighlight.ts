/**
 * Shared syntax-highlighting hook (HTML-string output).
 *
 * Highlights through the app's single Prism engine (`src/util/language/
 * prismHtml.ts`), loaded on first use through `./prismHtmlLoader` so the
 * grammar set stays out of the startup graph and out of the transcript row
 * components that call this hook.
 *
 * - One shared, byte-bounded cache across every caller.
 * - Results are keyed by language + code, never by theme: the returned
 *   markup carries `.token.*` classes that `src/styles/prism-tokens.scss`
 *   colors from the active theme's `--cm-syntax-*` tokens, so a theme
 *   switch repaints without re-highlighting.
 * - Returns `""` until the engine is loaded / while the language is
 *   unsupported, so callers fall back to plain text (never stale markup).
 */
import { useEffect, useState } from "react";

import { createLogger } from "@src/hooks/logger";

import { loadPrismHtml } from "./prismHtmlLoader";

const logger = createLogger("SyntaxHighlight");

// ============================================
// Shared cache
// ============================================

const MAX_CACHE_SIZE = 500;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_CACHEABLE_CODE_BYTES = 64 * 1024;
const HASH_SEED = 0x811c9dc5;
const HASH_MULTIPLIER = 0x01000193;

const textEncoder = new TextEncoder();
interface HighlightCacheEntry {
  source: string;
  html: string;
  bytes: number;
}

const highlightCache = new Map<string, HighlightCacheEntry>();
let highlightCacheBytes = 0;

function getByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function getStableHash(value: string): string {
  let hash = HASH_SEED;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, HASH_MULTIPLIER);
  }
  return (hash >>> 0).toString(36);
}

function getResultKey(code: string, lang: string): string {
  return `${lang}:${code.length}:${getStableHash(code)}`;
}

function evictOldestCacheEntry(): void {
  const firstKey = highlightCache.keys().next().value;
  if (!firstKey) return;
  const entry = highlightCache.get(firstKey);
  if (entry) highlightCacheBytes -= entry.bytes;
  highlightCache.delete(firstKey);
}

function addToCache(
  key: string,
  source: string,
  html: string,
  codeBytes: number
): void {
  const entryBytes = codeBytes + getByteLength(html) + getByteLength(key);
  if (entryBytes > MAX_CACHE_BYTES) return;

  const existing = highlightCache.get(key);
  if (existing) highlightCacheBytes -= existing.bytes;

  while (
    highlightCache.size >= MAX_CACHE_SIZE ||
    highlightCacheBytes + entryBytes > MAX_CACHE_BYTES
  ) {
    evictOldestCacheEntry();
  }

  // The compact hash key is an index, not an identity guarantee. Retain the
  // exact source so a same-length hash collision can never reuse stale HTML.
  highlightCache.set(key, { source, html, bytes: entryBytes });
  highlightCacheBytes += entryBytes;
}

// ============================================
// Hook
// ============================================

export interface UseSyntaxHighlightOptions {
  /** Language name (Prism canonical name, alias, or file-extension style). */
  lang?: string;
  /** Whether highlighting is enabled (for conditional use). */
  enabled?: boolean;
}

/**
 * Highlight `code` and return its inner HTML (token spans + escaped text,
 * no wrapper element). Returns `""` while loading or when the language is
 * not supported; render the plain text in that case. Wrap the container in
 * the `prism-html` class so the theme rules apply.
 *
 * @example
 * ```tsx
 * const html = useSyntaxHighlight(command, { lang: "bash" });
 * return html
 *   ? <span className="prism-html" dangerouslySetInnerHTML={{ __html: html }} />
 *   : <span>{command}</span>;
 * ```
 */
export function useSyntaxHighlight(
  code: string,
  options: UseSyntaxHighlightOptions = {}
): string {
  const { lang = "bash", enabled = true } = options;
  const normalizedLang = lang.trim().toLowerCase();
  const active = Boolean(code) && enabled && normalizedLang.length > 0;
  const resultKey = active ? getResultKey(code, normalizedLang) : "";

  // Store the exact source alongside the compact key so a hash collision
  // cannot expose markup from another string while highlighting is in flight.
  const [result, setResult] = useState<{
    key: string;
    source: string;
    html: string;
  } | null>(null);

  useEffect(() => {
    if (!active) return;

    const cached = highlightCache.get(resultKey);
    if (cached?.source === code) {
      queueMicrotask(() =>
        setResult((prev) =>
          prev?.key === resultKey &&
          prev.source === code &&
          prev.html === cached.html
            ? prev
            : { key: resultKey, source: code, html: cached.html }
        )
      );
      return;
    }

    let cancelled = false;
    const codeBytes = getByteLength(code);

    loadPrismHtml()
      .then((prism) => {
        if (cancelled) return;
        const html = prism.highlightToHtml(code, normalizedLang);
        if (html === null) {
          // Unsupported language: remember the miss so we don't retry per render.
          if (codeBytes <= MAX_CACHEABLE_CODE_BYTES) {
            addToCache(resultKey, code, "", codeBytes);
          }
          setResult({ key: resultKey, source: code, html: "" });
          return;
        }
        if (codeBytes <= MAX_CACHEABLE_CODE_BYTES) {
          addToCache(resultKey, code, html, codeBytes);
        }
        setResult({ key: resultKey, source: code, html });
      })
      .catch((error: unknown) => {
        logger.warn("highlight failed:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [active, code, normalizedLang, resultKey]);

  if (!active) return "";
  return result?.key === resultKey && result.source === code ? result.html : "";
}

/** Test seam: clear the shared cache. */
export function clearSyntaxHighlightCache(): void {
  highlightCache.clear();
  highlightCacheBytes = 0;
}

export default useSyntaxHighlight;
