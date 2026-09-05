/**
 * WorkstationTabIcon
 *
 * Canonical icon presentation for a Workstation tab. It is shared by the tab
 * strip and the recently closed tabs menu so a tab retains its identity in
 * both places.
 */
import React, { memo } from "react";

import {
  type ProjectSyncAdapterType,
  STORY_SYNC_ADAPTER,
} from "@src/api/http/integrations/syncConnections";
import AnyIcon from "@src/components/AnyIcon";
import { FaviconIcon } from "@src/components/FaviconIcon";
import FileTypeIcon from "@src/components/FileTypeIcon";
import IntegrationIcon from "@src/components/IntegrationIcon";
import { SessionIdentityIconById } from "@src/engines/ChatPanel/components/SessionIdentityIcon";
import {
  Infinity01Icon as Infinity,
  DeliveryBox01Icon as Box,
  Building02Icon as Building2,
  ChartNoAxesGanttIcon as ChartNoAxesGantt,
  CircleDotIcon,
  CodeXmlIcon as Code,
  CodeXmlIcon as Code2,
  FileDiffIcon,
  FolderClosedIcon,
  WorkflowCircle05Icon as GitBranch,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  InternetIcon as Globe,
  HugeiconsIcon,
  type IconSvgElement,
  KanbanIcon,
  Layout01Icon as Layout,
  DashboardSquare01Icon as LayoutGrid,
  LayoutListIcon,
  ListChecksIcon,
  BubbleChatIcon as MessageCircle,
  Message01Icon as MessageSquare,
  PackageIcon,
  ColorPickerIcon as Palette,
  Add01Icon as Plus,
  Radar01Icon as Radar,
  SearchAreaIcon as ScanSearch,
  Search01Icon,
  Settings01Icon,
  SparklesIcon,
  SquareTerminalIcon,
  ComputerTerminal01Icon as Terminal,
} from "@src/icons";
import { isGitHubIssueStatus } from "@src/modules/ProjectManager/WorkItems/workItemIdentity";
import type { WorkStationTab } from "@src/store/workstation/tabs/types";

export const WORKSTATION_TAB_ICONS = {
  Box,
  Building2,
  ChartNoAxesGantt,
  CircleDot: CircleDotIcon,
  Code,
  Code2,
  FileDiff: FileDiffIcon,
  GitBranch,
  GitCommitHorizontal: GitCommitHorizontalIcon,
  GitMerge: GitMergeIcon,
  GitPullRequest: GitPullRequestIcon,
  Globe,
  Infinity,
  Layout,
  LayoutGrid,
  LayoutList: LayoutListIcon,
  ListChecks: ListChecksIcon,
  MessageCircle,
  MessageSquare,
  Package: PackageIcon,
  Palette,
  Plus,
  Radar,
  ScanSearch,
  Search: Search01Icon,
  Settings: Settings01Icon,
  Sparkles: SparklesIcon,
  SquareTerminal: SquareTerminalIcon,
  Terminal,
  Kanban: KanbanIcon,
  // Keep the persisted legacy key resolving to the canonical Kanban glyph.
  Trello: KanbanIcon,
} as const satisfies Record<string, IconSvgElement>;

type WorkstationTabIconName = keyof typeof WORKSTATION_TAB_ICONS;

function resolveWorkstationTabIcon(name: string): IconSvgElement | null {
  return WORKSTATION_TAB_ICONS[name as WorkstationTabIconName] ?? null;
}

export function resolveWorkstationTabIntegrationIcon(
  tab: WorkStationTab
): ProjectSyncAdapterType | null {
  if (tab.type === "project-linear-work-items") {
    return STORY_SYNC_ADAPTER.LINEAR;
  }
  if (
    tab.type === "github-issue-detail" ||
    (tab.type === "workItem-detail" &&
      isGitHubIssueStatus(tab.data.workItemStatus as string | undefined))
  ) {
    return STORY_SYNC_ADAPTER.GITHUB;
  }
  return null;
}

interface WorkstationTabIconProps {
  tab: WorkStationTab;
  isActive: boolean;
}

/** Renders the same glyph the Workstation tab strip uses for this tab. */
export const WorkstationTabIcon: React.FC<WorkstationTabIconProps> = memo(
  ({ tab, isActive }) => {
    const integrationIcon = resolveWorkstationTabIntegrationIcon(tab);
    if (integrationIcon) {
      return (
        <IntegrationIcon
          type={integrationIcon}
          size={16}
          className={
            integrationIcon === STORY_SYNC_ADAPTER.GITHUB
              ? isActive
                ? "text-text-1"
                : "text-text-2"
              : undefined
          }
        />
      );
    }

    if (tab.type === "chat-session") {
      return (
        <SessionIdentityIconById
          sessionId={String(tab.data.sessionId ?? "")}
          isSelected={isActive}
        />
      );
    }

    // Custom glyph override — tint active tab only (FileTypeIcon / favicons
    // keep their own colors).
    if (tab.icon) {
      const icon = resolveWorkstationTabIcon(tab.icon);
      if (icon) {
        return (
          <AnyIcon
            icon={icon}
            data-icon={tab.icon
              .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
              .toLowerCase()}
            size={16}
            strokeWidth={1.75}
            className={isActive ? "text-text-1" : "text-text-2"}
          />
        );
      }
    }

    switch (tab.type) {
      case "file":
      case "git-diff":
        return (
          <FileTypeIcon
            fileName={(tab.data.filePath as string) || tab.title}
            size="small"
          />
        );
      case "directory":
        return <FileTypeIcon fileName="folder" type="folder" size="small" />;
      case "explorer":
        return (
          <HugeiconsIcon
            icon={FolderClosedIcon}
            data-icon="folder"
            size={16}
            strokeWidth={1.75}
            className={isActive ? "text-text-1" : "text-text-2"}
          />
        );
      case "terminal":
        return <FileTypeIcon fileName="terminal.sh" size="small" />;
      case "browser-session":
        return (
          <FaviconIcon
            url={tab.data.url as string | undefined}
            isIncognito={tab.data.incognito as boolean | undefined}
            isLoading={tab.data.isLoading as boolean | undefined}
            fallbackColor={isActive ? "text-text-1" : undefined}
          />
        );
      default:
        return <FileTypeIcon fileName="file.txt" size="small" />;
    }
  }
);

WorkstationTabIcon.displayName = "WorkstationTabIcon";
