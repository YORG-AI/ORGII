import type { Editor, JSONContent } from "@tiptap/react";
import { useEditor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { PillIconType } from "@src/components/ComposerInput";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import { createEditorExtensions } from "./config";
import type { InlineTriggerState, RichTextEditorProps } from "./types";

const DROPDOWN_KEYS = ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"];
const TOOLBAR_WIDTH = 620;

function markdownFromEditor(editor: Editor): string {
  const storage = (editor.storage as unknown as Record<string, unknown>)
    .markdown as { getMarkdown?: () => string } | undefined;
  return storage?.getMarkdown?.() ?? editor.getText();
}

/**
 * Where a programmatic `insertText` should land: the drop point, resolved
 * through `editor.view.posAtCoords`, when one is supplied and maps to a real
 * document position; otherwise the current selection collapsed to its END.
 *
 * Collapsing to the end (never the start) is deliberate: with an active
 * range selection and no drop point to go on, treating the insert as "type
 * over the selection" would silently delete whatever the user had selected.
 * Landing after it instead never destroys content.
 */
/** Horizontal step for the walk-left retry below. */
const POS_AT_COORDS_RETRY_STEP_PX = 48;

export function insertionPositionFor(
  editor: {
    view: {
      posAtCoords: Editor["view"]["posAtCoords"];
      dom?: { getBoundingClientRect(): { left: number } };
    };
  },
  selectionEnd: number,
  dropPoint?: { clientX?: number; clientY?: number }
): number {
  if (dropPoint?.clientX == null || dropPoint?.clientY == null) {
    return selectionEnd;
  }
  let coords = editor.view.posAtCoords({
    left: dropPoint.clientX,
    top: dropPoint.clientY,
  });
  // Chromium's caret probing returns null for points in the empty region to
  // the RIGHT of a short line, even though the point is inside the editor
  // (verified live: same x resolves once the line grows past it). Walk the
  // probe left toward the text until it lands, so "drop after the line"
  // means end-of-that-line instead of silently falling back to the caret.
  if (!coords && editor.view.dom) {
    const leftEdge = editor.view.dom.getBoundingClientRect().left;
    for (
      let x = dropPoint.clientX - POS_AT_COORDS_RETRY_STEP_PX;
      !coords && x > leftEdge;
      x -= POS_AT_COORDS_RETRY_STEP_PX
    ) {
      coords = editor.view.posAtCoords({ left: x, top: dropPoint.clientY });
    }
  }
  return coords?.pos ?? selectionEnd;
}

export interface InsertTextOptions {
  separateFromAdjacentText?: boolean;
  /** Viewport coordinates of a drop point — see `insertionPositionFor`. */
  clientX?: number;
  clientY?: number;
}

/**
 * Insert `text` as plain, unmarked content, positioned at a drop point when
 * one resolves, and otherwise at the current selection collapsed to its end
 * (an active range is never replaced).
 *
 * Exported standalone — independent of the `useRichTextEditor` React hook —
 * so it can be exercised directly against a real tiptap `Editor` instance in
 * tests, the same way `markdownRoundTrip.test.ts` does.
 */
export function insertReferenceText(
  editor: Editor,
  text: string,
  options?: InsertTextOptions
): void {
  if (!text) return;
  const { to: selectionEnd } = editor.state.selection;

  // Resolve where the text lands. A drop point wins when it maps to a real
  // document position; otherwise fall back to the current selection
  // COLLAPSED to its end — insertion must never replace an active range.
  const insertAt = insertionPositionFor(editor, selectionEnd, options);

  const docEnd = editor.state.doc.content.size;
  const before =
    options?.separateFromAdjacentText && insertAt > 1
      ? editor.state.doc.textBetween(insertAt - 1, insertAt, "\n", "\n")
      : "";
  const after =
    options?.separateFromAdjacentText && insertAt < docEnd
      ? editor.state.doc.textBetween(insertAt, insertAt + 1, "\n", "\n")
      : "";
  const leadingSpace = before.length > 0 && !/\s$/u.test(before) ? " " : "";
  const trailingSpace = after.length > 0 && !/^\s/u.test(after) ? " " : "";
  const insertedString = `${leadingSpace}${text}${trailingSpace}`;
  const insertedEnd = insertAt + insertedString.length;

  editor
    .chain()
    .focus()
    .setTextSelection(insertAt)
    .insertContent({ type: "text", text: insertedString })
    // The text node above carries no marks, which makes tiptap fold it into
    // a plain `tr.insertText` — and that call inherits whatever bold/link
    // marks are active at the insertion point, same as typing would.
    // Explicitly clearing marks on the just-inserted range (not
    // storedMarks — the actual marks the insert picked up) is what actually
    // keeps the reference plain text.
    .setTextSelection({ from: insertAt, to: insertedEnd })
    .unsetAllMarks()
    .setTextSelection(insertedEnd)
    .run();
}

export function useRichTextEditor({
  placeholder = "Type something...",
  initialContent = "",
  onContentChange,
  onImageInsert,
  onAtMention,
  onAtMentionClose,
  onSlashCommand,
  onSlashCommandClose,
  autoFocus = false,
  editable = true,
  matchMarkdownPreview = false,
  onSubmit,
  onKeyDownForDropdown,
  onKeyDownForSlashDropdown,
}: Omit<
  RichTextEditorProps,
  "className" | "toolbarClassName" | "minHeight" | "maxHeight"
>) {
  const { isDark } = useCurrentTheme();
  const [showToolbar, setShowToolbar] = useState(false);
  const [toolbarPosition, setToolbarPosition] = useState({ top: 0, left: 0 });

  const atMentionRef = useRef<InlineTriggerState>({
    active: false,
    startPos: 0,
  });
  const slashCommandRef = useRef<InlineTriggerState>({
    active: false,
    startPos: 0,
  });

  const onContentChangeRef = useRef(onContentChange);
  const onImageInsertRef = useRef(onImageInsert);
  const onAtMentionRef = useRef(onAtMention);
  const onAtMentionCloseRef = useRef(onAtMentionClose);
  const onSlashCommandRef = useRef(onSlashCommand);
  const onSlashCommandCloseRef = useRef(onSlashCommandClose);
  const onSubmitRef = useRef(onSubmit);
  const onKeyDownForDropdownRef = useRef(onKeyDownForDropdown);
  const onKeyDownForSlashDropdownRef = useRef(onKeyDownForSlashDropdown);

  useEffect(() => {
    onContentChangeRef.current = onContentChange;
    onImageInsertRef.current = onImageInsert;
    onAtMentionRef.current = onAtMention;
    onAtMentionCloseRef.current = onAtMentionClose;
    onSlashCommandRef.current = onSlashCommand;
    onSlashCommandCloseRef.current = onSlashCommandClose;
    onSubmitRef.current = onSubmit;
    onKeyDownForDropdownRef.current = onKeyDownForDropdown;
    onKeyDownForSlashDropdownRef.current = onKeyDownForSlashDropdown;
  });

  const editor = useEditor({
    extensions: createEditorExtensions(placeholder),
    content: initialContent,
    editable,
    autofocus: autoFocus ? "end" : false,
    editorProps: {
      attributes: {
        class: `rich-text-editor-content ${
          matchMarkdownPreview ? "rich-text-editor-markdown-preview" : ""
        } ${isDark ? "dark" : "light"}`
          .replace(/\s+/g, " ")
          .trim(),
        autocomplete: "off",
        autocorrect: "off",
        autocapitalize: "off",
        spellcheck: "true",
      },
      handleKeyDown: (view, event) => {
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          onSubmitRef.current
        ) {
          event.preventDefault();
          onSubmitRef.current();
          return true;
        }

        if (
          atMentionRef.current.active &&
          DROPDOWN_KEYS.includes(event.key) &&
          onKeyDownForDropdownRef.current?.(event)
        ) {
          event.preventDefault();
          return true;
        }
        if (
          slashCommandRef.current.active &&
          DROPDOWN_KEYS.includes(event.key) &&
          onKeyDownForSlashDropdownRef.current?.(event)
        ) {
          event.preventDefault();
          return true;
        }

        if (event.key === "@" && onAtMentionRef.current) {
          setTimeout(() => {
            const { from } = view.state.selection;
            atMentionRef.current = {
              active: true,
              startPos: from,
              hasTriggerChar: true,
            };
            const coords = view.coordsAtPos(from);
            onAtMentionRef.current?.("", {
              x: coords.left,
              y: coords.bottom,
            });
          }, 0);
        } else if (
          event.key === "/" &&
          onSlashCommandRef.current &&
          (view.state.selection.from <= 1 ||
            /\s/.test(
              view.state.doc.textBetween(
                view.state.selection.from - 1,
                view.state.selection.from,
                ""
              )
            ))
        ) {
          setTimeout(() => {
            const { from } = view.state.selection;
            slashCommandRef.current = {
              active: true,
              startPos: from,
              hasTriggerChar: true,
            };
            onSlashCommandRef.current?.("");
          }, 0);
        }

        if (event.key === "Escape") {
          if (atMentionRef.current.active) {
            atMentionRef.current.active = false;
            onAtMentionCloseRef.current?.();
            return true;
          }
          if (slashCommandRef.current.active) {
            slashCommandRef.current.active = false;
            onSlashCommandCloseRef.current?.();
            return true;
          }
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return false;
        const imageFiles = Array.from(clipboardData.items)
          .filter((item) => item.type.startsWith("image/"))
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
        if (imageFiles.length === 0 || !onImageInsertRef.current) return false;
        event.preventDefault();
        onImageInsertRef.current(imageFiles);
        return true;
      },
      handleDrop: (_view, event) => {
        const imageFiles = Array.from(event.dataTransfer?.files ?? []).filter(
          (file) => file.type.startsWith("image/")
        );
        if (imageFiles.length === 0 || !onImageInsertRef.current) return false;
        event.preventDefault();
        onImageInsertRef.current(imageFiles);
        return true;
      },
    },
    onUpdate: ({ editor: editorInstance }) => {
      onContentChangeRef.current?.(
        editorInstance.getHTML(),
        editorInstance.getText(),
        editorInstance.getJSON(),
        markdownFromEditor(editorInstance)
      );

      const updateTrigger = (
        state: InlineTriggerState,
        onQuery: ((query: string) => void) | undefined,
        onClose: (() => void) | undefined
      ) => {
        if (!state.active) return;
        const { from } = editorInstance.state.selection;
        const query = editorInstance.state.doc.textBetween(
          state.startPos,
          from,
          ""
        );
        if (/\s/.test(query) || from < state.startPos) {
          state.active = false;
          onClose?.();
        } else {
          onQuery?.(query);
        }
      };

      updateTrigger(
        atMentionRef.current,
        (query) => {
          const { from } = editorInstance.state.selection;
          const coords = editorInstance.view.coordsAtPos(from);
          onAtMentionRef.current?.(query, {
            x: coords.left,
            y: coords.bottom,
          });
        },
        onAtMentionCloseRef.current
      );
      updateTrigger(
        slashCommandRef.current,
        onSlashCommandRef.current,
        onSlashCommandCloseRef.current
      );
    },
    onSelectionUpdate: ({ editor: editorInstance }) => {
      const { from, to } = editorInstance.state.selection;
      if (!editable || from === to || editorInstance.isActive("codeBlock")) {
        setShowToolbar(false);
        return;
      }

      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const rect = range?.getBoundingClientRect();
      const start = editorInstance.view.coordsAtPos(from);
      const end = editorInstance.view.coordsAtPos(to);
      const selectionCenter = rect?.width
        ? rect.left + rect.width / 2
        : (start.left + end.left) / 2;
      const left = selectionCenter - TOOLBAR_WIDTH / 2;
      setToolbarPosition({
        top: Math.max(10, Math.min(start.top, end.top) - 50),
        left: Math.max(
          10,
          Math.min(left, window.innerWidth - TOOLBAR_WIDTH - 10)
        ),
      });
      setShowToolbar(true);
    },
    onBlur: () => {
      setTimeout(() => {
        if (!document.querySelector(".rich-text-editor-toolbar:hover")) {
          setShowToolbar(false);
        }
      }, 150);
    },
  });

  const getText = useCallback(() => editor?.getText() ?? "", [editor]);
  const getHTML = useCallback(() => editor?.getHTML() ?? "", [editor]);
  const getJSON = useCallback(
    () => editor?.getJSON() as JSONContent | undefined,
    [editor]
  );
  const getMarkdown = useCallback(
    () => (editor ? markdownFromEditor(editor) : ""),
    [editor]
  );
  const setContent = useCallback(
    (content: string | JSONContent) => editor?.commands.setContent(content),
    [editor]
  );
  const clear = useCallback(() => editor?.commands.clearContent(), [editor]);
  const focus = useCallback(() => editor?.commands.focus(), [editor]);
  const isEmpty = useCallback(() => editor?.isEmpty ?? true, [editor]);
  const insertImage = useCallback(
    (src: string, alt?: string) => {
      editor
        ?.chain()
        .focus()
        .setImage({ src, alt: alt ?? "" })
        .run();
    },
    [editor]
  );

  const insertFilePill = useCallback(
    (
      filePath: string,
      isFolder = false,
      iconType?: PillIconType,
      displayName?: string
    ) => {
      if (!editor) return;
      const trigger = atMentionRef.current.active
        ? atMentionRef.current
        : slashCommandRef.current.active
          ? slashCommandRef.current
          : null;
      let chain = editor.chain().focus();
      if (trigger) {
        const { from } = editor.state.selection;
        chain = chain.deleteRange({
          from: trigger.hasTriggerChar
            ? Math.max(0, trigger.startPos - 1)
            : trigger.startPos,
          to: from,
        });
      }
      chain
        .insertFilePill({
          filePath,
          fileName: displayName || filePath.split("/").pop() || filePath,
          isFolder,
          iconType,
        })
        .insertContent(" ")
        .run();
      if (atMentionRef.current.active) {
        atMentionRef.current.active = false;
        onAtMentionCloseRef.current?.();
      }
      if (slashCommandRef.current.active) {
        slashCommandRef.current.active = false;
        onSlashCommandCloseRef.current?.();
      }
    },
    [editor]
  );

  const removeFilePill = useCallback(
    (filePath: string) => editor?.commands.removeFilePill(filePath),
    [editor]
  );
  const getFilePills = useCallback(() => {
    const pills: Array<{ filePath: string; fileName: string }> = [];
    editor?.state.doc.descendants((node) => {
      if (node.type.name === "filePill") {
        pills.push({
          filePath: String(node.attrs.filePath),
          fileName: String(node.attrs.fileName),
        });
      }
    });
    return pills;
  }, [editor]);

  const insertText = useCallback(
    (text: string, options?: InsertTextOptions) => {
      if (!editor) return;
      insertReferenceText(editor, text, options);
    },
    [editor]
  );

  const triggerAtMention = useCallback(() => {
    if (!editor) return;
    editor.commands.focus();
    const { from } = editor.state.selection;
    atMentionRef.current = { active: true, startPos: from };
    const coords = editor.view.coordsAtPos(from);
    onAtMentionRef.current?.("", { x: coords.left, y: coords.bottom });
  }, [editor]);

  const triggerSlashContext = useCallback(() => {
    if (!editor) return;
    editor.commands.focus();
    const { from } = editor.state.selection;
    slashCommandRef.current = { active: true, startPos: from };
    onSlashCommandRef.current?.("");
  }, [editor]);

  return {
    editor,
    isDark,
    showToolbar,
    toolbarPosition,
    handleCloseToolbar: () => setShowToolbar(false),
    getText,
    getHTML,
    getJSON,
    getMarkdown,
    setContent,
    clear,
    focus,
    isEmpty,
    insertImage,
    insertFilePill,
    removeFilePill,
    getFilePills,
    insertText,
    triggerAtMention,
    triggerSlashContext,
  };
}
