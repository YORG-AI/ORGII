import React, {
  Suspense,
  forwardRef,
  lazy,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Markdown from "@src/components/MarkDown";
import TabPill from "@src/components/TabPill";

import "./index.scss";

// Lazy: MarkdownEditor is mounted by the Settings/Integrations wizards and
// the AgentOrgs configuration surfaces; loading CodeMirror only when the
// edit tab actually renders keeps those routes light until then.
const CodeMirrorEditor = lazy(() => import("@src/features/CodeMirror/Editor"));

export interface MarkdownEditorRef {
  getText: () => string;
  getMarkdown: () => string;
  getHTML: () => string;
  setContent: (content: string) => void;
  clear: () => void;
  focus: () => void;
  isEmpty: () => boolean;
  insertImage: (src: string, alt?: string) => void;
}

export interface MarkdownEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  minHeight?: number;
  maxHeight?: number | string;
  showTokenCount?: boolean;
  previewEmptyText?: string;
  placeholder?: string;
  emptyLineCount?: number;
  className?: string;
  dataTestId?: string;
  hideHeader?: boolean;
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  defaultTab?: "edit" | "preview";
  footerRight?: React.ReactNode;
  onImageInsert?: (files: File[]) => void;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function escapeMarkdownAlt(text: string): string {
  return text.split("[").join("").split("]").join("").trim() || "image";
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

function editorHeight(value: number | string): string {
  return typeof value === "number" ? `${value}px` : value;
}

export function useMarkdownEditorTabs() {
  const { t } = useTranslation();
  return useMemo(
    () => [
      { key: "edit", label: t("common:actions.edit") },
      {
        key: "preview",
        label: t("common:common.preview"),
      },
    ],
    [t]
  );
}

const MarkdownEditor = forwardRef<MarkdownEditorRef, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      value,
      onChange,
      readOnly = false,
      minHeight = 200,
      maxHeight,
      showTokenCount = true,
      previewEmptyText,
      placeholder,
      emptyLineCount = 0,
      className,
      dataTestId,
      hideHeader = false,
      activeTab: controlledTab,
      onTabChange,
      defaultTab,
      footerRight,
      onImageInsert,
    },
    ref
  ) {
    const { t } = useTranslation();
    const rootRef = useRef<HTMLDivElement>(null);
    const valueRef = useRef(value);

    useEffect(() => {
      valueRef.current = value;
    }, [value]);

    const [internalTab, setInternalTab] = useState<string>(() => {
      if (readOnly) return "preview";
      return defaultTab ?? "edit";
    });

    const currentTab = controlledTab ?? internalTab;
    const handleTabChange = onTabChange ?? setInternalTab;
    const tokenCount = useMemo(() => estimateTokens(value), [value]);
    const tabs = useMarkdownEditorTabs();
    const emptyText = previewEmptyText ?? t("common:common.nothingToPreview");
    const editorValue = useMemo(() => {
      if (value.length > 0 || emptyLineCount <= 1) return value;
      return "\n".repeat(emptyLineCount - 1);
    }, [emptyLineCount, value]);

    const focusEditor = useCallback(() => {
      const editableElement =
        rootRef.current?.querySelector<HTMLElement>(".cm-content");
      editableElement?.focus();
    }, []);

    const handleEditorChromeClick = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (readOnly || currentTab !== "edit") return;
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.closest(".cm-content")) return;
        focusEditor();
      },
      [currentTab, focusEditor, readOnly]
    );

    const updateValue = useCallback(
      (nextValue: string) => {
        valueRef.current = nextValue;
        onChange?.(nextValue);
      },
      [onChange]
    );

    const handleEditorChange = useCallback(
      (nextValue: string) => {
        updateValue(nextValue.trim().length === 0 ? "" : nextValue);
      },
      [updateValue]
    );

    const insertImage = useCallback(
      (src: string, alt?: string) => {
        const currentValue = valueRef.current;
        const imageMarkdown = `![${escapeMarkdownAlt(alt ?? "image")}](${src})`;
        const prefix = currentValue.trim().length > 0 ? "\n\n" : "";
        updateValue(`${currentValue}${prefix}${imageMarkdown}\n`);
        focusEditor();
      },
      [focusEditor, updateValue]
    );

    useImperativeHandle(
      ref,
      () => ({
        getText: () => valueRef.current,
        getMarkdown: () => valueRef.current,
        getHTML: () => valueRef.current,
        setContent: updateValue,
        clear: () => updateValue(""),
        focus: focusEditor,
        isEmpty: () => valueRef.current.trim().length === 0,
        insertImage,
      }),
      [focusEditor, insertImage, updateValue]
    );

    const handlePaste = useCallback(
      (event: React.ClipboardEvent<HTMLDivElement>) => {
        if (!onImageInsert || readOnly) return;
        const imageFiles = Array.from(event.clipboardData.files).filter(
          isImageFile
        );
        if (imageFiles.length === 0) return;
        event.preventDefault();
        onImageInsert(imageFiles);
      },
      [onImageInsert, readOnly]
    );

    const handleDrop = useCallback(
      (event: React.DragEvent<HTMLDivElement>) => {
        if (!onImageInsert || readOnly) return;
        const imageFiles = Array.from(event.dataTransfer.files).filter(
          isImageFile
        );
        if (imageFiles.length === 0) return;
        event.preventDefault();
        onImageInsert(imageFiles);
      },
      [onImageInsert, readOnly]
    );

    const contentStyle = {
      minHeight: editorHeight(minHeight),
      ...(maxHeight !== undefined
        ? {
            height: editorHeight(maxHeight),
            maxHeight: editorHeight(maxHeight),
          }
        : {}),
    };
    const showFooter = showTokenCount || footerRight;

    return (
      <div
        ref={rootRef}
        className={`markdown-editor-root${className ? ` ${className}` : ""}`}
        data-testid={dataTestId}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={(event) => {
          if (!readOnly && onImageInsert) event.preventDefault();
        }}
      >
        {!readOnly && !hideHeader && (
          <div className="mb-2 flex items-center justify-end">
            <TabPill
              tabs={tabs}
              activeTab={currentTab}
              onChange={handleTabChange}
              variant="pill"
              fillWidth={false}
            />
          </div>
        )}

        <div className="markdown-editor-wrapper">
          {currentTab === "edit" && !readOnly ? (
            <div
              className="markdown-editor-content"
              style={contentStyle}
              onMouseDown={handleEditorChromeClick}
            >
              <Suspense fallback={null}>
                <CodeMirrorEditor
                  value={editorValue}
                  onChange={handleEditorChange}
                  language="markdown"
                  height="100%"
                  enableMinimap={false}
                  enableDirtyDiff={false}
                  enableFindReplace={false}
                  enableGoToLine={false}
                  registerWithService={false}
                />
              </Suspense>
              {value.trim().length === 0 && placeholder && (
                <div className="markdown-editor-placeholder">{placeholder}</div>
              )}
            </div>
          ) : (
            <div className="markdown-editor-preview" style={contentStyle}>
              {value.trim() ? (
                <Markdown textContent={value} />
              ) : (
                <span className="text-text-3">{emptyText}</span>
              )}
            </div>
          )}
        </div>

        {showFooter && (
          <div className="mt-2 flex items-center justify-between">
            {showTokenCount ? (
              <span className="text-xs text-text-3">
                ~{tokenCount.toLocaleString()} Token
              </span>
            ) : (
              <span />
            )}
            {footerRight && (
              <div className="flex items-center gap-2">{footerRight}</div>
            )}
          </div>
        )}
      </div>
    );
  }
);

export default MarkdownEditor;
