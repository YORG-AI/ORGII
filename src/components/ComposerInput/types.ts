/**
 * ComposerInput Types
 *
 * Shared types for the lightweight composer input used across SessionCreator
 * and ChatPanel. The wire-level shape mirrors the previous editor ref contract
 * so the surrounding hooks
 * (`useComposerInput`, `useAddToAgentInsertion`, `useDraftManagement`,
 * `useSlashCommand`, `inputPreparation`, `useInputFormatter`, etc.) keep
 * working without ProseMirror.
 */
/**
 * Icon type for special pill items. Drives icon rendering in `ComposerPill`
 * and how `serializePillNode` formats the agent-side payload.
 */
export type PillIconType =
  | "file"
  | "folder"
  | "terminal"
  | "session"
  | "browser"
  | "repo"
  | "branch"
  | "project"
  | "workitem"
  | "dom-element"
  | "dom-component"
  | "skill"
  | "member"
  | "paste"
  | "pr"
  | "issue";

/**
 * Persisted pill payload. This is the canonical, in-memory description of a
 * pill. The DOM serialization mirrors the same keys via `data-*` attributes
 * so a snapshot round-trip preserves the pill exactly.
 */
export interface ComposerPillAttrs {
  filePath: string;
  fileName: string;
  isFolder: boolean;
  iconType: PillIconType | null;
  lineStart: number | null;
  lineEnd: number | null;
}

export interface ComposerInputProps {
  /** Placeholder text shown while the editor is empty */
  placeholder?: string;
  /**
   * Ghost text rendered inline after the last content node (e.g.
   * "<optional focus for the summary>" behind a /compact pill). Purely
   * decorative — not part of the document, never serialized.
   */
  trailingHint?: string | null;
  /** Initial plain text content */
  initialContent?: string;
  /** Fires after every editable change (post-sanitization) */
  onContentChange?: (text: string) => void;
  /** Called when the user types `@` (or `triggerAtMention()` is invoked) */
  onAtMention?: (
    query: string,
    cursorPosition: { x: number; y: number }
  ) => void;
  /** Called when the `@` mention session closes (space / Esc / cursor moved) */
  onAtMentionClose?: () => void;
  /** Called when the user submits via Enter / Cmd+Enter */
  onSubmit?: (text: string) => void;
  /** When true, only Cmd/Ctrl+Enter submits; bare Enter inserts a newline */
  requireCmdEnter?: boolean;
  /** Auto-focus the editor on mount (focus is placed at the end) */
  autoFocus?: boolean;
  /** Extra class on the root */
  className?: string;
  /** Min/max heights (px or CSS size) — applied as inline style */
  minHeight?: number | string;
  maxHeight?: number | string;
  /**
   * Root overflow-y. The compact chat row should use `visible` so WebKit
   * still paints the caret after a pill ↔ stacked layout swap.
   */
  overflowY?: "auto" | "hidden" | "visible";
  /** Whether the editor accepts input */
  editable?: boolean;
  /** Keyboard handler that the @-dropdown can claim for navigation */
  onKeyDownForDropdown?: (event: KeyboardEvent) => boolean;
  /** Called when the user types `/` for a command/context trigger */
  onSlashCommand?: (query: string) => void;
  /** Called when the slash trigger session closes */
  onSlashCommandClose?: () => void;
  /** Keyboard handler for the slash-trigger dropdown */
  onKeyDownForSlashDropdown?: (event: KeyboardEvent) => boolean;
  /** Called when the editable surface receives a pointer down. */
  onInputMouseDown?: () => void;
  /**
   * Slash behavior for command vs context surfaces.
   */
  slashTriggerMode?: "command" | "context";
  /** Called for clipboard image attachments */
  onImagePaste?: (files: File[]) => void;
  /**
   * Called synchronously inside the keydown handler before a Shift+Enter
   * newline is inserted, so the host can expand the layout eagerly.
   */
  onBeforeNewline?: () => void;
}

/**
 * Opaque snapshot used to round-trip composer state across an in-flight
 * submit so we can restore the editor (text + pills + line ranges) if the
 * request fails. Returned from `getSnapshot()`; consumed by `setContent()`.
 */
export interface ComposerSnapshot {
  /** Linear sequence of text nodes and pill references, in DOM order. */
  parts: Array<
    | { kind: "text"; text: string }
    | { kind: "newline" }
    | { kind: "pill"; attrs: ComposerPillAttrs }
  >;
}

export interface ComposerInputRef {
  /** Plain text content (pills serialized as their display name) */
  getText: () => string;
  /** Text with pills serialized as `displayName [type:path]` for agent input */
  getTextWithPills: () => string;
  /** Map of terminal/session/browser pill paths → stored pill text */
  getTerminalPillTexts: () => Record<string, string>;
  /** Plain-text snapshot retained for callers that still use the HTML-era name */
  getHTML: () => string;
  /** Structured snapshot of the editor (text + pills) for restore-on-error */
  getSnapshot: () => ComposerSnapshot;
  /**
   * Replace contents. Accepts a plain string (resets to plain text) or a
   * structured snapshot returned by `getSnapshot()` (restores pills too).
   */
  setContent: (content: string | ComposerSnapshot) => void;
  /** Wipe the editor */
  clear: () => void;
  /** Focus the editor (caret at end) */
  focus: () => void;
  /** Move the caret to a viewport coordinate inside the editor */
  placeCaretAtPoint: (x: number, y: number) => boolean;
  /** True if the editor has no text and no pills */
  isEmpty: () => boolean;
  /** True while an inline @ or / menu is active. */
  isInlineMenuActive: () => boolean;
  /** Insert plain mention text, replacing the active @ query if present. */
  insertMentionText: (text: string) => void;
  /** Insert a file/folder pill at the current selection */
  insertFilePill: (
    filePath: string,
    isFolder?: boolean,
    iconType?: PillIconType,
    displayName?: string
  ) => void;
  /**
   * Insert a pill at the very beginning of the editor, preserving any
   * existing content that follows it. A trailing space is added after the
   * pill so the user's prior text starts right after it.
   */
  prependFilePill: (
    filePath: string,
    isFolder?: boolean,
    iconType?: PillIconType,
    displayName?: string
  ) => void;
  /**
   * Append a pill at the very end of the editor, after any existing content.
   * A leading space is added before the pill when the editor is non-empty so
   * it reads as a separate token from the user's prior text.
   */
  appendFilePill: (
    filePath: string,
    isFolder?: boolean,
    iconType?: PillIconType,
    displayName?: string
  ) => void;
  /** Insert a file-reference pill with an attached line range */
  insertFileReference: (options: {
    filePath: string;
    fileName?: string;
    lineStart: number;
    lineEnd: number;
  }) => void;
  /** Remove the first pill matching the given path */
  removeFilePill: (filePath: string) => void;
  /** Snapshot of every pill in the document, in DOM order */
  getFilePills: () => Array<{
    filePath: string;
    fileName: string;
    lineStart?: number;
    lineEnd?: number;
  }>;
  /**
   * Small façade that supports `chain().focus().insertContent(...)` for
   * existing callers that need imperative insertion. Returns `null` if the
   * editor is not mounted.
   */
  getEditor: () => ComposerEditorFacade | null;
  /**
   * Insert a PR reference pill. Stores the full PR data in the pill cache
   * keyed by `pr://{prNumber}` so it can be retrieved at submit time.
   */
  insertPrPill: (prData: {
    prNumber: number;
    prTitle: string;
    prUrl: string;
    prStatus: string;
    sourceBranch?: string;
    targetBranch?: string;
    additions?: number;
    deletions?: number;
  }) => void;
  /** Open the @ mention menu without a typed `@` character */
  triggerAtMention: () => void;
  /** Open the slash context menu without a typed `/` character */
  triggerSlashContext: () => void;
  /**
   * Delete the slash trigger character + query that opened the command
   * popover, without clearing the rest of the composer content.
   * Call this when confirming a slash-command selection (e.g. mode pick)
   * so only the `/query` token is removed and prior text is preserved.
   */
  consumeSlashQuery: () => void;
}

/**
 * Chainable façade returned by `getEditor()`. Only the surface that existing
 * callers (`useComposerInput.handleAtMentionClick`, `useSlashCommand`) use is
 * implemented — there is no general editor command surface.
 */
export interface ComposerEditorFacade {
  chain: () => ComposerEditorChain;
  commands: {
    focus: (position?: "end" | "start") => boolean;
  };
}

export interface ComposerEditorChain {
  focus: () => ComposerEditorChain;
  insertContent: (content: string) => ComposerEditorChain;
  run: () => boolean;
}
