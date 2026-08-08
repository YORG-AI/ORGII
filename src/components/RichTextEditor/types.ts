import type { JSONContent } from "@tiptap/react";

import type { PillIconType } from "@src/components/ComposerInput";
import type { DropdownPosition } from "@src/components/Dropdown/types";

export interface RichTextEditorRef {
  getText: () => string;
  getHTML: () => string;
  getJSON: () => JSONContent | undefined;
  getMarkdown: () => string;
  setContent: (content: string | JSONContent) => void;
  clear: () => void;
  focus: () => void;
  isEmpty: () => boolean;
  insertImage: (src: string, alt?: string) => void;
  insertFilePill: (
    filePath: string,
    isFolder?: boolean,
    iconType?: PillIconType,
    displayName?: string
  ) => void;
  removeFilePill: (filePath: string) => void;
  getFilePills: () => Array<{ filePath: string; fileName: string }>;
  insertText: (
    text: string,
    options?: {
      separateFromAdjacentText?: boolean;
      /**
       * Viewport coordinates of the drop point, when insertion is triggered
       * by a drag-and-drop. Resolved to a document position via
       * `editor.view.posAtCoords` so the reference lands where it was
       * dropped instead of replacing whatever the caret/selection happened
       * to be. Omit (or when resolution fails) falls back to the current
       * selection collapsed to its end — insertion never replaces an active
       * range.
       */
      clientX?: number;
      clientY?: number;
    }
  ) => void;
  triggerAtMention: () => void;
  triggerSlashContext: () => void;
}

export interface RichTextEditorProps {
  placeholder?: string;
  initialContent?: string | JSONContent;
  onContentChange?: (
    html: string,
    text: string,
    json: JSONContent,
    markdown: string
  ) => void;
  onImageInsert?: (files: File[]) => void;
  onAtMention?: (
    query: string,
    cursorPosition: { x: number; y: number }
  ) => void;
  onAtMentionClose?: () => void;
  onSlashCommand?: (query: string) => void;
  onSlashCommandClose?: () => void;
  autoFocus?: boolean;
  className?: string;
  toolbarClassName?: string;
  /** Formatting toolbar placement. Defaults to selection-based floating controls. */
  toolbarMode?: "floating" | "inline" | "none";
  /** Formatting toolbar control size. Defaults to the 28px `small` size. */
  toolbarSize?: "mini" | "small";
  /** Preferred placement for toolbar dropdown panels. */
  toolbarDropdownPosition?: DropdownPosition;
  /** Match the editable document typography to the shared Markdown preview. */
  matchMarkdownPreview?: boolean;
  minHeight?: number;
  maxHeight?: number | string;
  editable?: boolean;
  /** Submit the surrounding message form with Command/Ctrl+Enter. */
  onSubmit?: () => void;
  onKeyDownForDropdown?: (event: KeyboardEvent) => boolean;
  onKeyDownForSlashDropdown?: (event: KeyboardEvent) => boolean;
}

export interface InlineTriggerState {
  active: boolean;
  startPos: number;
  hasTriggerChar?: boolean;
}
