/**
 * Shared Language Extension Mapping for CodeMirror
 *
 * Provides language detection and extension loading for all CodeMirror components.
 * Deduplicates the language mapping logic used across Editor, Diff, and ConflictEditor.
 */
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { StreamLanguage } from "@codemirror/language";
import { dart as dartMode } from "@codemirror/legacy-modes/mode/clike";
import { go as goMode } from "@codemirror/legacy-modes/mode/go";
import { Extension } from "@codemirror/state";

import { createLogger } from "@src/hooks/logger";

const log = createLogger("CodeMirror");

// ============================================
// File Extension to Language Mapping
// ============================================

export const EXT_TO_LANG_MAP: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  java: "java",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  c: "c",
  h: "cpp",
  hpp: "cpp",
  rs: "rust",
  go: "go",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  dart: "dart",
};

// ============================================
// Language Key Detection
// ============================================

/**
 * Get language key from file path or language prop
 */
export function getLanguageKey(
  filePath?: string,
  language?: string
): string | null {
  if (language) {
    return language.toLowerCase();
  }
  if (filePath) {
    const ext = filePath.split(".").pop()?.toLowerCase();
    if (ext) {
      return EXT_TO_LANG_MAP[ext] || null;
    }
  }
  return null;
}

// ============================================
// Synchronous Language Extension Loading
// ============================================

// Cache is bounded by the closed set of language keys in EXT_TO_LANG_MAP
// (~15 entries). Max-size guard protects against future uncontrolled growth.
const LANG_CACHE_MAX = 64;

function langCacheSet(
  cache: Map<string, Extension>,
  key: string,
  value: Extension
): void {
  if (cache.size >= LANG_CACHE_MAX) {
    cache.delete(cache.keys().next().value ?? "");
  }
  cache.set(key, value);
}

const allLangExtensionCache = new Map<string, Extension>();

/**
 * Get the appropriate CodeMirror language extension based on file path or language.
 * Loads all languages synchronously (for components that don't support async).
 * Results are cached by langKey to avoid recreating extensions.
 */
export function getLanguageExtension(
  filePath?: string,
  language?: string
): Extension | null {
  const langKey = getLanguageKey(filePath, language);
  if (!langKey) return null;

  const cached = allLangExtensionCache.get(langKey);
  if (cached) return cached;

  let ext: Extension | null = null;
  switch (langKey) {
    case "javascript":
      ext = javascript();
      break;
    case "jsx":
      ext = javascript({ jsx: true });
      break;
    case "typescript":
      ext = javascript({ typescript: true });
      break;
    case "tsx":
      ext = javascript({ jsx: true, typescript: true });
      break;
    case "python":
      ext = python();
      break;
    case "java":
      ext = java();
      break;
    case "cpp":
    case "c":
      ext = cpp();
      break;
    case "rust":
      ext = rust();
      break;
    case "html":
      ext = html();
      break;
    case "css":
    case "scss":
      ext = css();
      break;
    case "json":
      ext = json();
      break;
    case "markdown":
      ext = markdown();
      break;
    case "dart":
      ext = StreamLanguage.define(dartMode);
      break;
    case "go":
      ext = StreamLanguage.define(goMode);
      break;
    default:
      return null;
  }

  if (ext) {
    langCacheSet(allLangExtensionCache, langKey, ext);
  }
  return ext;
}

// ============================================
// Synchronous JS/TS Only (Always Loaded)
// ============================================

const syncExtensionCache = new Map<string, Extension>();

/**
 * Synchronously get language extension for JS/TS only (always loaded).
 * Use this when you want to lazy-load other languages.
 * Results are cached by langKey to avoid recreating extensions.
 */
export function getLanguageExtensionSync(langKey: string): Extension | null {
  const cached = syncExtensionCache.get(langKey);
  if (cached) return cached;

  let ext: Extension | null = null;
  switch (langKey) {
    case "javascript":
      ext = javascript();
      break;
    case "jsx":
      ext = javascript({ jsx: true });
      break;
    case "typescript":
      ext = javascript({ typescript: true });
      break;
    case "tsx":
      ext = javascript({ jsx: true, typescript: true });
      break;
    default:
      return null;
  }

  if (ext) {
    langCacheSet(syncExtensionCache, langKey, ext);
  }
  return ext;
}

// ============================================
// Lazy Loading for Other Languages
// ============================================

// Cache for loaded language extensions
const languageExtensionCache = new Map<string, Extension>();

/**
 * Lazy load language extension (for non-JS languages).
 * Returns cached extension if already loaded.
 */
export async function loadLanguageExtension(
  langKey: string
): Promise<Extension | null> {
  // Check cache first
  const cached = languageExtensionCache.get(langKey);
  if (cached) return cached;

  let ext: Extension | null = null;

  try {
    switch (langKey) {
      case "python": {
        const { python: pythonLang } = await import("@codemirror/lang-python");
        ext = pythonLang();
        break;
      }
      case "java": {
        const { java: javaLang } = await import("@codemirror/lang-java");
        ext = javaLang();
        break;
      }
      case "cpp":
      case "c": {
        const { cpp: cppLang } = await import("@codemirror/lang-cpp");
        ext = cppLang();
        break;
      }
      case "rust": {
        const { rust: rustLang } = await import("@codemirror/lang-rust");
        ext = rustLang();
        break;
      }
      case "html": {
        const { html: htmlLang } = await import("@codemirror/lang-html");
        ext = htmlLang();
        break;
      }
      case "css":
      case "scss": {
        const { css: cssLang } = await import("@codemirror/lang-css");
        ext = cssLang();
        break;
      }
      case "json": {
        const { json: jsonLang } = await import("@codemirror/lang-json");
        ext = jsonLang();
        break;
      }
      case "markdown": {
        const { markdown: mdLang } = await import("@codemirror/lang-markdown");
        ext = mdLang();
        break;
      }
      case "dart": {
        const { dart: dartMode } =
          await import("@codemirror/legacy-modes/mode/clike");
        ext = StreamLanguage.define(dartMode);
        break;
      }
      case "go": {
        const { go: goMode } = await import("@codemirror/legacy-modes/mode/go");
        ext = StreamLanguage.define(goMode);
        break;
      }
    }
  } catch (error) {
    log.warn(
      `[CodeMirror] Failed to load language extension for ${langKey}:`,
      error
    );
    return null;
  }

  if (ext) {
    langCacheSet(languageExtensionCache, langKey, ext);
  }

  return ext;
}
