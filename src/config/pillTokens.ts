/**
 * Pill Design Tokens
 *
 * Shared styling constants and type definitions for inline context pills.
 * Used by:
 * - ComposerInput (editable composer pills)
 * - InlinePill in UserMessageContent (read-only display pills)
 * - pill serialization utilities
 * - normalizers.ts (pill content stripping)
 * - contextPillContent.ts (pill text storage)
 */
import type { CSSProperties } from "react";

// ==============================================
// Pill Type Definitions
// ==============================================

export const PILL_TYPE_LIST = [
  "file",
  "folder",
  "repo",
  "branch",
  "terminal",
  "session",
  "browser",
  "project",
  "workitem",
  "dom-element",
  "dom-component",
  "skill",
  "paste",
  "pr",
  "issue",
] as const;

export type PillType = (typeof PILL_TYPE_LIST)[number];

export const PILL_TYPES: ReadonlySet<string> = new Set(PILL_TYPE_LIST);

const PILL_TYPE_ALTERNATION = PILL_TYPE_LIST.join("|");

/**
 * Regex to match serialized pills: `displayName [type:path]`
 * Optionally includes base64-encoded content: `displayName [type:path::encoded]`
 */
export const PILL_REGEX = new RegExp(
  `([^[]+?)\\s*\\[(${PILL_TYPE_ALTERNATION}):([^\\]]+)\\]`,
  "g"
);

// ==============================================
// Context Pill Prefixes (terminal, session, browser)
// ==============================================

export const CONTEXT_PILL_PREFIXES: Record<string, string> = {
  terminal: "terminal://",
  browser: "browser://",
  workitem: "workitem://",
  "dom-element": "dom-element://",
  "dom-component": "paste://",
  paste: "paste://",
  pr: "pr://",
  issue: "issue://",
} as const;

/** Pill types that carry async-loaded content stored in the pill cache */
export const CONTEXT_PILL_TYPES: ReadonlySet<string> = new Set(
  Object.keys(CONTEXT_PILL_PREFIXES)
);

// ==============================================
// Regex for stripping injected context from history replay
// ==============================================

/** Matches serialized context pill references like [terminal:terminal://...] */
export const CONTEXT_PILL_REF_REGEX =
  /\[(terminal|browser|dom-element|dom-component|pr|issue):(terminal|browser|dom-element|paste|pr|issue):\/\/[^\]]+\]/;

/** Matches context headers and trace markers injected by the agent pipeline */
export const CONTEXT_TRACE_MARKER_REGEX =
  /(\[Terminal Context\]|\[Browser Context\]|\[Tool:|(?:^|\n)User:\s|(?:^|\n)Agent:\s)/;

// ==============================================
// Pill Text Cache (window.__orgiiTerminalPillTexts)
// ==============================================

const MAX_PILL_CACHE_SIZE = 50;

declare global {
  interface Window {
    __orgiiTerminalPillTexts?: Record<string, string>;
    __orgiiLastTerminalCopy?: {
      sessionId: string;
      sessionName: string;
      lineCount: number;
      text: string;
      timestamp: number;
    };
  }
}

const MAX_PILL_TEXT_LENGTH = 100_000;

/**
 * Cap stored pill text to MAX_PILL_TEXT_LENGTH, keeping the tail so that the
 * most recent output is preserved (e.g. terminal scrollback).
 */
export function capPillText(text: string): string {
  if (text.length <= MAX_PILL_TEXT_LENGTH) return text;
  const capped = text.slice(-MAX_PILL_TEXT_LENGTH);
  const firstNewline = capped.indexOf("\n");
  return firstNewline > 0 ? capped.slice(firstNewline + 1) : capped;
}

/**
 * Store text content for a context pill with FIFO eviction.
 * All callers should use this instead of writing to
 * window.__orgiiTerminalPillTexts directly.
 */
export function storePillText(pillPath: string, text: string): void {
  if (!window.__orgiiTerminalPillTexts) {
    window.__orgiiTerminalPillTexts = {};
  }
  const keys = Object.keys(window.__orgiiTerminalPillTexts);
  if (keys.length >= MAX_PILL_CACHE_SIZE) {
    const oldest = keys[0];
    delete window.__orgiiTerminalPillTexts[oldest];
  }
  window.__orgiiTerminalPillTexts[pillPath] = text;
}

/** Read stored text for a context pill path */
export function readPillText(pillPath: string): string | undefined {
  return window.__orgiiTerminalPillTexts?.[pillPath];
}

// ==============================================
// Dimensions
// ==============================================

export const PILL_SIZE = {
  height: 20,
  iconSize: 14,
  fontSize: 14,
  lineHeight: 20,
  borderRadius: 4,
  gap: 4,
  paddingX: 6,
  marginX: 2,
  marginY: 2,
} as const;

// ==============================================
// Colors (CSS variable references)
// ==============================================

export const PILL_COLORS = {
  background: "var(--color-primary-2)",
  text: "var(--color-text-1)",
  iconDefault: "text-text-2",
} as const;

/** Accent for inline file/repo refs inside editable composers (no pill background). */
export const EDITOR_FILE_PILL_TEXT_COLOR = "var(--color-primary-6)";

// ==============================================
// Composite Styles
// ==============================================

/** Base inline style shared by all pill variants */
export const PILL_BASE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: `${PILL_SIZE.gap}px`,
  height: `${PILL_SIZE.height}px`,
  padding: `0 ${PILL_SIZE.paddingX}px`,
  margin: `${PILL_SIZE.marginY}px ${PILL_SIZE.marginX}px`,
  borderRadius: `${PILL_SIZE.borderRadius}px`,
  fontSize: `${PILL_SIZE.fontSize}px`,
  lineHeight: `${PILL_SIZE.lineHeight}px`,
  whiteSpace: "nowrap",
  verticalAlign: "top",
  backgroundColor: PILL_COLORS.background,
  color: PILL_COLORS.text,
} as const;

/**
 * Editable composer: flat refs with primary-6 text/icon, no filled pill background.
 * Chat history read-only pills keep {@link PILL_BASE_STYLE}.
 */
export const EDITOR_FILE_PILL_BASE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "baseline",
  padding: 0,
  margin: `0 ${PILL_SIZE.marginX}px`,
  borderRadius: 0,
  fontSize: `${PILL_SIZE.fontSize}px`,
  lineHeight: "inherit",
  whiteSpace: "nowrap",
  verticalAlign: "baseline",
  backgroundColor: "transparent",
  color: EDITOR_FILE_PILL_TEXT_COLOR,
} as const;

export const EDITOR_FILE_PILL_ICON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: `${PILL_SIZE.iconSize}px`,
  height: `${PILL_SIZE.iconSize}px`,
  marginRight: `${PILL_SIZE.gap}px`,
  verticalAlign: "-0.125em",
  transform: "translateY(2px)",
};

/** Icon container dimensions */
export const PILL_ICON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: `${PILL_SIZE.iconSize}px`,
  height: `${PILL_SIZE.iconSize}px`,
  flexShrink: 0,
} as const;

/**
 * Line height for text containers that include pills.
 * Matches pill total height (height + vertical margin).
 */
export const PILL_LINE_HEIGHT = `${PILL_SIZE.height + PILL_SIZE.marginY * 2}px`;
