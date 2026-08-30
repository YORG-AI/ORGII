import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { useRepoGitInitialization } from "@src/hooks/git";
import {
  CircleDotIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  HugeiconsIcon,
} from "@src/icons";
import { CODE_EDITOR_TOUR_TARGETS } from "@src/scaffold/Tutorials/codeEditorTourConfig";
import { workStationPrimarySidebarCollapsedPersistAtom } from "@src/store/ui/workStationAtom";
import { activeStatusBarAppAtom } from "@src/store/ui/workStationLayout/statusBarAtoms";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import {
  sourceControlFilterModeAtom,
  sourceControlFilterModeHandlerAtom,
} from "@src/store/workstation/codeEditor/sourceControlFilterModeAtom";
import { activeWorkStationTabAtom } from "@src/store/workstation/tabs";

const SourceControlHeaderActionsComponent: React.FC = () => {
  const { t } = useTranslation("common");
  const activeApp = useAtomValue(activeStatusBarAppAtom);
  const activeTab = useAtomValue(activeWorkStationTabAtom);
  const repoPath = useAtomValue(activeWorkspaceRootPathAtom);
  const { isGitInitialized } = useRepoGitInitialization(repoPath);
  const filterMode = useAtomValue(sourceControlFilterModeAtom);
  const filterModeHandler = useAtomValue(sourceControlFilterModeHandlerAtom);
  const setSidebarCollapsed = useSetAtom(
    workStationPrimarySidebarCollapsedPersistAtom
  );

  const handleToggleHistory = useCallback(() => {
    const nextMode = filterMode === "history" ? "uncommitted" : "history";
    filterModeHandler?.(nextMode);
    setSidebarCollapsed(false);
  }, [filterMode, filterModeHandler, setSidebarCollapsed]);

  const handleTogglePr = useCallback(() => {
    const nextMode = filterMode === "pr" ? "uncommitted" : "pr";
    filterModeHandler?.(nextMode);
    setSidebarCollapsed(false);
  }, [filterMode, filterModeHandler, setSidebarCollapsed]);

  const handleToggleIssues = useCallback(() => {
    const nextMode = filterMode === "issues" ? "uncommitted" : "issues";
    filterModeHandler?.(nextMode);
    setSidebarCollapsed(false);
  }, [filterMode, filterModeHandler, setSidebarCollapsed]);

  if (
    activeApp !== "code" ||
    activeTab?.type !== "source-control" ||
    isGitInitialized !== true
  ) {
    return null;
  }

  const historyActive = filterMode === "history";
  const prActive = filterMode === "pr";
  const issuesActive = filterMode === "issues";
  const historyLabel = t("labels.gitHistory");
  const prLabel = t("labels.pullRequest", "Pull request");
  const issuesLabel = t("labels.issues", "Issues");

  return (
    <>
      <div
        className="flex shrink-0 items-center gap-px"
        data-tour-target={CODE_EDITOR_TOUR_TARGETS.gitHistory}
      >
        <ToolbarTooltip label={historyLabel}>
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            className={historyActive ? "!bg-fill-2 !text-primary-6" : ""}
            onClick={handleToggleHistory}
            aria-label={historyLabel}
            icon={
              <HugeiconsIcon
                icon={GitCommitIcon}
                data-icon="git-commit"
                size={HEADER_ICON_SIZE.sm}
                strokeWidth={2}
              />
            }
          />
        </ToolbarTooltip>
        <ToolbarTooltip label={prLabel}>
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            className={prActive ? "!bg-fill-2 !text-primary-6" : ""}
            onClick={handleTogglePr}
            aria-label={prLabel}
            icon={
              <HugeiconsIcon
                icon={GitPullRequestIcon}
                data-icon="git-pull-request"
                size={HEADER_ICON_SIZE.sm}
                strokeWidth={2}
              />
            }
          />
        </ToolbarTooltip>
        <ToolbarTooltip label={issuesLabel}>
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            className={issuesActive ? "!bg-fill-2 !text-primary-6" : ""}
            onClick={handleToggleIssues}
            aria-label={issuesLabel}
            icon={
              <HugeiconsIcon
                icon={CircleDotIcon}
                data-icon="circle-dot"
                size={HEADER_ICON_SIZE.sm}
                strokeWidth={2}
              />
            }
          />
        </ToolbarTooltip>
      </div>
      <HeaderSectionSeparator className="mx-1" />
    </>
  );
};

export const SourceControlHeaderActions = memo(
  SourceControlHeaderActionsComponent
);
SourceControlHeaderActions.displayName = "SourceControlHeaderActions";
