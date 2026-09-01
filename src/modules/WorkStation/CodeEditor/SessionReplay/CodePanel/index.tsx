/**
 * CodePanel Component
 *
 * Displays file content, diff, or search results in the top panel.
 * Supports combined diff view for consolidated file operations.
 * Uses shared FileHeader with breadcrumbs and code/preview toggle.
 */
import { useAtomValue } from "jotai";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import { getToolDisplayBehavior } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { TOOL_DISPLAY_BEHAVIOR } from "@src/engines/SessionCore/rendering/registry/types";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import { VirtualizedModernDiff } from "@src/features/CodeViewer/VirtualizedModernDiff";
import { ComputerTerminal01Icon, HugeiconsIcon } from "@src/icons";
import { ImagePreview } from "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/FilePreviewContent/ImagePreview";
import {
  NoTabsPlaceholder,
  useSimulatorAwaitingAgentCaption,
  useSimulatorPlaceholderActions,
} from "@src/modules/WorkStation/shared";
import { SelectedTextAddToChat } from "@src/modules/WorkStation/shared/SelectedTextAddToChat";
import { HEADER_ICON_SIZE } from "@src/modules/WorkStation/shared/tokens";
import { FileHeader } from "@src/modules/shared/components/FileHeader";
import { simulatorEffectiveDockAppAtom } from "@src/store/ui/simulatorAtom";
import { getFileName } from "@src/util/file/pathUtils";
import {
  getPreviewType,
  supportsPreviewToggle,
} from "@src/util/file/previewTypes";
import { deriveToolAction } from "@src/util/ui/rendering/toolAction";

import { shouldTrustDiffStartLines } from "../converters/fileConverter";
import { resolveFileOperationPayload } from "../resolveFilePayload";
import {
  CODE_PANEL_MODE,
  type ExploreOperationEntry,
  FILE_OPERATION_TYPE,
} from "../types";
import {
  getExploreDisplayName,
  getExploreDisplayParts,
} from "../utils/exploreDisplayUtils";
import { CombinedDiffView } from "./CombinedDiffView";
import { PreviewContent } from "./PreviewContent";
import { SearchResultsContent } from "./SearchResultsContent";
import { SessionReplayCodeMirrorViewer } from "./SessionReplayCodeMirrorViewer";
import { TerminalContent } from "./TerminalContent";
import { ToolPanel } from "./ToolPanel";
import { simulatorSearchHeaderIcon } from "./searchIcons";
import type { CodePanelProps, PreviewModeState } from "./types";
import { useLiveReadFileContent } from "./useLiveReadFileContent";

// Re-export atomic components for SimulatorVariant usage
export { SessionReplayCodeMirrorViewer } from "./SessionReplayCodeMirrorViewer";
export { SearchResultsContent } from "./SearchResultsContent";

/**
 * Header for the simulator's explore panel.
 *
 * Mirrors the chat panel's `SearchBlock` / `GlobBlock` header text: the
 * current lifecycle label (e.g. "Searching code" / "Found files") followed
 * by the active pattern/query as a subtitle. Keeping a single source of
 * truth for the labels guarantees the two surfaces stay in sync.
 */
const ExploreHeader: React.FC<{
  operation: ExploreOperationEntry;
  publishEnabled: boolean;
}> = memo(({ operation, publishEnabled }) => {
  const funcName = operation.event?.functionName || "";
  const titleParts = getExploreDisplayParts(operation);
  const titleText = getExploreDisplayName(operation);

  return (
    <FileHeader
      filePath={funcName}
      disableNavigation
      useFileTypeIcon={false}
      headerIcon={simulatorSearchHeaderIcon(funcName)}
      publishToHost="simulator"
      publishEnabled={publishEnabled}
      titleSlot={
        <div
          className="flex min-w-0 items-center gap-1.5 text-[12px]"
          title={titleText}
        >
          <span className="shrink-0 font-medium text-text-1">
            {titleParts.primary}
          </span>
          {titleParts.secondary ? (
            <>
              <span className="shrink-0 text-text-4">·</span>
              <span className="min-w-0 truncate text-text-3">
                {titleParts.secondary}
              </span>
            </>
          ) : null}
        </div>
      }
    />
  );
});

ExploreHeader.displayName = "ExploreHeader";

export const CodePanel: React.FC<CodePanelProps> = memo(
  ({
    operation,
    exploreOperation,
    shellOperation,
    toolOperation,
    mode = CODE_PANEL_MODE.FILE,
    sessionReplayMode = "simulation",
    isLoading = false,
  }) => {
    const { t } = useTranslation("sessions");
    const effectiveDockApp = useAtomValue(simulatorEffectiveDockAppAtom);
    const publishHeaderToSimulator = effectiveDockApp === AppType.CODE_EDITOR;
    const simulatorPlaceholderActions =
      useSimulatorPlaceholderActions(sessionReplayMode);
    const simulatorAwaitingAgentCaption = useSimulatorAwaitingAgentCaption();
    const [previewModeState, setPreviewModeState] =
      useState<PreviewModeState | null>(null);

    const currentFilePath =
      mode === CODE_PANEL_MODE.FILE ? operation?.filePath : undefined;

    const isPreviewMode =
      currentFilePath && previewModeState?.filePath === currentFilePath
        ? previewModeState.active
        : false;

    const handleTogglePreview = useCallback(() => {
      if (!currentFilePath) return;
      setPreviewModeState((prev) =>
        prev?.filePath === currentFilePath
          ? { filePath: currentFilePath, active: !prev.active }
          : { filePath: currentFilePath, active: true }
      );
    }, [currentFilePath]);

    const resolvedPayload = useMemo(
      () => (operation ? resolveFileOperationPayload(operation) : null),
      [operation]
    );

    const operationDisplayBehavior = useMemo(() => {
      if (!operation) return TOOL_DISPLAY_BEHAVIOR.WAIT_FOR_RESULT;
      const action = deriveToolAction(
        operation.event.functionName,
        operation.event.args
      );
      return getToolDisplayBehavior(operation.event.functionName, action);
    }, [operation]);

    const shouldLoadLiveReadContent = Boolean(
      operationDisplayBehavior === TOOL_DISPLAY_BEHAVIOR.INSTANT &&
      operation?.type === FILE_OPERATION_TYPE.READ &&
      operation.isLoading &&
      resolvedPayload?.content === undefined &&
      getPreviewType(operation.filePath) !== "image"
    );
    const liveReadContent = useLiveReadFileContent(
      operation?.filePath,
      shouldLoadLiveReadContent
    );

    if (mode === CODE_PANEL_MODE.TERMINAL) {
      if (!shellOperation) {
        return isLoading ? (
          <Placeholder
            variant="loading"
            placement="detail-panel"
            fillParentHeight
          />
        ) : (
          <NoTabsPlaceholder
            icon="editor"
            caption={simulatorAwaitingAgentCaption}
            actions={simulatorPlaceholderActions}
          />
        );
      }

      const shellHeaderLabel =
        shellOperation.commandKeywords ||
        shellOperation.shortCommand ||
        t("simulator.replay.ide.shell.noCommand");

      return (
        <div className="flex h-full w-full flex-col overflow-hidden">
          <FileHeader
            filePath={shellHeaderLabel}
            plainTitle
            disableNavigation
            useFileTypeIcon={false}
            publishToHost="simulator"
            publishEnabled={publishHeaderToSimulator}
            headerIcon={
              <HugeiconsIcon
                icon={ComputerTerminal01Icon}
                data-icon="terminal"
                size={HEADER_ICON_SIZE.sm}
                className="shrink-0 text-text-2"
              />
            }
          />
          {shellOperation.isFailed ? (
            <Placeholder
              variant="error"
              placement="detail-panel"
              fillParentHeight
              title={t("tools.failedPlaceholder")}
            />
          ) : (
            <div className="code-viewer-scroll-container relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-[100px]">
              <TerminalContent operation={shellOperation} />
            </div>
          )}
        </div>
      );
    }

    if (mode === CODE_PANEL_MODE.TOOL) {
      if (!toolOperation) {
        return isLoading ? (
          <Placeholder
            variant="loading"
            placement="detail-panel"
            fillParentHeight
          />
        ) : (
          <NoTabsPlaceholder
            icon="editor"
            caption={simulatorAwaitingAgentCaption}
            actions={simulatorPlaceholderActions}
          />
        );
      }

      return (
        <ToolPanel
          operation={toolOperation}
          publishEnabled={publishHeaderToSimulator}
        />
      );
    }

    if (mode === CODE_PANEL_MODE.EXPLORE) {
      if (!exploreOperation) {
        return isLoading ? (
          <Placeholder
            variant="loading"
            placement="detail-panel"
            fillParentHeight
          />
        ) : (
          <NoTabsPlaceholder
            icon="editor"
            caption={simulatorAwaitingAgentCaption}
            actions={simulatorPlaceholderActions}
          />
        );
      }

      return (
        <div className="flex h-full w-full flex-col overflow-hidden">
          <ExploreHeader
            operation={exploreOperation}
            publishEnabled={publishHeaderToSimulator}
          />
          {exploreOperation.isFailed ? (
            <Placeholder
              variant="error"
              placement="detail-panel"
              fillParentHeight
              title={t("tools.failedPlaceholder")}
            />
          ) : (
            <div className="code-viewer-scroll-container relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-[100px]">
              <SearchResultsContent operation={exploreOperation} />
            </div>
          )}
        </div>
      );
    }

    if (!operation) {
      return isLoading ? (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          fillParentHeight
        />
      ) : (
        <NoTabsPlaceholder
          icon="editor"
          caption={simulatorAwaitingAgentCaption}
          actions={simulatorPlaceholderActions}
        />
      );
    }

    const { filePath, type, language, relatedOperations } = operation;
    const selectionDisplayName = getFileName(filePath) || filePath;
    const operationIsLoading = operation.isLoading || isLoading;
    const showDiffLineNumbers = shouldTrustDiffStartLines(operation.event);

    if (operation.isFailed) {
      return (
        <div className="flex h-full w-full flex-col overflow-hidden">
          <FileHeader
            filePath={filePath}
            disableNavigation
            publishToHost="simulator"
            publishEnabled={publishHeaderToSimulator}
          />
          <Placeholder
            variant="error"
            placement="detail-panel"
            fillParentHeight
            title={t("tools.failedPlaceholder")}
          />
        </div>
      );
    }

    const content =
      resolvedPayload?.content ??
      (type === FILE_OPERATION_TYPE.READ ? liveReadContent.content : undefined);
    const oldContent = resolvedPayload?.oldContent;
    const newContent = resolvedPayload?.newContent;
    const resolvedLanguage = resolvedPayload?.language ?? language;

    const hasMultipleEdits =
      relatedOperations &&
      relatedOperations.length > 1 &&
      type === FILE_OPERATION_TYPE.WRITE;

    const showPreviewToggle =
      type === FILE_OPERATION_TYPE.READ &&
      !!content &&
      supportsPreviewToggle(filePath);

    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        <FileHeader
          filePath={filePath}
          isMarkdownFile={showPreviewToggle}
          isPreviewMode={isPreviewMode}
          onTogglePreview={handleTogglePreview}
          disableNavigation
          publishToHost="simulator"
          publishEnabled={publishHeaderToSimulator}
        />

        <div
          className={`code-viewer-scroll-container relative min-h-0 flex-1 ${hasMultipleEdits ? "overflow-auto" : "overflow-hidden"}`}
        >
          {type === FILE_OPERATION_TYPE.DELETE ? (
            <Placeholder
              variant="empty"
              placement="detail-panel"
              title={t("tools.deleted")}
              fillParentHeight
            />
          ) : type === FILE_OPERATION_TYPE.READ ? (
            getPreviewType(filePath) === "image" ? (
              <ImagePreview filePath={filePath} />
            ) : content !== undefined ? (
              isPreviewMode && showPreviewToggle ? (
                <PreviewContent filePath={filePath} content={content} />
              ) : (
                <SessionReplayCodeMirrorViewer
                  content={
                    content.length > 50000
                      ? content.slice(0, 50000) +
                        t("simulator.replay.ide.codePanel.truncatedSuffix")
                      : content
                  }
                  language={resolvedLanguage}
                  filePath={filePath}
                  startLine={resolvedPayload?.contentStartLine}
                />
              )
            ) : operationIsLoading && liveReadContent.status !== "failed" ? (
              <SessionReplayCodeMirrorViewer
                content=""
                language={resolvedLanguage}
                filePath={filePath}
                startLine={resolvedPayload?.contentStartLine}
              />
            ) : (
              <NoTabsPlaceholder
                icon="editor"
                caption={simulatorAwaitingAgentCaption}
                actions={simulatorPlaceholderActions}
              />
            )
          ) : hasMultipleEdits ? (
            <SelectedTextAddToChat
              displayName={selectionDisplayName}
              scopeKey={operation.eventId}
              className="min-w-0"
            >
              <CombinedDiffView
                operations={relatedOperations}
                filePath={filePath}
              />
            </SelectedTextAddToChat>
          ) : oldContent !== undefined || newContent !== undefined ? (
            <SelectedTextAddToChat
              displayName={selectionDisplayName}
              scopeKey={operation.eventId}
              className="h-full min-h-0 min-w-0"
            >
              <VirtualizedModernDiff
                oldValue={oldContent || ""}
                newValue={newContent || ""}
                filePath={filePath}
                height="100%"
                oldStartLine={resolvedPayload?.oldStartLine}
                newStartLine={resolvedPayload?.newStartLine}
                showLineNumbers={showDiffLineNumbers}
                contextLines={3}
                collapseUnchanged={true}
                showFilePath={false}
                showStatsBar={false}
                noWrapper={true}
                internalScroll={true}
              />
            </SelectedTextAddToChat>
          ) : (
            <div className="p-4 text-[13px] text-success-6">
              {t("simulator.replay.ide.codePanel.fileEditedSuccess")}
            </div>
          )}
        </div>
      </div>
    );
  }
);

CodePanel.displayName = "CodePanel";

export default CodePanel;
