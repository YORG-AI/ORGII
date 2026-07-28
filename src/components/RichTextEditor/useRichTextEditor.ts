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
    triggerAtMention,
    triggerSlashContext,
  };
}
