/**
 * Shared Shiki Syntax Highlighting Hook
 *
 * Centralized hook for syntax highlighting with:
 * - Shared cache across all components (memory optimization)
 * - Cancellation handling for rapid updates
 * - Graceful fallback on errors
 *
 * Replaces duplicate implementations in:
 * - EventSystem/events/RunCommand/index.tsx
 * - EventBlocks/TerminalBlock/index.tsx
 * - WorkspaceCenter/Content/Planner/TimelineTab/TerminalCommandView.tsx
 */
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { createBundledHighlighter, makeSingletonHighlighter } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import { createLogger } from "@src/hooks/logger";
import { isDarkThemeAtom } from "@src/store/ui/uiAtom";

const logger = createLogger("ShikiHighlight");

const shikiLanguages = {
  css: () =>
    import(/* webpackChunkName: "shiki-lang-css" */ "shiki/langs/css.mjs"),
  diff: () =>
    import(/* webpackChunkName: "shiki-lang-diff" */ "shiki/langs/diff.mjs"),
  dockerfile: () =>
    import(
      /* webpackChunkName: "shiki-lang-dockerfile" */ "shiki/langs/dockerfile.mjs"
    ),
  go: () =>
    import(/* webpackChunkName: "shiki-lang-go" */ "shiki/langs/go.mjs"),
  html: () =>
    import(/* webpackChunkName: "shiki-lang-html" */ "shiki/langs/html.mjs"),
  javascript: () =>
    import(
      /* webpackChunkName: "shiki-lang-javascript" */ "shiki/langs/javascript.mjs"
    ),
  json: () =>
    import(/* webpackChunkName: "shiki-lang-json" */ "shiki/langs/json.mjs"),
  jsx: () =>
    import(/* webpackChunkName: "shiki-lang-jsx" */ "shiki/langs/jsx.mjs"),
  log: () =>
    import(/* webpackChunkName: "shiki-lang-log" */ "shiki/langs/log.mjs"),
  markdown: () =>
    import(
      /* webpackChunkName: "shiki-lang-markdown" */ "shiki/langs/markdown.mjs"
    ),
  python: () =>
    import(
      /* webpackChunkName: "shiki-lang-python" */ "shiki/langs/python.mjs"
    ),
  rust: () =>
    import(/* webpackChunkName: "shiki-lang-rust" */ "shiki/langs/rust.mjs"),
  shellscript: () =>
    import(
      /* webpackChunkName: "shiki-lang-shellscript" */ "shiki/langs/shellscript.mjs"
    ),
  sql: () =>
    import(/* webpackChunkName: "shiki-lang-sql" */ "shiki/langs/sql.mjs"),
  tsx: () =>
    import(/* webpackChunkName: "shiki-lang-tsx" */ "shiki/langs/tsx.mjs"),
  typescript: () =>
    import(
      /* webpackChunkName: "shiki-lang-typescript" */ "shiki/langs/typescript.mjs"
    ),
  yaml: () =>
    import(/* webpackChunkName: "shiki-lang-yaml" */ "shiki/langs/yaml.mjs"),
};

const shikiThemes = {
  "github-light": () =>
    import(
      /* webpackChunkName: "shiki-theme-github-light" */ "shiki/themes/github-light.mjs"
    ),
  "one-dark-pro": () =>
    import(
      /* webpackChunkName: "shiki-theme-one-dark-pro" */ "shiki/themes/one-dark-pro.mjs"
    ),
};

type SupportedShikiLanguage = keyof typeof shikiLanguages;
type SupportedShikiTheme = keyof typeof shikiThemes;

const shikiLanguageAliases: Record<string, SupportedShikiLanguage> = {
  bash: "shellscript",
  cjs: "javascript",
  js: "javascript",
  jsonc: "json",
  jsx: "jsx",
  mjs: "javascript",
  md: "markdown",
  py: "python",
  rs: "rust",
  sh: "shellscript",
  shell: "shellscript",
  ts: "typescript",
  tsx: "tsx",
  txt: "log",
  yml: "yaml",
  zsh: "shellscript",
};

function resolveSupportedLanguage(lang: string): SupportedShikiLanguage | null {
  const normalized = lang.trim().toLowerCase();
  if (!normalized || normalized === "text" || normalized === "plain") {
    return null;
  }

  if (normalized in shikiLanguages) {
    return normalized as SupportedShikiLanguage;
  }

  return shikiLanguageAliases[normalized] ?? null;
}

function resolveSupportedTheme(
  theme: string,
  fallback: SupportedShikiTheme
): SupportedShikiTheme {
  return theme in shikiThemes ? (theme as SupportedShikiTheme) : fallback;
}

const getSingletonHighlighter = makeSingletonHighlighter(
  createBundledHighlighter({
    langs: shikiLanguages,
    themes: shikiThemes,
    engine: createJavaScriptRegexEngine,
  })
);

// Resolve the highlighter once with the JS regex engine (no WASM) so webpack
// production builds don't fail on `import('shiki/wasm')` dynamic imports that
// the default bundle-full shorthands rely on.
const highlighterPromise = getSingletonHighlighter({
  langs: [],
  themes: [],
});

// ============================================
// Shared Cache
// ============================================

const MAX_CACHE_SIZE = 500;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_CACHEABLE_CODE_BYTES = 64 * 1024;
const HASH_SEED = 0x811c9dc5;
const HASH_MULTIPLIER = 0x01000193;

const textEncoder = new TextEncoder();
const highlightCache = new Map<string, { html: string; bytes: number }>();
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

function getCacheKey(code: string, lang: string, theme: string): string {
  return `${lang}:${theme}:${code.length}:${getStableHash(code)}`;
}

function getCacheEligibility(code: string): {
  cacheable: boolean;
  bytes: number;
} {
  const bytes = getByteLength(code);
  return { cacheable: bytes <= MAX_CACHEABLE_CODE_BYTES, bytes };
}

function evictOldestCacheEntry(): void {
  const firstKey = highlightCache.keys().next().value;
  if (!firstKey) return;

  const entry = highlightCache.get(firstKey);
  if (entry) {
    highlightCacheBytes -= entry.bytes;
  }
  highlightCache.delete(firstKey);
}

function getCachedHighlight(key: string): string | undefined {
  return highlightCache.get(key)?.html;
}

function addToCache(key: string, html: string, codeBytes: number): void {
  const htmlBytes = getByteLength(html);
  const entryBytes = codeBytes + htmlBytes + getByteLength(key);
  if (entryBytes > MAX_CACHE_BYTES) return;

  const existing = highlightCache.get(key);
  if (existing) {
    highlightCacheBytes -= existing.bytes;
  }

  while (
    highlightCache.size >= MAX_CACHE_SIZE ||
    highlightCacheBytes + entryBytes > MAX_CACHE_BYTES
  ) {
    evictOldestCacheEntry();
  }

  highlightCache.set(key, { html, bytes: entryBytes });
  highlightCacheBytes += entryBytes;
}

// ============================================
// Hook
// ============================================

export interface UseShikiHighlightOptions {
  /** Programming language for syntax highlighting */
  lang?: string;
  /** Color theme */
  theme?: string;
  /** Whether highlighting is enabled (for conditional use) */
  enabled?: boolean;
}

/**
 * Hook for syntax highlighting code with Shiki
 *
 * @param code - Code string to highlight
 * @param options - Configuration options
 * @returns HTML string with syntax highlighting
 *
 * @example
 * ```tsx
 * const highlightedHtml = useShikiHighlight(command, { lang: 'shellscript' });
 *
 * return (
 *   <div dangerouslySetInnerHTML={{ __html: highlightedHtml || command }} />
 * );
 * ```
 */
export function useShikiHighlight(
  code: string,
  options: UseShikiHighlightOptions = {}
): string {
  const isDark = useAtomValue(isDarkThemeAtom);
  const defaultTheme: SupportedShikiTheme = isDark
    ? "one-dark-pro"
    : "github-light";

  const {
    lang = "shellscript",
    theme = defaultTheme,
    enabled = true,
  } = options;
  const resolvedLang = resolveSupportedLanguage(lang);
  const resolvedTheme = resolveSupportedTheme(theme, defaultTheme);

  // Store the resolved result as { key, html } so that stale HTML from a
  // previous theme/code/lang is never returned: if the stored key does not
  // match the current key, we treat the result as empty and wait for the
  // next async resolution.
  const [result, setResult] = useState<{ key: string; html: string } | null>(
    null
  );

  const cacheEligibility = getCacheEligibility(code);
  const cacheKey =
    !code || !enabled || !resolvedLang || !cacheEligibility.cacheable
      ? ""
      : getCacheKey(code, resolvedLang, resolvedTheme);
  const resultKey =
    !code || !enabled || !resolvedLang
      ? ""
      : `${resolvedLang}:${resolvedTheme}:${code.length}:${getStableHash(code)}`;

  useEffect(() => {
    if (!code || !enabled || !resolvedLang) return;

    const cached = cacheKey ? getCachedHighlight(cacheKey) : undefined;
    if (cached) {
      queueMicrotask(() =>
        setResult((prev) =>
          prev?.key === resultKey && prev.html === cached
            ? prev
            : { key: resultKey, html: cached }
        )
      );
      return;
    }

    let cancelled = false;

    highlighterPromise
      .then(async (hl) => {
        await hl.loadLanguage(resolvedLang);
        await hl.loadTheme(resolvedTheme);
        return hl.codeToHtml(code, {
          lang: resolvedLang,
          theme: resolvedTheme,
        });
      })
      .then((html) => {
        if (!cancelled) {
          if (cacheKey) {
            addToCache(cacheKey, html, cacheEligibility.bytes);
          }
          setResult({ key: resultKey, html });
        }
      })
      .catch((err: unknown) => {
        logger.warn("highlight failed:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [
    cacheEligibility.bytes,
    cacheKey,
    code,
    enabled,
    resolvedLang,
    resolvedTheme,
    resultKey,
  ]);

  if (!code || !enabled || !resolvedLang) return "";
  // Only return HTML when the key matches; otherwise fall back to plain text
  // so stale dark-theme colors are never painted on a light background.
  return result?.key === resultKey ? result.html : "";
}

// ============================================
// Cache Management Utilities
// ============================================

/**
 * Clear the entire highlight cache
 * Useful for theme changes or memory management
 */
export function clearHighlightCache(): void {
  highlightCache.clear();
  highlightCacheBytes = 0;
}

/**
 * Get current cache size
 */
export function getHighlightCacheSize(): number {
  return highlightCache.size;
}

/**
 * Pre-warm cache with common code snippets
 * Call during idle time for better UX
 */
export async function preWarmCache(
  snippets: Array<{ code: string; lang?: string; theme?: string }>
): Promise<void> {
  const defaultTheme: SupportedShikiTheme = "one-dark-pro";
  const hl = await highlighterPromise;

  for (const snippet of snippets) {
    const resolvedLang = resolveSupportedLanguage(
      snippet.lang || "shellscript"
    );
    if (!resolvedLang) continue;

    const resolvedTheme = resolveSupportedTheme(
      snippet.theme || defaultTheme,
      defaultTheme
    );
    const cacheEligibility = getCacheEligibility(snippet.code);
    if (!cacheEligibility.cacheable) continue;

    const cacheKey = getCacheKey(snippet.code, resolvedLang, resolvedTheme);

    if (!highlightCache.has(cacheKey)) {
      try {
        await hl.loadLanguage(resolvedLang);
        await hl.loadTheme(resolvedTheme);
        const result = hl.codeToHtml(snippet.code, {
          lang: resolvedLang,
          theme: resolvedTheme,
        });
        addToCache(cacheKey, result, cacheEligibility.bytes);
      } catch {
        // Ignore errors during pre-warming
      }
    }
  }
}

export default useShikiHighlight;
