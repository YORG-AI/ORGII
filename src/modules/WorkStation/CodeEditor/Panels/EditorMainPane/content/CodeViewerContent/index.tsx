/**
 * CodeViewerContent Component
 *
 * Content-only component for displaying file content with editing capability.
 * Tab bar is rendered by parent (RightPanel) - this only handles content area.
 *
 * Performance optimizations:
 * - Custom memo comparison to avoid re-renders on callback reference changes
 * - Only re-renders when actual data (file content, loading state) changes
 */
import React, { memo } from "react";

import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { getPreviewType } from "@src/util/file/previewTypes";

import { useCodeViewerHandlers } from "./hooks";
import type { CodeViewerContentProps } from "./types";
import { arePropsEqual, getRelativePath } from "./utils";
import { BinaryView, ContentView, ErrorView, LoadingView } from "./views";

export type { CodeViewerContentProps } from "./types";

type CodeViewerContentWithFileProps = CodeViewerContentProps & {
  selectedFile: string;
};

const CodeViewerContentInner: React.FC<CodeViewerContentWithFileProps> = (
  props
) => {
  const {
    selectedFile,
    fileContent,
    loading,
    error,
    repoPath,
    hasUnsavedChanges = false,
    saving = false,
    requiresFilePreviewRoute = false,
    readOnly = false,
    contentReady = true,
    gitBaseContent,
    savedContent,
    isDeletedFile = false,
  } = props;

  const {
    localContent,
    selectionDropdown,
    isPreviewMode,
    isMarkdown,
    isHtml,
    isJson,
    isCsv,
    isPreviewable,
    fileHasConflicts,
    handleContentChange,
    handleCursorChange,
    handleTextSelection,
    handleSave,
    handleDiscard,
    handleReload,
    handleFileSelect,
    handleTogglePreview,
    handleResolveConflict,
    handleAskAgent,
    handleAddToContext,
    handleCloseSelectionDropdown,
  } = useCodeViewerHandlers(props);

  const relativePath = getRelativePath(selectedFile, repoPath);

  if (loading) {
    return (
      <LoadingView
        relativePath={relativePath}
        repoPath={repoPath}
        hasUnsavedChanges={hasUnsavedChanges}
        isPreviewable={isPreviewable}
        isPreviewMode={isPreviewMode}
        saving={saving}
        onFileSelect={handleFileSelect}
        onReload={handleReload}
        onTogglePreview={handleTogglePreview}
        onSave={handleSave}
        onDiscard={handleDiscard}
      />
    );
  }

  if (error) {
    return (
      <ErrorView
        relativePath={relativePath}
        repoPath={repoPath}
        selectedFile={selectedFile}
        error={error}
        hasUnsavedChanges={hasUnsavedChanges}
        isPreviewable={isPreviewable}
        isPreviewMode={isPreviewMode}
        onFileSelect={handleFileSelect}
        onReload={handleReload}
        onTogglePreview={handleTogglePreview}
      />
    );
  }

  if (requiresFilePreviewRoute) {
    return (
      <BinaryView
        relativePath={relativePath}
        repoPath={repoPath}
        selectedFile={selectedFile}
        fileContent={fileContent}
        previewType={getPreviewType(selectedFile)}
        readOnly={readOnly}
        onFileSelect={handleFileSelect}
        onReload={handleReload}
        onSaveSuccess={props.onSaveSuccess}
        onUnsavedChange={props.onBinaryUnsavedChange}
      />
    );
  }

  return (
    <ContentView
      relativePath={relativePath}
      repoPath={repoPath}
      selectedFile={selectedFile}
      localContent={localContent}
      hasUnsavedChanges={hasUnsavedChanges}
      isPreviewable={isPreviewable}
      isPreviewMode={isPreviewMode}
      isMarkdown={isMarkdown}
      isHtml={isHtml}
      isJson={isJson}
      isCsv={isCsv}
      fileHasConflicts={fileHasConflicts}
      readOnly={readOnly}
      isDeletedFile={isDeletedFile}
      saving={saving}
      contentReady={contentReady}
      gitBaseContent={gitBaseContent}
      savedContent={savedContent}
      selectionDropdown={selectionDropdown}
      onFileSelect={handleFileSelect}
      onReload={handleReload}
      onTogglePreview={handleTogglePreview}
      onContentChange={handleContentChange}
      onCursorChange={handleCursorChange}
      onTextSelection={handleTextSelection}
      onResolveConflict={
        handleResolveConflict as (conflictId: string, choice: unknown) => void
      }
      onSave={handleSave}
      onDiscard={handleDiscard}
      onPreviewSaveSuccess={props.onSaveSuccess}
      onPreviewUnsavedChange={props.onBinaryUnsavedChange}
      onAskAgent={handleAskAgent}
      onAddToContext={handleAddToContext}
      onCloseSelectionDropdown={handleCloseSelectionDropdown}
    />
  );
};

export const CodeViewerContent: React.FC<CodeViewerContentProps> = memo(
  (props) => {
    if (!props.selectedFile) {
      return <Placeholder variant="no-file" fillParentHeight />;
    }

    return (
      <CodeViewerContentInner {...props} selectedFile={props.selectedFile} />
    );
  },
  arePropsEqual
);

CodeViewerContent.displayName = "CodeViewerContent";

export default CodeViewerContent;
