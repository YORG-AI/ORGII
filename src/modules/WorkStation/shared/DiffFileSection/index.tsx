import { useSetAtom } from "jotai";
import { ChevronDown, ChevronRight } from "lucide-react";
import React, {
  Suspense,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import FileTypeIcon from "@src/components/FileTypeIcon";
import {
  type GitFileStatus,
  getStatusColor,
  getStatusLetterForFile,
} from "@src/config/gitStatus";
import { EDITOR_TAB_CANVAS_BG_CLASS } from "@src/config/workstation/tokens";
import { CodeMirrorDiff } from "@src/features/CodeMirror";
import { FileHeader } from "@src/modules/shared/components/FileHeader";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  TextSelectionDropdown,
  useTextSelectionDropdown,
} from "@src/scaffold/ContextMenu/exports";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";
import { isBinaryByExtension } from "@src/util/file/binaryDetection";
import {
  getPreviewType,
  supportsSourceControlWorkingCopyPreview,
} from "@src/util/file/previewTypes";

const LazyImagePreview = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/FilePreviewContent/ImagePreview")
);
const LazyVideoPreview = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/FilePreviewContent/VideoPreview")
);
const LazyPdfPreview = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/FilePreviewContent/PdfPreview")
);
const LazyDocxPreview = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/FilePreviewContent/DocxPreview")
);
const LazyXlsxPreview = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/FilePreviewContent/XlsxPreview")
);
const LazyPptxPreview = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/FilePreviewContent/PptxPreview")
);
const LazyPagesPreview = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/FilePreviewContent/PagesPreview")
);

export interface DiffFileSectionData {
  path: string;
  original_path?: string | null;
  status: GitFileStatus;
  staged: boolean;
  additions?: number;
  deletions?: number;
  oldContent?: string;
  newContent?: string;
  oldStartLine?: number;
  newStartLine?: number;
  showLineNumbers?: boolean;
  unifiedDiff?: string;
  isBinary?: boolean;
  /** True when the file was edited but content could not be retrieved (e.g. Cursor IDE blob pruned). */
  isUnavailable?: boolean;
}

export interface DiffFileSectionProps {
  file: DiffFileSectionData;
  defaultExpanded?: boolean;
  expansionSignal?: number;
  repoPath?: string;
  sectionRef?: React.RefObject<HTMLDivElement | null>;
  onFileSelect?: (path: string) => void;
  onRequestContent?: (file: DiffFileSectionData) => void;
  hideDirectory?: boolean;
  showBottomBorder?: boolean;
  dataPath?: string;
  /** Show `current path ← original path` metadata for renamed files. */
  showRenamePath?: boolean;
  /**
   * When true, renders a flat FileHeader (matching source control style)
   * instead of the collapsible chevron button. Content is always expanded.
   */
  flat?: boolean;
  /**
   * When true, suppresses the bottom padding added by the diff viewer
   * (used in contexts without a bottom panel, e.g. agent station diff).
   */
  noBottomPadding?: boolean;
}

function getDisplayPath(path: string, repoPath?: string): string {
  if (!repoPath || !path.startsWith(repoPath)) return path;
  return path.slice(repoPath.length).replace(/^[/\\]/, "");
}

function getFileNameAndDir(path: string): {
  fileName: string;
  dirPath: string;
} {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) return { fileName: normalized, dirPath: "" };
  return {
    fileName: normalized.slice(lastSlash + 1) || normalized,
    dirPath: normalized.slice(0, lastSlash),
  };
}

const DiffFileSection: React.FC<DiffFileSectionProps> = ({
  file,
  defaultExpanded = true,
  expansionSignal = 0,
  repoPath,
  sectionRef,
  onRequestContent,
  hideDirectory = false,
  showBottomBorder = true,
  dataPath,
  showRenamePath = false,
  flat = false,
  noBottomPadding = false,
}) => {
  const { t } = useTranslation();
  const [manualExpanded, setManualExpanded] = useState<{
    signal: number;
    value: boolean;
  } | null>(null);
  const expanded =
    manualExpanded?.signal === expansionSignal
      ? manualExpanded.value
      : defaultExpanded;

  const containerRef = useRef<HTMLDivElement>(null);
  const setAddToAgent = useSetAtom(addToAgentAtom);

  const { fileName: displayName } = useMemo(
    () => getFileNameAndDir(getDisplayPath(file.path, repoPath)),
    [file.path, repoPath]
  );

  const handleAddToContext = useCallback(
    (text: string, _sessionId: string | null) => {
      setAddToAgent({
        type: "terminal",
        text,
        displayName: displayName || file.path,
      });
    },
    [setAddToAgent, displayName, file.path]
  );

  const {
    visible: dropdownVisible,
    position: dropdownPosition,
    selectedText,
    hideDropdown,
  } = useTextSelectionDropdown({
    source: "terminal",
    containerRef,
    onAddToContext: handleAddToContext,
    enabled: expanded,
  });

  const isDeleted = file.status === "deleted";

  useEffect(() => {
    if (!expanded) return;
    if (isDeleted) return;
    if (
      file.oldContent !== undefined ||
      file.newContent !== undefined ||
      file.unifiedDiff !== undefined
    ) {
      return;
    }
    onRequestContent?.(file);
  }, [expanded, file, isDeleted, onRequestContent]);

  const statusLetter = getStatusLetterForFile(file.status, file.staged);
  const statusColor = getStatusColor(statusLetter);

  const toggleExpanded = useCallback(() => {
    setManualExpanded({ signal: expansionSignal, value: !expanded });
  }, [expanded, expansionSignal]);

  const { additions, deletions } = useMemo(() => {
    if (file.additions !== undefined && file.deletions !== undefined) {
      return { additions: file.additions, deletions: file.deletions };
    }
    const oldLines = (file.oldContent || "").split("\n");
    const newLines = (file.newContent || "").split("\n");
    return {
      additions: Math.max(0, newLines.length - oldLines.length),
      deletions: Math.max(0, oldLines.length - newLines.length),
    };
  }, [file]);

  const resolvedDiff = useMemo(
    () => ({
      oldContent: file.oldContent,
      newContent: file.newContent,
      oldStartLine: file.oldStartLine,
      newStartLine: file.newStartLine,
    }),
    [file.newContent, file.newStartLine, file.oldContent, file.oldStartLine]
  );

  const hasContent =
    !file.isUnavailable &&
    (resolvedDiff.oldContent !== undefined ||
      resolvedDiff.newContent !== undefined ||
      file.unifiedDiff !== undefined);

  const isBinary =
    file.isBinary === true ||
    isBinaryByExtension(file.path) ||
    resolvedDiff.oldContent === "Binary file - content not displayed" ||
    resolvedDiff.newContent === "Binary file - content not displayed";

  const previewType = getPreviewType(file.path);
  const isPreviewable =
    isBinary &&
    previewType !== "binary" &&
    previewType !== "code" &&
    previewType !== "database" &&
    supportsSourceControlWorkingCopyPreview(previewType);
  const absoluteFilePath =
    file.path.startsWith("/") || !repoPath
      ? file.path
      : `${repoPath}/${file.path}`;

  function renderPreviewContent(): React.ReactNode {
    if (!isPreviewable || file.status === "deleted") return null;

    switch (previewType) {
      case "image":
        return (
          <LazyImagePreview filePath={absoluteFilePath} className="h-full" />
        );
      case "video":
        return (
          <LazyVideoPreview filePath={absoluteFilePath} className="h-full" />
        );
      case "pdf":
        return (
          <LazyPdfPreview filePath={absoluteFilePath} className="h-full" />
        );
      case "docx":
        return (
          <LazyDocxPreview filePath={absoluteFilePath} className="h-full" />
        );
      case "xlsx":
        return (
          <LazyXlsxPreview
            filePath={absoluteFilePath}
            className="h-full"
            readOnly
          />
        );
      case "pptx":
        return (
          <LazyPptxPreview filePath={absoluteFilePath} className="h-full" />
        );
      case "pages":
        return (
          <LazyPagesPreview filePath={absoluteFilePath} className="h-full" />
        );
      default:
        return null;
    }
  }

  const previewContent = renderPreviewContent();
  const displayPath = getDisplayPath(file.path, repoPath);
  const { fileName, dirPath } = getFileNameAndDir(displayPath);
  const originalDisplayPath = file.original_path
    ? getDisplayPath(file.original_path, repoPath)
    : null;
  const renamePath =
    showRenamePath &&
    file.status === "renamed" &&
    originalDisplayPath &&
    originalDisplayPath !== displayPath
      ? originalDisplayPath
      : null;

  const diffContent = (
    <div ref={containerRef}>
      {previewContent ? (
        <div className="h-[480px] min-h-[320px] overflow-hidden">
          <Suspense
            fallback={
              <Placeholder
                variant="loading"
                placement="detail-panel"
                fillParentHeight
              />
            }
          >
            {previewContent}
          </Suspense>
        </div>
      ) : isBinary ? (
        <Placeholder
          variant="empty"
          title={t("placeholders.previewUnavailable")}
          subtitle={displayPath}
        />
      ) : hasContent ? (
        <CodeMirrorDiff
          oldValue={resolvedDiff.oldContent || ""}
          newValue={resolvedDiff.newContent || ""}
          filePath={file.path}
          changeType={file.status}
          oldStartLine={resolvedDiff.oldStartLine}
          newStartLine={resolvedDiff.newStartLine}
          showLineNumbers={file.showLineNumbers !== false}
          viewMode="unified"
          readOnly={true}
          mergeControls={false}
          collapseUnchanged={true}
          noBottomPadding={noBottomPadding}
          autoHeight
        />
      ) : file.isUnavailable ? (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("placeholders.diffContentUnavailable")}
        />
      ) : (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          title={t("placeholders.loadingChanges")}
        />
      )}
    </div>
  );

  if (flat) {
    return (
      <>
        <div
          ref={sectionRef}
          className={showBottomBorder ? "border-b border-border-2" : undefined}
          data-diff-section-path={dataPath}
        >
          <FileHeader
            filePath={file.path}
            repoPath={repoPath}
            additions={additions}
            deletions={deletions}
            publishEnabled={false}
          />
          {diffContent}
        </div>
        <TextSelectionDropdown
          visible={dropdownVisible}
          position={dropdownPosition}
          selectedText={selectedText}
          source="terminal"
          onClose={hideDropdown}
          onAddToContext={handleAddToContext}
        />
      </>
    );
  }

  return (
    <>
      <div
        ref={sectionRef}
        className={showBottomBorder ? "border-b border-border-2" : undefined}
        data-diff-section-path={dataPath}
      >
        <button
          className={`sticky top-0 z-10 flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-fill-2 disabled:cursor-default disabled:hover:bg-transparent ${EDITOR_TAB_CANVAS_BG_CLASS}`}
          onClick={toggleExpanded}
          disabled={isDeleted}
        >
          {isDeleted ? (
            <span className="inline-block w-[14px] shrink-0" aria-hidden />
          ) : expanded ? (
            <ChevronDown size={14} className="shrink-0 text-text-3" />
          ) : (
            <ChevronRight size={14} className="shrink-0 text-text-3" />
          )}
          <FileTypeIcon
            fileName={file.path}
            size="small"
            className="shrink-0 text-text-2"
          />
          <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
            <span className="shrink-0 text-[13px] font-medium text-text-1">
              {fileName}
            </span>
            {!hideDirectory && dirPath ? (
              <span className="min-w-0 truncate text-[11px] text-text-2">
                {dirPath}
              </span>
            ) : null}
            {renamePath ? (
              <>
                <span className="shrink-0 text-[11px] text-text-3" aria-hidden>
                  ←
                </span>
                <span
                  className="min-w-0 truncate text-[11px] text-text-2"
                  title={`${displayPath} ← ${renamePath}`}
                >
                  {renamePath}
                </span>
              </>
            ) : null}
          </div>
          <DiffStatsBadge
            additions={additions}
            deletions={deletions}
            variant="compact"
          />
          <span className={`shrink-0 text-[11px] font-medium ${statusColor}`}>
            {statusLetter}
          </span>
        </button>

        {!isDeleted && expanded && diffContent}
      </div>
      <TextSelectionDropdown
        visible={dropdownVisible}
        position={dropdownPosition}
        selectedText={selectedText}
        source="terminal"
        onClose={hideDropdown}
        onAddToContext={handleAddToContext}
      />
    </>
  );
};

export default memo(DiffFileSection);
