/**
 * FilesTab Configuration
 *
 * Defines the Files tab structure with sections: Files Tree, Outline, Git
 * Timeline, and Agent Timeline.
 *
 * ARCHITECTURE (Jan 2026):
 * Uses useSelectedFile hook for single source of truth - selectedFilePath
 * comes from active editor tab, not from props.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { SectionHeaderAction } from "@src/components/TreePanelSidebar/types";
import { useSelectedFile } from "@src/hooks/tabHost/useSelectedFile";
import { HugeiconsIcon } from "@src/icons";
import type { PrimarySidebarTab } from "@src/modules/WorkStation/shared";

import { ICON_CONFIG, PANEL_CONSTANTS } from "../config";
import OutlineContent from "../content/OutlineContent";
import TimelineContent from "../content/TimelineContent";

export interface FilesTabConfigProps {
  repoName?: string;
  fileTreeContent: React.ReactNode;
  onSymbolClick?: (line: number) => void;
  loading: boolean;
  selectedCommitSha?: string | null;
  repoId?: string;
  repoPath: string;
  onTimelineCommitClick?: (
    commitSha: string,
    filePath: string,
    commitInfo: {
      sha: string;
      shortSha: string;
      message: string;
      author: string;
      timestamp: string;
    }
  ) => void;
  filesActions: SectionHeaderAction[];
}

export function useFilesTabConfig({
  repoName,
  fileTreeContent,
  onSymbolClick,
  loading,
  selectedCommitSha,
  repoId,
  repoPath,
  onTimelineCommitClick,
  filesActions,
}: FilesTabConfigProps): PrimarySidebarTab {
  const { t } = useTranslation();

  // SINGLE SOURCE OF TRUTH: Get selected file from active tab
  const { selectedFilePath } = useSelectedFile();

  // Destructure icon components
  const FilesIcon = ICON_CONFIG.files;

  return useMemo(
    () => ({
      key: "files",
      label: t("tabs.explorer"),
      icon: (
        <HugeiconsIcon icon={FilesIcon} size={PANEL_CONSTANTS.TAB_ICON_SIZE} />
      ),
      sections: [
        {
          key: "files",
          title: repoName || "Files",
          content: fileTreeContent,
          defaultFlexGrow: 2,
          resizable: true,
          actions: filesActions,
        },
        {
          key: "outline",
          title: t("labels.outline"),
          content: (
            <OutlineContent
              filePath={selectedFilePath}
              onSymbolClick={onSymbolClick}
            />
          ),
          defaultFlexGrow: 1,
          resizable: true,
          defaultCollapsed: true,
        },
        {
          key: "git-timeline",
          title: `Git ${t("labels.timeline")}`,
          content: (
            <TimelineContent
              variant="git"
              repoId={repoId || repoPath}
              repoPath={repoPath}
              filePath={selectedFilePath}
              selectedCommitSha={selectedCommitSha ?? null}
              onCommitClick={onTimelineCommitClick}
              loading={loading}
            />
          ),
          defaultFlexGrow: 1,
          resizable: true,
          defaultCollapsed: true,
          headerTestId: "code-editor-git-timeline-section-toggle",
        },
        {
          key: "session-timeline",
          title: `Agent ${t("labels.timeline")}`,
          content: (
            <TimelineContent
              variant="session"
              repoId={repoId || repoPath}
              repoPath={repoPath}
              filePath={selectedFilePath}
              selectedCommitSha={selectedCommitSha ?? null}
              onCommitClick={onTimelineCommitClick}
              loading={loading}
            />
          ),
          defaultFlexGrow: 1,
          resizable: true,
          defaultCollapsed: true,
          headerTestId: "code-editor-agent-timeline-section-toggle",
        },
      ],
    }),
    [
      repoName,
      fileTreeContent,
      filesActions,
      selectedFilePath,
      onSymbolClick,
      loading,
      selectedCommitSha,
      repoId,
      repoPath,
      onTimelineCommitClick,
      FilesIcon,
      t,
    ]
  );
}
