import { EditorContent } from "@tiptap/react";
import {
  type ChangeEvent,
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";

import ProgressBar from "@src/components/ProgressBar";

import { FloatingToolbar } from "./FloatingToolbar";
import "./index.scss";
import type { RichTextEditorProps, RichTextEditorRef } from "./types";
import { useRichTextEditor } from "./useRichTextEditor";

const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";

const RichTextEditor = forwardRef<RichTextEditorRef, RichTextEditorProps>(
  (
    {
      className = "",
      toolbarClassName = "",
      toolbarMode = "floating",
      toolbarSize = "small",
      toolbarDropdownPosition = "bottom-start",
      minHeight = 120,
      maxHeight,
      onImageInsert,
      ...hookProps
    },
    ref
  ) => {
    const { t } = useTranslation("sessions");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const {
      editor,
      isDark,
      showToolbar,
      toolbarPosition,
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
    } = useRichTextEditor({ ...hookProps, onImageInsert });

    useImperativeHandle(ref, () => ({
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
    }));

    const handleFileInputChange = useCallback(
      (event: ChangeEvent<HTMLInputElement>) => {
        const imageFiles = Array.from(event.target.files ?? []).filter((file) =>
          file.type.startsWith("image/")
        );
        if (imageFiles.length > 0) onImageInsert?.(imageFiles);
        event.target.value = "";
      },
      [onImageInsert]
    );

    if (!editor) {
      return (
        <div
          className={`rich-text-editor loading overflow-hidden ${className}`.trim()}
          style={{ minHeight }}
        >
          <ProgressBar
            percent={0}
            indeterminate
            ariaLabel={t("editor.loading")}
            height="h-0.5"
            width="w-full"
            trackColor="bg-transparent"
            className="absolute inset-x-0 top-0 rounded-none"
          />
        </div>
      );
    }

    const hasConstrainedHeight = maxHeight !== undefined;

    return (
      <div
        className={`rich-text-editor ${
          hasConstrainedHeight ? "rich-text-editor-scroll-contained" : ""
        } ${isDark ? "dark" : "light"} ${className}`.trim()}
        style={{
          minHeight,
          maxHeight,
        }}
      >
        {toolbarMode === "inline" && (
          <FloatingToolbar
            editor={editor}
            placement="inline"
            onImagePickerOpen={
              onImageInsert ? () => fileInputRef.current?.click() : undefined
            }
            className={toolbarClassName}
            size={toolbarSize}
            dropdownPosition={toolbarDropdownPosition}
          />
        )}
        {toolbarMode === "floating" && showToolbar && (
          <FloatingToolbar
            editor={editor}
            position={toolbarPosition}
            onImagePickerOpen={
              onImageInsert ? () => fileInputRef.current?.click() : undefined
            }
            className={toolbarClassName}
            size={toolbarSize}
            dropdownPosition={toolbarDropdownPosition}
          />
        )}
        <EditorContent editor={editor} className="rich-text-editor-wrapper" />
        {onImageInsert && (
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            onChange={handleFileInputChange}
            className="hidden"
          />
        )}
      </div>
    );
  }
);

RichTextEditor.displayName = "RichTextEditor";

export default RichTextEditor;
export type { RichTextEditorProps, RichTextEditorRef } from "./types";
