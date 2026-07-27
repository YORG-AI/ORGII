import type { CSSProperties } from "react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import RichTextEditor from "@src/components/RichTextEditor";
import type {
  RichTextEditorProps,
  RichTextEditorRef,
} from "@src/components/RichTextEditor";
import TabPill from "@src/components/TabPill";
import { MarkdownContent } from "@src/modules/shared/components/MarkdownContent";

export type RichMarkdownEditorMode = "preview" | "raw";
export type RichMarkdownEditorRef = RichTextEditorRef;

export interface RichMarkdownEditorProps extends Omit<
  RichTextEditorProps,
  "initialContent" | "onContentChange"
> {
  value: string;
  onChange?: (markdown: string, text: string) => void;
  defaultMode?: RichMarkdownEditorMode;
  mode?: RichMarkdownEditorMode;
  onModeChange?: (mode: RichMarkdownEditorMode) => void;
  showTabs?: boolean;
  previewEmptyText?: string;
  appearance?: "plain" | "outlined";
  dataTestId?: string;
}

function cssSize(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? `${value}px` : value;
}

const RichMarkdownEditor = forwardRef<
  RichMarkdownEditorRef,
  RichMarkdownEditorProps
>(function RichMarkdownEditor(
  {
    value,
    onChange,
    defaultMode = "raw",
    mode: controlledMode,
    onModeChange,
    showTabs = true,
    previewEmptyText,
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
  const { t } = useTranslation("common");
  const editorRef = useRef<RichTextEditorRef>(null);
  const valueRef = useRef(value);
  const [internalMode, setInternalMode] =
    useState<RichMarkdownEditorMode>(defaultMode);
  const currentMode = controlledMode ?? internalMode;

  const tabs = useMemo(
    () => [
      { key: "preview", label: t("common.preview") },
      { key: "raw", label: t("common.raw") },
    ],
    [t]
  );

  useEffect(() => {
    if (value === valueRef.current) return;
    valueRef.current = value;
    editorRef.current?.setContent(value);
  }, [value]);

  const setMode = useCallback(
    (nextMode: string) => {
      const normalizedMode = nextMode as RichMarkdownEditorMode;
      if (controlledMode === undefined) setInternalMode(normalizedMode);
      onModeChange?.(normalizedMode);
      if (normalizedMode === "raw" && editable) {
        requestAnimationFrame(() => editorRef.current?.focus());
      }
    },
    [controlledMode, editable, onModeChange]
  );

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
      focus: () => {
        setMode("raw");
        editorRef.current?.focus();
      },
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
      triggerAtMention: () => {
        setMode("raw");
        editorRef.current?.triggerAtMention();
      },
      triggerSlashContext: () => {
        setMode("raw");
        editorRef.current?.triggerSlashContext();
      },
    }),
    [setMode]
  );

  const contentStyle: CSSProperties = {
    minHeight: cssSize(minHeight),
    maxHeight: cssSize(maxHeight),
    overflowY: maxHeight === undefined ? undefined : "auto",
  };
  const outlined = appearance === "outlined";
  const surfaceClassName = outlined
    ? "rounded-md border border-border-2 bg-primary-container"
    : "";

  return (
    <div
      className={`rich-markdown-editor flex min-h-0 min-w-0 flex-col ${className}`.trim()}
      data-testid={dataTestId}
    >
      {showTabs ? (
        <div className="mb-2 flex items-center justify-end">
          <TabPill
            tabs={tabs}
            activeTab={currentMode}
            onChange={setMode}
            variant="pill"
            fillWidth={false}
            size="mini"
          />
        </div>
      ) : null}

      <div
        className={`min-h-0 ${maxHeight === undefined ? "" : "flex-1"} ${surfaceClassName}`.trim()}
      >
        <div
          className={currentMode === "raw" ? "block h-full min-h-0" : "hidden"}
          data-rich-markdown-raw
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
        {currentMode === "preview" ? (
          <div
            className="cursor-default overflow-y-auto px-3 py-2"
            style={contentStyle}
            data-rich-markdown-preview
          >
            <MarkdownContent
              body={value}
              emptyText={previewEmptyText ?? t("common.nothingToPreview")}
              clamped={false}
              className="text-[14px] leading-[1.6] [&_.chat-markdown-body]:text-[14px] [&_.chat-markdown-body]:leading-[1.6]"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
});

export default RichMarkdownEditor;
