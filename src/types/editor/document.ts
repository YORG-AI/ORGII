/**
 * Document State Types
 *
 * VSCode-style document versioning with edit source attribution.
 * Enables AI vs human tracking, LSP sync, and conflict detection.
 *
 * Created: 2026-01-21
 */

// ============================================
// Edit Source Attribution
// ============================================

/**
 * Tracks the source of each edit operation
 */
export type EditSource =
  | { type: "human" }
  | { type: "ai"; model: string; sessionId: string }
  | { type: "external" } // Git checkout, other editors, build tools
  | { type: "reload" }; // File reload from disk

// ============================================
// Edit Operation
// ============================================

/**
 * Individual edit operation with attribution and versioning
 */
export interface EditOperation {
  /** Unique ID for this edit */
  id: string;

  /** Range affected by the edit */
  range: {
    from: number;
    to: number;
  };

  /**
   * Text inserted by this edit, cut to `MAX_EDIT_OPERATION_TEXT_CHARS`.
   * Compare `insertedLength` (or check `truncated`) before treating it as
   * the complete insertion.
   */
  newText: string;

  /** Length of the full inserted text; equals `newText.length` unless `truncated`. */
  insertedLength: number;

  /** Present when `newText` was cut to `MAX_EDIT_OPERATION_TEXT_CHARS`. */
  truncated?: true;

  /** Source of the edit */
  source: EditSource;

  /** Timestamp when edit occurred */
  timestamp: number;

  /** Document version after this edit was applied */
  versionAfter: number;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Filter edits by source type
 */
export function filterEditsBySource(
  edits: EditOperation[],
  sourceType: EditSource["type"]
): EditOperation[] {
  return edits.filter((edit) => edit.source.type === sourceType);
}

/**
 * Get AI-sourced edits
 */
export function getAIEdits(edits: EditOperation[]): EditOperation[] {
  return filterEditsBySource(edits, "ai");
}

/**
 * Get human-sourced edits
 */
export function getHumanEdits(edits: EditOperation[]): EditOperation[] {
  return filterEditsBySource(edits, "human");
}

/**
 * Get external edits (git, other editors)
 */
export function getExternalEdits(edits: EditOperation[]): EditOperation[] {
  return filterEditsBySource(edits, "external");
}

/**
 * Upper bound on the inserted text retained per edit operation.
 *
 * `recentEdits` is a rolling attribution log, not an undo stack (CodeMirror
 * owns undo), so an entry only needs enough of its insertion to attribute it.
 * Without a cap a paste or a reload pins the whole pasted/loaded text for as
 * long as the entry stays in the log.
 */
export const MAX_EDIT_OPERATION_TEXT_CHARS = 4096;

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

export interface MinimalEdit {
  range: { from: number; to: number };
  newText: string;
}

/**
 * Compute the smallest single-range edit that turns `previous` into `next`:
 * the common prefix and suffix are trimmed and only the changed span is kept.
 * The boundaries never split a UTF-16 surrogate pair, so `newText` is always
 * a well-formed string on its own.
 */
export function computeMinimalEdit(
  previous: string,
  next: string
): MinimalEdit {
  const previousLength = previous.length;
  const nextLength = next.length;
  const maxPrefix = Math.min(previousLength, nextLength);

  let prefix = 0;
  while (
    prefix < maxPrefix &&
    previous.charCodeAt(prefix) === next.charCodeAt(prefix)
  ) {
    prefix += 1;
  }
  if (prefix > 0 && isHighSurrogate(previous.charCodeAt(prefix - 1))) {
    prefix -= 1;
  }

  const maxSuffix = maxPrefix - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    previous.charCodeAt(previousLength - 1 - suffix) ===
      next.charCodeAt(nextLength - 1 - suffix)
  ) {
    suffix += 1;
  }
  if (
    suffix > 0 &&
    isLowSurrogate(previous.charCodeAt(previousLength - suffix))
  ) {
    suffix -= 1;
  }

  return {
    range: { from: prefix, to: previousLength - suffix },
    newText: next.slice(prefix, nextLength - suffix),
  };
}

/**
 * Create a new edit operation. `newText` is retained up to
 * `MAX_EDIT_OPERATION_TEXT_CHARS`; the full length survives in
 * `insertedLength` so attribution can still reason about the edit's size.
 */
export function createEditOperation(
  range: { from: number; to: number },
  newText: string,
  source: EditSource,
  versionAfter: number
): EditOperation {
  const insertedLength = newText.length;
  let retainedText = newText;
  if (insertedLength > MAX_EDIT_OPERATION_TEXT_CHARS) {
    let cut = MAX_EDIT_OPERATION_TEXT_CHARS;
    if (isHighSurrogate(newText.charCodeAt(cut - 1))) {
      cut -= 1;
    }
    retainedText = newText.slice(0, cut);
  }
  const edit: EditOperation = {
    id: crypto.randomUUID(),
    range,
    newText: retainedText,
    insertedLength,
    source,
    timestamp: Date.now(),
    versionAfter,
  };
  if (retainedText.length !== insertedLength) {
    edit.truncated = true;
  }
  return edit;
}

/**
 * Create an edit operation describing the change from `previous` to `next`
 * without retaining either document: only the changed span is stored.
 */
export function createMinimalEditOperation(
  previous: string,
  next: string,
  source: EditSource,
  versionAfter: number
): EditOperation {
  const { range, newText } = computeMinimalEdit(previous, next);
  return createEditOperation(range, newText, source, versionAfter);
}
