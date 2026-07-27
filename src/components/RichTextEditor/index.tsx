import { EditorContent } from "@tiptap/react";
import {
  type ChangeEvent,
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";

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
          className={`rich-text-editor loading ${className}`.trim()}
          style={{ minHeight }}
        >
          <div className="loading-placeholder">{t("editor.loading")}</div>
        </div>
      );
    }

    return (
      <div
        className={`rich-text-editor ${isDark ? "dark" : "light"} ${className}`.trim()}
        style={{
          minHeight,
          maxHeight,
          overflowY: maxHeight ? "auto" : undefined,
        }}
      >
        {showToolbar && (
          <FloatingToolbar
            editor={editor}
            position={toolbarPosition}
            onImagePickerOpen={
              onImageInsert ? () => fileInputRef.current?.click() : undefined
            }
            className={toolbarClassName}
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
