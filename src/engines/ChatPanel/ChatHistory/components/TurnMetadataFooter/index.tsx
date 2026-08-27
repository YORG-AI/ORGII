import { useSetAtom } from "jotai";
import {
  Chromium,
  GitCommitHorizontal,
  GitPullRequest,
  MoreHorizontal,
} from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { openMarkdownLinkInBrowserApp } from "@src/components/MarkDown/markdownUtils";
import TabPill, { type TabPillItem } from "@src/components/TabPill";
import {
  CHAT_COMPOSER_STACK_BAR_INNER_PADDING_X_CLASS,
  COMPOSER_STACK_ROW_BASE,
  COMPOSER_STACK_ROW_HOVER,
} from "@src/config/composerStackTokens";
import FileChangeRow from "@src/engines/ChatPanel/InputArea/components/FileChangeRow";
import EventFileHoverPreview from "@src/engines/ChatPanel/blocks/EventFileHoverPreview";
import { replayModeAtom } from "@src/engines/SessionCore";
import type { ExtractedGitArtifactData } from "@src/engines/SessionCore/core/types";
import type {
  TurnResourceInteraction,
  TurnSummary,
} from "@src/engines/SessionCore/storage/sqliteCache";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import {
  STATION_MODE,
  bumpSimulatorDiffRefreshNonceAtom,
  simulatorDiffCommitNavigationRequestAtom,
  simulatorDiffScopeRequestAtom,
  simulatorSelectedAppAtom,
  stationModeAtom,
} from "@src/store/ui/simulatorAtom";
import { getFileName } from "@src/util/file/pathUtils";

import { mapTurnModifiedFilesToFileChanges } from "./turnFilesMapping";

const DEFAULT_VISIBLE_FILES = 4;
/**
 * Lucide glyphs fill their viewBox while FileTypeIcon SVGs carry internal
 * padding, so 14px/1.75 stroke reads the same optical size as the 16px
 * file icons in sibling rows (same pairing the composer pills use).
 */
const ARTIFACT_ICON_PROPS = {
  size: 14,
  strokeWidth: 1.75,
  className: "shrink-0",
} as const;
const STACK_ROW_BUTTON_CLASSES = `${COMPOSER_STACK_ROW_BASE} ${COMPOSER_STACK_ROW_HOVER} w-full cursor-pointer border-0 bg-transparent text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/30 disabled:cursor-not-allowed disabled:opacity-50`;
const REVIEW_BUTTON_STYLE = {
  height: "auto",
  padding: 0,
  fontSize: "var(--chat-block-title-size, 13px)",
} as const;
let diffScopeNonce = 0;
type MetadataTab = "edits" | "reads";

export interface TurnMetadataFooterProps {
  summary: TurnSummary;
  sessionId: string;
  turnId: string;
  isPagedHistoryRound?: boolean;
}

function artifactLabel(artifact: ExtractedGitArtifactData): string {
  if (artifact.kind === "pullRequest") {
    return artifact.prTitle || `#${artifact.prNumber ?? "?"}`;
  }
  return artifact.subject || artifact.shortSha || artifact.sha || "Commit";
}

const TurnMetadataFooter: React.FC<TurnMetadataFooterProps> = memo(
  ({ summary, sessionId, turnId, isPagedHistoryRound = false }) => {
    const { t } = useTranslation("sessions");
    const [expanded, setExpanded] = useState(false);
    const [activeTab, setActiveTab] = useState<MetadataTab>(() =>
      summary.modifiedFiles.length > 0 || summary.gitArtifacts.length > 0
        ? "edits"
        : "reads"
    );
    const setStationMode = useSetAtom(stationModeAtom);
    const setSelectedSimulatorApp = useSetAtom(simulatorSelectedAppAtom);
    const setReplayMode = useSetAtom(replayModeAtom);
    const setChatPanelMaximized = useSetAtom(chatPanelMaximizedAtom);
    const setDiffScope = useSetAtom(simulatorDiffScopeRequestAtom);
    const setCommitNavigation = useSetAtom(
      simulatorDiffCommitNavigationRequestAtom
    );
    const refreshDiff = useSetAtom(bumpSimulatorDiffRefreshNonceAtom);

    const files = useMemo(
      () => mapTurnModifiedFilesToFileChanges(summary.modifiedFiles),
      [summary.modifiedFiles]
    );
    const commits = useMemo(
      () => summary.gitArtifacts.filter((item) => item.kind === "commit"),
      [summary.gitArtifacts]
    );
    const pullRequests = useMemo(
      () => summary.gitArtifacts.filter((item) => item.kind === "pullRequest"),
      [summary.gitArtifacts]
    );
    // Writes reach the card as `files` (the modifiedFiles projection), so only
    // reads are taken from the interaction stream. Searches are dropped at the
    // Rust capture boundary; this filter also hides them for sessions indexed
    // before that change.
    const observedResources = useMemo(
      () =>
        summary.resourceInteractions.filter((item) => item.action === "read"),
      [summary.resourceInteractions]
    );
    const readCount = useMemo(
      () => observedResources.reduce((total, item) => total + item.count, 0),
      [observedResources]
    );
    const editCount = files.length + commits.length + pullRequests.length;
    const hasEdits = editCount > 0;
    const hasReads = observedResources.length > 0;
    const tabs = useMemo<TabPillItem[]>(() => {
      const visibleTabs: TabPillItem[] = [];
      if (hasEdits) {
        visibleTabs.push({
          key: "edits",
          label: t("chat.turnMetadata.editsTab"),
          badge: (
            <span
              className="chat-block-xs text-text-3"
              data-testid="turn-metadata-edits-count"
            >
              {editCount}
            </span>
          ),
          dataTestId: "turn-metadata-edits-tab",
        });
      }
      if (hasReads) {
        visibleTabs.push({
          key: "reads",
          label: t("chat.turnMetadata.readsTab"),
          badge: (
            <span
              className="chat-block-xs text-text-3"
              data-testid="turn-metadata-reads-count"
            >
              {readCount}
            </span>
          ),
          dataTestId: "turn-metadata-reads-tab",
        });
      }
      return visibleTabs;
    }, [editCount, hasEdits, hasReads, readCount, t]);

    useEffect(() => {
      if (activeTab === "edits" && !hasEdits && hasReads) {
        setActiveTab("reads");
      } else if (activeTab === "reads" && !hasReads && hasEdits) {
        setActiveTab("edits");
      }
    }, [activeTab, hasEdits, hasReads]);

    const handleTabChange = useCallback((key: string) => {
      setActiveTab(key as MetadataTab);
      setExpanded(false);
    }, []);

    const openDiff = useCallback(
      (selectedPath?: string | null) => {
        setDiffScope({
          sessionId,
          turnId,
          filePaths: files.map((file) => file.path),
          selectedPath: selectedPath ?? null,
          nonce: ++diffScopeNonce,
        });
        refreshDiff();
        setChatPanelMaximized(false);
        setStationMode(STATION_MODE.AGENT_STATION);
        setSelectedSimulatorApp(AppType.DIFF);
        setReplayMode("replay");
      },
      [
        files,
        refreshDiff,
        sessionId,
        setChatPanelMaximized,
        setDiffScope,
        setReplayMode,
        setSelectedSimulatorApp,
        setStationMode,
        turnId,
      ]
    );

    const openCommit = useCallback(
      (artifact: ExtractedGitArtifactData) => {
        const commitSha = artifact.sha ?? artifact.shortSha;
        if (!commitSha) return;
        setChatPanelMaximized(false);
        setStationMode(STATION_MODE.AGENT_STATION);
        setSelectedSimulatorApp(AppType.DIFF);
        setReplayMode("replay");
        setCommitNavigation({
          sessionId,
          commitSha,
          nonce: Date.now(),
        });
      },
      [
        sessionId,
        setChatPanelMaximized,
        setCommitNavigation,
        setReplayMode,
        setSelectedSimulatorApp,
        setStationMode,
      ]
    );

    // PR rows open in the workstation Browser and bring it into view (the
    // chat panel un-maximizes and the station switches to Browser), matching
    // inline PR links in assistant markdown.
    const openPullRequest = useCallback(
      (artifact: ExtractedGitArtifactData) => {
        if (!artifact.url) return;
        openMarkdownLinkInBrowserApp(artifact.url);
      },
      []
    );

    const visibleFiles = expanded
      ? files
      : files.slice(0, DEFAULT_VISIBLE_FILES);
    const visibleResources = expanded
      ? observedResources
      : observedResources.slice(0, DEFAULT_VISIBLE_FILES);
    const hiddenCount =
      activeTab === "edits"
        ? files.length - visibleFiles.length
        : observedResources.length - visibleResources.length;
    if (!hasEdits && !hasReads) return null;

    return (
      <div className="px-3 pt-2" data-testid="turn-metadata-footer">
        <div className="overflow-hidden rounded-lg border border-solid border-border-2">
          <div className="flex min-h-9 items-center justify-between gap-2 px-2.5 py-1">
            <div className="flex min-w-0 items-center gap-2">
              {isPagedHistoryRound && (
                <span className="chat-block-xs shrink-0 text-text-3">
                  {t("chat.turnMetadata.earlierRound")}
                </span>
              )}
              <TabPill
                tabs={tabs}
                activeTab={activeTab}
                onChange={handleTabChange}
                variant="pill"
                appearance="ghost"
                fillWidth={false}
                size="chatPanel"
              />
            </div>
            {activeTab === "edits" && files.length > 0 && (
              <Button
                variant="tertiary"
                appearance="ghost"
                size="small"
                onClick={() => openDiff()}
                className="chat-block-title shrink-0 text-text-3 hover:text-text-1 focus-visible:ring-2 focus-visible:ring-primary-6/30"
                style={REVIEW_BUTTON_STYLE}
              >
                {t("chat.turnMetadata.review")}
              </Button>
            )}
          </div>

          <div
            className={`${CHAT_COMPOSER_STACK_BAR_INNER_PADDING_X_CLASS} flex max-h-[320px] min-h-0 flex-col pb-1`}
          >
            <div
              className="min-h-0 flex-1 overflow-y-auto scrollbar-hide"
              data-testid="turn-metadata-scroll-area"
            >
              {activeTab === "edits" &&
                commits.map((artifact) => (
                  <button
                    key={`commit-${artifact.sha ?? artifact.url}`}
                    type="button"
                    onClick={() => openCommit(artifact)}
                    disabled={!artifact.sha && !artifact.shortSha}
                    title={artifact.sha ?? artifact.url}
                    className={STACK_ROW_BUTTON_CLASSES}
                    data-testid="turn-metadata-commit"
                  >
                    <GitCommitHorizontal {...ARTIFACT_ICON_PROPS} />
                    <span className="chat-block-title min-w-0 flex-1 truncate text-text-2">
                      {artifactLabel(artifact)}
                    </span>
                    {artifact.shortSha && (
                      <span className="chat-block-xs shrink-0 font-mono text-text-3">
                        {artifact.shortSha}
                      </span>
                    )}
                  </button>
                ))}
              {activeTab === "edits" &&
                pullRequests.map((artifact) => (
                  <button
                    key={`pr-${artifact.url ?? artifact.prNumber}`}
                    type="button"
                    onClick={() => openPullRequest(artifact)}
                    disabled={!artifact.url}
                    title={artifact.url}
                    className={STACK_ROW_BUTTON_CLASSES}
                    data-testid="turn-metadata-pr"
                  >
                    <GitPullRequest {...ARTIFACT_ICON_PROPS} />
                    <span className="chat-block-title min-w-0 flex-1 truncate text-text-2">
                      {artifactLabel(artifact)}
                    </span>
                    <Chromium
                      size={14}
                      strokeWidth={1.75}
                      className="shrink-0 text-text-3"
                      aria-hidden
                    />
                  </button>
                ))}
              {activeTab === "edits" &&
                visibleFiles.map((file) => (
                  <EventFileHoverPreview key={file.path} path={file.path}>
                    <FileChangeRow
                      file={file}
                      fileIconSize="medium"
                      onFileClick={openDiff}
                    />
                  </EventFileHoverPreview>
                ))}
              {activeTab === "reads" &&
                visibleResources.map((interaction: TurnResourceInteraction) => {
                  const displayName =
                    interaction.fileName ||
                    getFileName(interaction.path) ||
                    interaction.path;
                  return (
                    <EventFileHoverPreview
                      key={`${interaction.outcome}-${interaction.path}`}
                      path={interaction.path}
                    >
                      <div
                        className={COMPOSER_STACK_ROW_BASE}
                        data-testid="turn-metadata-read"
                      >
                        <FileTypeIcon fileName={displayName} size="medium" />
                        <span className="chat-block-title min-w-0 flex-1 truncate text-text-2">
                          {displayName}
                        </span>
                        <span className="chat-block-xs shrink-0 text-text-3">
                          {interaction.outcome === "failed"
                            ? t("chat.turnMetadata.failed")
                            : interaction.count > 1
                              ? `×${interaction.count}`
                              : t("chat.turnMetadata.reads", { count: 1 })}
                        </span>
                      </div>
                    </EventFileHoverPreview>
                  );
                })}
            </div>
            {hiddenCount > 0 || expanded ? (
              <div
                className="shrink-0"
                data-testid="turn-metadata-pinned-controls"
              >
                <button
                  type="button"
                  onClick={() => setExpanded((previous) => !previous)}
                  className={`${STACK_ROW_BUTTON_CLASSES} text-text-3`}
                  data-testid="turn-metadata-expansion-toggle"
                  aria-expanded={expanded}
                >
                  <MoreHorizontal size={16} className="shrink-0" />
                  <span className="chat-block-title truncate">
                    {expanded
                      ? t("chat.turnMetadata.showLess")
                      : t("chat.turnMetadata.showMore", {
                          count: hiddenCount,
                        })}
                  </span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
);

TurnMetadataFooter.displayName = "TurnMetadataFooter";

export default TurnMetadataFooter;
