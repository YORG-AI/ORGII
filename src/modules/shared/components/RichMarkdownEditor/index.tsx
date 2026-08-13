import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

import RichTextEditor from "@src/components/RichTextEditor";
import type {
  RichTextEditorProps,
  RichTextEditorRef,
} from "@src/components/RichTextEditor";

export type RichMarkdownEditorRef = RichTextEditorRef;

/** Inline Markdown controls shared by comment, review, and create composers. */
export const RICH_MARKDOWN_COMPOSER_TOOLBAR_CLASS =
  "!min-h-0 !border-b-0 !pb-0.5 [&_svg]:size-3.5";

export interface RichMarkdownEditorProps extends Omit<
  RichTextEditorProps,
  "initialContent" | "onContentChange"
> {
  value: string;
  onChange?: (markdown: string, text: string) => void;
  appearance?: "plain" | "outlined";
  dataTestId?: string;
}

const RichMarkdownEditor = forwardRef<
  RichMarkdownEditorRef,
  RichMarkdownEditorProps
>(function RichMarkdownEditor(
  {
    value,
    onChange,
    appearance = "plain",
    className = "",
    minHeight = 120,
    maxHeight,
    editable = true,
    matchMarkdownPreview = true,
    dataTestId,
    ...editorProps
  },
  ref
) {
  const editorRef = useRef<RichTextEditorRef>(null);
  const valueRef = useRef(value);

  useEffect(() => {
    if (value === valueRef.current) return;
    valueRef.current = value;
    editorRef.current?.setContent(value);
  }, [value]);

  const handleContentChange: NonNullable<
    RichTextEditorProps["onContentChange"]
  > = useCallback(
    (_html, text, _json, markdown) => {
      valueRef.current = markdown;
      onChange?.(markdown, text);
    },
    [onChange]
  );

  useImperativeHandle(
    ref,
    () => ({
      getText: () => editorRef.current?.getText() ?? "",
      getHTML: () => editorRef.current?.getHTML() ?? "",
      getJSON: () => editorRef.current?.getJSON(),
      getMarkdown: () => editorRef.current?.getMarkdown() ?? valueRef.current,
      setContent: (content) => editorRef.current?.setContent(content),
      clear: () => editorRef.current?.clear(),
      focus: () => editorRef.current?.focus(),
      isEmpty: () =>
        editorRef.current?.isEmpty() ?? valueRef.current.trim().length === 0,
      insertImage: (src, alt) => editorRef.current?.insertImage(src, alt),
      insertFilePill: (filePath, isFolder, iconType, displayName) =>
        editorRef.current?.insertFilePill(
          filePath,
          isFolder,
          iconType,
          displayName
        ),
      removeFilePill: (filePath) => editorRef.current?.removeFilePill(filePath),
      getFilePills: () => editorRef.current?.getFilePills() ?? [],
      insertText: (text, options) =>
        editorRef.current?.insertText(text, options),
      triggerAtMention: () => editorRef.current?.triggerAtMention(),
      triggerSlashContext: () => editorRef.current?.triggerSlashContext(),
    }),
    []
  );

  const outlined = appearance === "outlined";
  const surfaceClassName = outlined
    ? "rounded-md border border-border-2 bg-primary-container"
    : "";

  return (
    <div
      className={`rich-markdown-editor flex min-h-0 min-w-0 flex-col ${className}`.trim()}
      data-testid={dataTestId}
    >
      <div
        className={`min-h-0 ${maxHeight === undefined ? "" : "flex-1"} ${surfaceClassName}`.trim()}
        data-rich-markdown-editor
      >
        <RichTextEditor
          ref={editorRef}
          initialContent={value}
          onContentChange={handleContentChange}
          minHeight={minHeight}
          maxHeight={maxHeight}
          editable={editable}
          matchMarkdownPreview={matchMarkdownPreview}
          {...editorProps}
        />
      </div>
    </div>
  );
});

export default RichMarkdownEditor;
