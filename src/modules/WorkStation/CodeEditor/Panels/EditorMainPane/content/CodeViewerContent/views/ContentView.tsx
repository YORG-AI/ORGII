/**
 * ContentView Component
 *
 * Main content area for file viewing and editing.
 * Handles preview modes (markdown, HTML, JSON, CSV),
 * conflict editor, and regular CodeMirror editor.
 */
import { useAtom, useAtomValue } from "jotai";
import React, { Suspense, useCallback } from "react";
import { useTranslation } from "react-i18next";

import Markdown from "@src/components/MarkDown";
import {
  CodeMirrorConflictEditor,
  CodeMirrorEditor,
  type ConflictResolutionChoice,
} from "@src/features/CodeMirror";
import {
  FileHeader,
  TabBarBottomPanelToggle,
  UnsavedChangesBar,
} from "@src/modules/WorkStation/shared";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { EditorService } from "@src/services/workStation/EditorService";
import {
  editorHighlightActiveLineAtom,
  editorLineNumbersAtom,
  editorShowBlameAtom,
  editorShowMinimapAtom,
  editorWordWrapAtom,
} from "@src/store/ui/editorSettingsAtom";
import { activeStatusBarCallbacksAtom } from "@src/store/ui/workStationAtom";
import { stampStyleNonces } from "@src/util/iframeCspNonce";

import type { ContentViewProps } from "../types";
import { PlanFileActions } from "./PlanFileActions";
import SkillFrontmatterPanel, {
  parseSkillFrontmatter,
} from "./SkillFrontmatterPanel";

const LazyJsonTreeView = React.lazy(
  () => import("../../FilePreviewContent/JsonTreeView")
);
const LazyCsvTableView = React.lazy(
  () => import("../../FilePreviewContent/CsvTableView")
);
const LazyTextSelectionDropdown = React.lazy(
  () => import("@src/scaffold/ContextMenu/variants/TextSelectionDropdown")
);

export const ContentView: React.FC<ContentViewProps> = ({
  relativePath,
  repoPath,
  selectedFile,
  localContent,
  hasUnsavedChanges,
  isPreviewable,
  isPreviewMode,
  isMarkdown,
  isHtml,
  isJson,
  isCsv,
  fileHasConflicts,
  readOnly,
  isDeletedFile,
  saving,
  contentReady,
  gitBaseContent,
  savedContent,
  selectionDropdown,
  onFileSelect,
  onReload,
  onTogglePreview,
  onContentChange,
  onCursorChange,
  onTextSelection,
  onDiagnosticsChange,
  onResolveConflict,
  onSave,
  onDiscard,
  onPreviewSaveSuccess,
  onPreviewUnsavedChange,
  onAskAgent,
  onAddToContext,
  onCloseSelectionDropdown,
}) => {
  const { t } = useTranslation();
  const [lineNumbers, setLineNumbers] = useAtom(editorLineNumbersAtom);
  const [wordWrap, setWordWrap] = useAtom(editorWordWrapAtom);
  const [showMinimap, setShowMinimap] = useAtom(editorShowMinimapAtom);
  const [highlightActiveLine, setHighlightActiveLine] = useAtom(
    editorHighlightActiveLineAtom
  );
  const [showBlame, setShowBlame] = useAtom(editorShowBlameAtom);
  const { onOpenSettings } = useAtomValue(activeStatusBarCallbacksAtom);
  const isPlanFile = relativePath?.endsWith(".plan.md") ?? false;
  const isSkillFile =
    (relativePath?.endsWith("SKILL.md") ?? false) ||
    (selectedFile?.endsWith("SKILL.md") ?? false);
  const skillParsed =
    isSkillFile && isPreviewMode && isMarkdown
      ? parseSkillFrontmatter(localContent)
      : null;

  const handleSkillFrontmatterChange = React.useCallback(
    (newFullContent: string) => {
      onContentChange(newFullContent);
    },
    [onContentChange]
  );
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
  const canToggleBlame = !isDeletedFile;

  return (
    <>
      <FileHeader
        publishToHost="code"
        filePath={relativePath}
        repoPath={repoPath}
        onFileSelect={onFileSelect}
        onReload={onReload}
        onSave={readOnly ? undefined : onSave}
        onDiscard={readOnly ? undefined : onDiscard}
        onSearchRequest={
          !isPreviewMode && !fileHasConflicts ? handleSearchRequest : undefined
        }
        onGoToLineRequest={
          !isPreviewMode && !fileHasConflicts
            ? handleGoToLineRequest
            : undefined
        }
        relativePathToCopy={relativePath}
        lineNumbersEnabled={lineNumbers !== "off"}
        onLineNumbersChange={handleLineNumbersChange}
        wordWrapEnabled={wordWrap}
        onWordWrapChange={setWordWrap}
        minimapEnabled={showMinimap}
        onMinimapChange={setShowMinimap}
        highlightActiveLineEnabled={highlightActiveLine}
        onHighlightActiveLineChange={setHighlightActiveLine}
        showGitBlameToggle={canToggleBlame}
        gitBlameEnabled={showBlame}
        onGitBlameChange={setShowBlame}
        beforeMoreMenuSlot={<TabBarBottomPanelToggle />}
        onMoreSettings={onOpenSettings}
        loading={false}
        hasUnsavedChanges={hasUnsavedChanges}
        isMarkdownFile={isPreviewable}
        isPreviewMode={isPreviewMode}
        previewLabel={isCsv ? t("common:common.table") : undefined}
        onTogglePreview={onTogglePreview}
        extraActions={
          isPlanFile ? (
            <PlanFileActions planContent={localContent} />
          ) : undefined
        }
      />
      <div className="relative min-h-0 flex-1">
        {/* Preview modes */}
        {isPreviewMode && isMarkdown ? (
          <div className="markdown-preview-container h-full overflow-auto p-6">
            {skillParsed && (
              <SkillFrontmatterPanel
                frontmatter={skillParsed.frontmatter}
                body={skillParsed.body}
                readOnly={readOnly}
                onContentChange={handleSkillFrontmatterChange}
              />
            )}
            <Markdown
              textContent={skillParsed ? skillParsed.body : localContent}
              useChatCodeBlock
              skipPreprocess
            />
          </div>
        ) : isPreviewMode && isHtml ? (
          <div className="html-preview-container h-full w-full">
            <iframe
              srcDoc={stampStyleNonces(localContent)}
              title={t("tooltips.htmlPreview")}
              className="h-full w-full border-none bg-white"
              sandbox="allow-scripts allow-same-origin"
            />
          </div>
        ) : isPreviewMode && isJson ? (
          <Suspense
            fallback={
              <Placeholder
                variant="loading"
                placement="detail-panel"
                fillParentHeight
              />
            }
          >
            <LazyJsonTreeView content={localContent} className="h-full" />
          </Suspense>
        ) : isPreviewMode && isCsv ? (
          <Suspense
            fallback={
              <Placeholder
                variant="loading"
                placement="detail-panel"
                fillParentHeight
              />
            }
          >
            <LazyCsvTableView
              content={localContent}
              filePath={selectedFile}
              className="h-full"
              readOnly={readOnly || isDeletedFile}
              hasUnsavedChanges={hasUnsavedChanges}
              saving={saving}
              onContentChange={
                readOnly || isDeletedFile ? undefined : onContentChange
              }
              onSave={readOnly || isDeletedFile ? undefined : onSave}
              onDiscard={readOnly || isDeletedFile ? undefined : onDiscard}
              onSaveSuccess={onPreviewSaveSuccess}
              onUnsavedChange={onPreviewUnsavedChange}
            />
          </Suspense>
        ) : /* Conflict editor when file has merge conflicts */
        fileHasConflicts ? (
          <CodeMirrorConflictEditor
            content={localContent}
            filePath={selectedFile}
            readOnly={false}
            onChange={onContentChange}
            onResolveConflict={
              onResolveConflict as (
                id: string,
                choice: ConflictResolutionChoice
              ) => void
            }
            height="100%"
          />
        ) : (
          /* Regular CodeMirror editor */
          <CodeMirrorEditor
            value={localContent}
            // Dirty diff baseline:
            // - Wait for contentReady to avoid flash during file switching
            // - Use gitBaseContent (HEAD version) if file has git changes
            // - Otherwise use savedContent (disk version) for unsaved changes diff
            originalValue={
              !contentReady
                ? undefined
                : gitBaseContent !== undefined
                  ? gitBaseContent
                  : savedContent
            }
            filePath={selectedFile}
            height="100%"
            onChange={readOnly || isDeletedFile ? undefined : onContentChange}
            onCursorChange={onCursorChange}
            onTextSelection={
              readOnly || isDeletedFile ? undefined : onTextSelection
            }
            onDiagnosticsChange={
              readOnly || isDeletedFile ? undefined : onDiagnosticsChange
            }
            readOnly={readOnly || isDeletedFile}
            enableLinting={!readOnly && !isDeletedFile}
            isDeletedFile={isDeletedFile}
            enableGitBlame={showBlame && !isDeletedFile}
            repoPath={repoPath}
          />
        )}

        {/* Unsaved changes bar */}
        {hasUnsavedChanges && !(isPreviewMode && isCsv) && !readOnly && (
          <UnsavedChangesBar
            saving={saving}
            onSave={onSave}
            onDiscard={onDiscard}
          />
        )}

        {/* Text selection dropdown */}
        {selectionDropdown && !fileHasConflicts && !isPreviewMode && (
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
              onClose={onCloseSelectionDropdown}
              onAskAgent={onAskAgent}
              onAddToContext={onAddToContext}
            />
          </Suspense>
        )}
      </div>
    </>
  );
};

export default ContentView;
