/**
 * GitDiffContent Component
 *
 * Content-only component for displaying git diff.
 * Tab bar is rendered by parent (RightPanel) - this only handles content area.
 * Supports unified/split diff views and conflict resolution.
 *
 * Performance optimizations:
 * - Custom memo comparison to avoid rerenders on callback reference changes
 * - Uses refs for callbacks to prevent child component rebuilds
 */
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
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

import { Message } from "@src/components/Message";
import { useGitStatus } from "@src/contexts/git";
import {
  CodeMirrorConflictEditor,
  CodeMirrorDiff,
  type ConflictResolutionChoice,
  type TextSelectionInfo,
  hasConflictMarkers,
} from "@src/features/CodeMirror";
import { createLogger } from "@src/hooks/logger";
import {
  type DiffViewMode,
  FileHeader,
  FloatingBar,
} from "@src/modules/WorkStation/shared";
import { HUMANTOOLS_TEXT_KEYS } from "@src/modules/WorkStation/shared/textTokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { EditorService } from "@src/services/workStation/EditorService";
import {
  activeStationChatVisibleAtom,
  activeStatusBarCallbacksAtom,
  addToAgentAtom,
  editorHighlightActiveLineAtom,
  editorLineNumbersAtom,
  editorWordWrapAtom,
} from "@src/store/ui";
import type { GitFile } from "@src/types/git/types";
import { isBinaryByExtension } from "@src/util/file/binaryDetection";
import {
  getPreviewType,
  supportsSourceControlWorkingCopyPreview,
} from "@src/util/file/previewTypes";

import { useGitDiffLoader } from "./useGitDiffLoader";

const log = createLogger("GitDiffContent");

const LazyTextSelectionDropdown = React.lazy(
  () => import("@src/scaffold/ContextMenu/variants/TextSelectionDropdown")
);

const LazyImagePreview = React.lazy(
  () => import("../FilePreviewContent/ImagePreview")
);
const LazyVideoPreview = React.lazy(
  () => import("../FilePreviewContent/VideoPreview")
);
const LazyPdfPreview = React.lazy(
  () => import("../FilePreviewContent/PdfPreview")
);
const LazyDocxPreview = React.lazy(
  () => import("../FilePreviewContent/DocxPreview")
);
const LazyXlsxPreview = React.lazy(
  () => import("../FilePreviewContent/XlsxPreview")
);
const LazyPptxPreview = React.lazy(
  () => import("../FilePreviewContent/PptxPreview")
);
const LazyPagesPreview = React.lazy(
  () => import("../FilePreviewContent/PagesPreview")
);

// ============================================
// Types
// ============================================

export interface GitDiffContentProps {
  /** Selected git file with diff content */
  gitFile: GitFile | null;
  /** Loading state */
  loading: boolean;
  /** Repository path */
  repoPath?: string;
  /** Callback when conflict is resolved */
  onResolveConflict?: (
    filePath: string,
    conflictId: string,
    choice: ConflictResolutionChoice
  ) => void;
  /** Callback when file content changes (for conflict resolution) */
  onContentChange?: (filePath: string, newContent: string) => void;
  /** Callback when reload is requested */
  onReload?: () => void;
  /** Callback when a file is selected from breadcrumb dropdown */
  onFileSelect?: (filePath: string) => void;
  /** Dismiss the focused file preview. */
  onClose?: () => void;
  /** Notify parent when local unsaved state changes (tab bar dot vs close) */
  onUnsavedChange?: (hasUnsaved: boolean) => void;
  /** Optional content rendered before the breadcrumb in the file header. */
  leadingHeaderSlot?: React.ReactNode;
  /**
   * When true, the file header is published into the global workstation tab
   * header. Source Control focus mode renders it inline above the diff editor.
   */
  publishHeaderToWorkstation?: boolean;
  /**
   * Optional node rendered in place of the default "select a file to view
   * changes" placeholder when no file is resolved. Source Control focus mode
   * passes its quick-actions placeholder here; regular diff tabs omit it and
   * keep the plain text placeholder.
   */
  emptyState?: React.ReactNode;
}

// ============================================
// Custom memo comparison - prevents rerenders on callback changes
// ============================================

function arePropsEqual(
  prevProps: GitDiffContentProps,
  nextProps: GitDiffContentProps
): boolean {
  // Compare data props strictly
  if (prevProps.loading !== nextProps.loading) return false;
  if (prevProps.repoPath !== nextProps.repoPath) return false;

  // Compare gitFile by its key values, not reference
  const prevFile = prevProps.gitFile;
  const nextFile = nextProps.gitFile;

  if (!prevFile && !nextFile) {
    // Both null, consider equal
  } else if (!prevFile || !nextFile) {
    return false; // One null, one not
  } else {
    // Compare by actual content
    if (prevFile.path !== nextFile.path) return false;
    if (prevFile.oldContent !== nextFile.oldContent) return false;
    if (prevFile.newContent !== nextFile.newContent) return false;
    if (prevFile.status !== nextFile.status) return false;
  }

  // Only check callback existence, not reference
  if (!!prevProps.onResolveConflict !== !!nextProps.onResolveConflict)
    return false;
  if (!!prevProps.onContentChange !== !!nextProps.onContentChange) return false;
  if (!!prevProps.onReload !== !!nextProps.onReload) return false;
  if (!!prevProps.onUnsavedChange !== !!nextProps.onUnsavedChange) return false;
  if (!!prevProps.onClose !== !!nextProps.onClose) return false;
  if (prevProps.leadingHeaderSlot !== nextProps.leadingHeaderSlot) return false;
  if (
    prevProps.publishHeaderToWorkstation !==
    nextProps.publishHeaderToWorkstation
  )
    return false;
  if (!!prevProps.emptyState !== !!nextProps.emptyState) return false;
  return true;
}

// ============================================
// Callback refs type
// ============================================

interface CallbackRefs {
  onResolveConflict?: GitDiffContentProps["onResolveConflict"];
  onContentChange?: GitDiffContentProps["onContentChange"];
  onReload?: GitDiffContentProps["onReload"];
  onClose?: GitDiffContentProps["onClose"];
}

interface SelectionDropdownState {
  visible: boolean;
  position: { x: number; y: number };
  text: string;
  fromLine: number;
  toLine: number;
}

// ============================================
// Main Component
// ============================================

const GitDiffContentInner: React.FC<GitDiffContentProps> = ({
  gitFile,
  loading,
  repoPath = "",
  onResolveConflict,
  onContentChange,
  onReload,
  onFileSelect,
  onClose,
  onUnsavedChange,
  leadingHeaderSlot,
  publishHeaderToWorkstation = true,
  emptyState,
}) => {
  const { t } = useTranslation();
  const [lineNumbers, setLineNumbers] = useAtom(editorLineNumbersAtom);
  const [wordWrap, setWordWrap] = useAtom(editorWordWrapAtom);
  const [highlightActiveLine, setHighlightActiveLine] = useAtom(
    editorHighlightActiveLineAtom
  );
  const { onOpenSettings } = useAtomValue(activeStatusBarCallbacksAtom);
  const setAddToAgent = useSetAtom(addToAgentAtom);
  const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);
  const [selectionDropdown, setSelectionDropdown] =
    useState<SelectionDropdownState | null>(null);
  const selectionDropdownRef = useRef(selectionDropdown);

  useEffect(() => {
    selectionDropdownRef.current = selectionDropdown;
  }, [selectionDropdown]);

  // ============================================
  // Callback refs for stable handler references
  // ============================================
  const callbackRefs = useRef<CallbackRefs>({});

  useEffect(() => {
    callbackRefs.current = {
      onResolveConflict,
      onContentChange,
      onReload,
      onClose,
    };
  });

  // View mode state for diff display
  const [viewMode, setViewMode] = useState<DiffViewMode>("unified");

  // Local state for edited content
  const [editedContent, setEditedContent] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset edited content when git file changes
  useEffect(() => {
    setEditedContent(null);
    setHasUnsavedChanges(false);
  }, [gitFile?.path]);

  const onUnsavedChangeRef = useRef(onUnsavedChange);
  useEffect(() => {
    onUnsavedChangeRef.current = onUnsavedChange;
  });

  useEffect(() => {
    onUnsavedChangeRef.current?.(hasUnsavedChanges);
  }, [hasUnsavedChanges]);

  const { effectiveGitFile, selfFetching } = useGitDiffLoader({
    gitFile,
    repoPath,
  });

  // Check if the file has merge conflict markers — reads from effective
  // content so the self-fetched diff feeds into conflict detection.
  const fileHasConflicts = useMemo(() => {
    const content = editedContent ?? effectiveGitFile?.newContent ?? "";
    return hasConflictMarkers(content);
  }, [editedContent, effectiveGitFile?.newContent]);

  const handleTextSelection = useCallback(
    (selection: TextSelectionInfo | null) => {
      if (selection && effectiveGitFile?.path) {
        setSelectionDropdown({
          visible: true,
          position: selection.position,
          text: selection.text,
          fromLine: selection.fromLine,
          toLine: selection.toLine,
        });
      } else {
        setSelectionDropdown(null);
      }
    },
    [effectiveGitFile?.path]
  );

  const handleCloseSelectionDropdown = useCallback(() => {
    setSelectionDropdown(null);
  }, []);

  const handleCloseFocus = useCallback(() => {
    callbackRefs.current.onClose?.();
  }, []);

  const handleAskAgent = useCallback(
    (_text: string) => {
      const currentSelection = selectionDropdownRef.current;
      if (!effectiveGitFile?.path || !currentSelection) return;

      const fileName =
        effectiveGitFile.path.split("/").pop() || effectiveGitFile.path;

      setStationChatVisible("my-station", true);
      setAddToAgent({
        type: "lines",
        filePath: effectiveGitFile.path,
        fileName,
        lineStart: currentSelection.fromLine,
        lineEnd: currentSelection.toLine,
      });

      Message.success(
        t("workstation.addedToAgent", {
          fileName: `Lines ${currentSelection.fromLine}~${currentSelection.toLine}`,
        })
      );
    },
    [effectiveGitFile?.path, setAddToAgent, setStationChatVisible, t]
  );

  const handleAddToContext = useCallback(
    (_text: string, _sessionId: string | null) => {
      if (!effectiveGitFile?.path) return;

      const fileName =
        effectiveGitFile.path.split("/").pop() || effectiveGitFile.path;

      setStationChatVisible("my-station", true);
      setAddToAgent({
        type: "file",
        filePath: effectiveGitFile.path,
        fileName,
      });

      Message.success(t("workstation.addedToAgent", { fileName }));
    },
    [effectiveGitFile?.path, setAddToAgent, setStationChatVisible, t]
  );

  // Store gitFile in ref for stable callback access
  const gitFileRef = useRef(effectiveGitFile);
  useEffect(() => {
    gitFileRef.current = effectiveGitFile;
  });

  // Handle content changes in the diff editor - uses refs
  const handleContentChange = useCallback((newContent: string) => {
    const currentGitFile = gitFileRef.current;
    setEditedContent(newContent);
    setHasUnsavedChanges(newContent !== currentGitFile?.newContent);
    // Notify parent of content change (for conflict resolution)
    if (currentGitFile?.path) {
      callbackRefs.current.onContentChange?.(currentGitFile.path, newContent);
    }
  }, []);

  // Handle conflict resolution - uses refs
  const handleResolveConflict = useCallback(
    (conflictId: string, choice: ConflictResolutionChoice) => {
      const currentGitFile = gitFileRef.current;
      if (currentGitFile?.path) {
        callbackRefs.current.onResolveConflict?.(
          currentGitFile.path,
          conflictId,
          choice
        );
      }
    },
    []
  );

  // Handle reload - uses refs
  const handleReload = useCallback(() => {
    callbackRefs.current.onReload?.();
  }, []);

  const handleSearchRequest = useCallback(() => {
    EditorService.find();
  }, []);

  const handleGoToLineRequest = useCallback(() => {
    EditorService.openGoToLinePanel();
  }, []);

  const handleLineNumbersChange = useCallback(
    (enabled: boolean) => {
      setLineNumbers(enabled ? "on" : "off");
    },
    [setLineNumbers]
  );

  const handleDiscard = useCallback(() => {
    setEditedContent(null);
    setHasUnsavedChanges(false);
  }, []);

  // Git status context for refreshing after save
  const { forceRefresh } = useGitStatus();

  // Handle save
  const handleSave = useCallback(async () => {
    if (!gitFile || !editedContent || !hasUnsavedChanges) return;

    setSaving(true);
    try {
      // Write file using Tauri fs
      await writeTextFile(gitFile.path, editedContent);
      setHasUnsavedChanges(false);
      // Refresh git status so source control panel updates immediately
      forceRefresh();
    } catch (error) {
      log.error("[GitDiffContent] Save error:", error);
    } finally {
      setSaving(false);
    }
  }, [gitFile, editedContent, hasUnsavedChanges, forceRefresh]);

  // Keyboard shortcut for save (Cmd/Ctrl+S)
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave]);

  // Loading spinner only when we have nothing else to show. Once a file
  // diff has been resolved we keep rendering it (and its FileHeader) even
  // if `loading` flicks back to true on the next git-status refresh —
  // otherwise the teleported breadcrumb / pill in the workstation tab-header
  // strip would pop in and out on every poll.
  if (loading && !effectiveGitFile) {
    return (
      <Placeholder
        variant="loading"
        placement="detail-panel"
        fillParentHeight
      />
    );
  }

  // No file selected. Source Control focus mode passes a quick-actions
  // placeholder via `emptyState`; regular diff tabs fall back to the plain
  // "select a file to view changes" text.
  if (!effectiveGitFile) {
    if (emptyState) {
      return <>{emptyState}</>;
    }
    return (
      <Placeholder
        variant="empty"
        placement="detail-panel"
        title={t("placeholders.selectFileToViewChanges")}
        fillParentHeight
      />
    );
  }

  // Content still missing — either the self-fetch is in flight or the parent
  // is still hydrating `gitDiffState.filesByPath`. Show a loading spinner
  // rather than fall through to the empty-content "file not found" branch.
  if (effectiveGitFile.oldContent === undefined) {
    return (
      <Placeholder
        variant="loading"
        placement="detail-panel"
        fillParentHeight
      />
    );
  }

  const effectiveRepoPath = effectiveGitFile.repoRoot ?? repoPath;
  const absoluteFilePath = effectiveGitFile.path.startsWith("/")
    ? effectiveGitFile.path
    : `${effectiveRepoPath}/${effectiveGitFile.path}`;
  const relativePath = effectiveGitFile.path.startsWith(effectiveRepoPath + "/")
    ? effectiveGitFile.path.slice(effectiveRepoPath.length + 1)
    : effectiveGitFile.path;

  // getPreviewType drives all binary routing — single source of truth
  const previewType = getPreviewType(effectiveGitFile.path);
  const isBinaryPreviewType =
    previewType !== "code" &&
    previewType !== "markdown" &&
    previewType !== "html" &&
    previewType !== "json" &&
    previewType !== "csv";

  // File not found or empty content (VSCode-style error)
  // Only show error if BOTH old and new are empty (file doesn't exist at either point)
  const oldContentEmpty =
    !effectiveGitFile.oldContent || effectiveGitFile.oldContent.trim() === "";
  const newContentEmpty =
    !effectiveGitFile.newContent || effectiveGitFile.newContent.trim() === "";

  // A file is binary if the diff cache set the sentinel OR the extension is binary
  const isBinaryFile =
    effectiveGitFile.oldContent === "Binary file - content not displayed" ||
    effectiveGitFile.newContent === "Binary file - content not displayed";
  const isBinary = isBinaryFile || isBinaryByExtension(effectiveGitFile.path);

  // Route all binary/previewable files through a single switch on previewType.
  // This covers both sentinel-tagged files and untracked/new files that never
  // get a sentinel (e.g. a newly added PNG in source control).
  if (isBinary || isBinaryPreviewType) {
    const isDeleted = effectiveGitFile.status === "deleted";

    const fileHeader = (
      <FileHeader
        publishToHost={publishHeaderToWorkstation ? "code" : undefined}
        leadingSlot={leadingHeaderSlot}
        filePath={effectiveGitFile.path}
        repoPath={repoPath}
        additions={effectiveGitFile.additions}
        deletions={effectiveGitFile.deletions}
        onReload={onReload ? handleReload : undefined}
        relativePathToCopy={relativePath}
        lineNumbersEnabled={lineNumbers !== "off"}
        onLineNumbersChange={handleLineNumbersChange}
        wordWrapEnabled={wordWrap}
        onWordWrapChange={setWordWrap}
        highlightActiveLineEnabled={highlightActiveLine}
        onHighlightActiveLineChange={setHighlightActiveLine}
        onMoreSettings={onOpenSettings}
        loading={loading || selfFetching}
        onFileSelect={onFileSelect}
        showOpenFileAction={!!onFileSelect}
        onClose={onClose ? handleCloseFocus : undefined}
      />
    );

    // Non-deleted previewable binary types: show the working-copy preview
    let PreviewEl: React.ReactNode = null;
    if (!isDeleted && supportsSourceControlWorkingCopyPreview(previewType)) {
      switch (previewType) {
        case "image":
          PreviewEl = (
            <LazyImagePreview filePath={absoluteFilePath} className="flex-1" />
          );
          break;
        case "video":
          PreviewEl = (
            <LazyVideoPreview filePath={absoluteFilePath} className="flex-1" />
          );
          break;
        case "pdf":
          PreviewEl = (
            <LazyPdfPreview filePath={absoluteFilePath} className="flex-1" />
          );
          break;
        case "docx":
          PreviewEl = (
            <LazyDocxPreview filePath={absoluteFilePath} className="flex-1" />
          );
          break;
        case "xlsx":
          PreviewEl = (
            <LazyXlsxPreview
              filePath={absoluteFilePath}
              className="flex-1"
              readOnly
            />
          );
          break;
        case "pptx":
          PreviewEl = (
            <LazyPptxPreview filePath={absoluteFilePath} className="flex-1" />
          );
          break;
        case "pages":
          PreviewEl = (
            <LazyPagesPreview filePath={absoluteFilePath} className="flex-1" />
          );
          break;
        default:
          break;
      }
    }

    if (PreviewEl) {
      return (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {fileHeader}
          <div className="flex min-h-0 flex-1 flex-col">
            <Suspense
              fallback={
                <Placeholder
                  variant="loading"
                  placement="detail-panel"
                  fillParentHeight
                />
              }
            >
              {PreviewEl}
            </Suspense>
          </div>
        </div>
      );
    }

    // Deleted or unsupported binary — single informational placeholder
    return (
      <div className="relative flex min-h-0 flex-1 flex-col">
        {fileHeader}
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("placeholders.previewUnavailable")}
          subtitle={relativePath}
          fillParentHeight
        />
      </div>
    );
  }

  if (oldContentEmpty && newContentEmpty) {
    return (
      <Placeholder
        variant="empty"
        placement="detail-panel"
        title={t("placeholders.editorCouldNotOpenFileMissing")}
        subtitle={effectiveGitFile.path}
        fillParentHeight
      />
    );
  }

  // Show diff with header
  return (
    <>
      {/* File header with view mode toggle */}
      <FileHeader
        publishToHost={publishHeaderToWorkstation ? "code" : undefined}
        leadingSlot={leadingHeaderSlot}
        filePath={effectiveGitFile.path}
        repoPath={repoPath}
        additions={effectiveGitFile.additions}
        deletions={effectiveGitFile.deletions}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onReload={onReload ? handleReload : undefined}
        onSave={viewMode === "unified" ? handleSave : undefined}
        onDiscard={viewMode === "unified" ? handleDiscard : undefined}
        onSearchRequest={handleSearchRequest}
        onGoToLineRequest={handleGoToLineRequest}
        relativePathToCopy={relativePath}
        lineNumbersEnabled={lineNumbers !== "off"}
        onLineNumbersChange={handleLineNumbersChange}
        wordWrapEnabled={wordWrap}
        onWordWrapChange={setWordWrap}
        highlightActiveLineEnabled={highlightActiveLine}
        onHighlightActiveLineChange={setHighlightActiveLine}
        onMoreSettings={onOpenSettings}
        loading={loading || selfFetching}
        hasUnsavedChanges={hasUnsavedChanges}
        onFileSelect={onFileSelect}
        showOpenFileAction={!!onFileSelect}
        onClose={onClose ? handleCloseFocus : undefined}
      />

      {/* Content - Conflict Editor or Diff View */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {fileHasConflicts ? (
          /* Conflict Resolution Editor */
          <CodeMirrorConflictEditor
            content={editedContent ?? (effectiveGitFile.newContent || "")}
            filePath={effectiveGitFile.path}
            readOnly={false}
            onChange={handleContentChange}
            onResolveConflict={handleResolveConflict}
            height="100%"
          />
        ) : (
          /* Regular Diff View */
          <CodeMirrorDiff
            oldValue={effectiveGitFile.oldContent || ""}
            newValue={editedContent ?? (effectiveGitFile.newContent || "")}
            filePath={effectiveGitFile.path}
            changeType={effectiveGitFile.status}
            height="100%"
            viewMode={viewMode}
            readOnly={viewMode === "split"}
            mergeControls={false}
            collapseUnchanged={true}
            onChange={viewMode === "unified" ? handleContentChange : undefined}
            onTextSelection={handleTextSelection}
          />
        )}

        {selectionDropdown && !fileHasConflicts && (
          <Suspense fallback={null}>
            <LazyTextSelectionDropdown
              visible={selectionDropdown.visible}
              position={selectionDropdown.position}
              selectedText={selectionDropdown.text}
              source="editor"
              lineRange={{
                fromLine: selectionDropdown.fromLine,
                toLine: selectionDropdown.toLine,
              }}
              onClose={handleCloseSelectionDropdown}
              onAskAgent={handleAskAgent}
              onAddToContext={handleAddToContext}
            />
          </Suspense>
        )}

        {((!fileHasConflicts && viewMode === "unified" && hasUnsavedChanges) ||
          (fileHasConflicts && hasUnsavedChanges)) && (
          <FloatingBar.Layer>
            {!fileHasConflicts &&
              viewMode === "unified" &&
              hasUnsavedChanges && (
                <FloatingBar
                  variant="unsaved"
                  message={t(HUMANTOOLS_TEXT_KEYS.placeholders.unsavedEdits)}
                  saving={saving}
                  onSave={handleSave}
                  onDiscard={handleDiscard}
                />
              )}
            {fileHasConflicts && hasUnsavedChanges && (
              <FloatingBar
                variant="unsaved"
                message={t(
                  HUMANTOOLS_TEXT_KEYS.placeholders.unsavedConflictResolutions
                )}
                saving={saving}
                onSave={handleSave}
                onDiscard={handleDiscard}
              />
            )}
          </FloatingBar.Layer>
        )}
      </div>
    </>
  );
};

// Memoize with custom comparison to prevent rerenders on callback changes
export const GitDiffContent = memo(GitDiffContentInner, arePropsEqual);

GitDiffContent.displayName = "GitDiffContent";

export default GitDiffContent;
