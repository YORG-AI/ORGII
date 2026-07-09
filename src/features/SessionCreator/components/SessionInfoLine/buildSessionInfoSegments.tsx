import type { TFunction } from "i18next";
import { Code, Folder, FolderTree, GitBranch, Home } from "lucide-react";
import React from "react";

import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import type { PillGroupSegment } from "@src/components/PillGroup";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import {
  RUNNING_LOCATIONS,
  type RunningLocation,
} from "@src/config/sessionCreatorConfig";
import { REPO_KIND, type RepoKind } from "@src/store/repo/types";

import { LOCATION_ICONS } from "./locationConfig";

/** Max pill label width for repo/branch segments in the session info row. */
const SESSION_INFO_LABEL_MAX_WIDTH = 180;

interface SessionInfoDisplayParams {
  isMultiRoot: boolean;
  workspaceName?: string;
  repoName?: string;
  repoKind?: RepoKind;
  isSystemPathSource?: boolean;
  isSystemHomeSource?: boolean;
  hideBranch: boolean;
  t: TFunction;
}

export interface SessionInfoDisplayState {
  sourceDisplayName: string;
  SourceIcon: typeof FolderTree | typeof Code | typeof Home | typeof Folder;
  hasSource: boolean;
  showBranchRow: boolean;
}

export function getSessionInfoDisplayState({
  isMultiRoot,
  workspaceName,
  repoName,
  repoKind,
  isSystemPathSource = false,
  isSystemHomeSource = false,
  hideBranch,
  t,
}: SessionInfoDisplayParams): SessionInfoDisplayState {
  return {
    sourceDisplayName:
      (isMultiRoot ? workspaceName : repoName) ||
      t("selectors.sessionInfo.sourcePlaceholder"),
    SourceIcon: isSystemHomeSource
      ? Home
      : isSystemPathSource
        ? Folder
        : isMultiRoot
          ? FolderTree
          : Code,
    hasSource: !!repoName || isMultiRoot,
    showBranchRow:
      !hideBranch &&
      !isSystemPathSource &&
      !!repoName &&
      repoKind !== REPO_KIND.FOLDER &&
      !isMultiRoot,
  };
}

interface BuildSessionInfoSegmentsParams extends SessionInfoDisplayState {
  isRepoSelectorOpen: boolean;
  isBranchSelectorOpen: boolean;
  branchLoading?: boolean;
  branchName?: string;
  worktreeLocation?: RunningLocation;
  isLocationDropdownOpen: boolean;
  locationTriggerRef: React.Ref<HTMLButtonElement>;
  disabled: boolean;
  t: TFunction;
  handleRepoTriggerClick: () => void;
  handleBranchTriggerClick: () => void;
  handleLocationTriggerClick: () => void;
}

export function buildSessionInfoSegments({
  SourceIcon,
  hasSource,
  sourceDisplayName,
  isRepoSelectorOpen,
  handleRepoTriggerClick,
  showBranchRow,
  branchLoading,
  branchName,
  isBranchSelectorOpen,
  handleBranchTriggerClick,
  worktreeLocation,
  isLocationDropdownOpen,
  handleLocationTriggerClick,
  locationTriggerRef,
  disabled,
  t,
}: BuildSessionInfoSegmentsParams): PillGroupSegment[] {
  const segments: PillGroupSegment[] = [
    {
      id: "repo",
      icon: (
        <SourceIcon
          size={14}
          strokeWidth={1.75}
          className={hasSource ? "text-text-1" : "text-primary-6"}
        />
      ),
      label: sourceDisplayName,
      maxLabelWidth: SESSION_INFO_LABEL_MAX_WIDTH,
      active: isRepoSelectorOpen,
      danger: !hasSource,
      tooltip: disabled ? undefined : (
        <KeyboardShortcutTooltipContent
          label={t("selectors.sessionInfo.switchWorkspace")}
          shortcut={getShortcutKeys("open_workspace_selector")}
        />
      ),
      tooltipFramed: true,
      tooltipPosition: "bottom",
      ariaLabel: t("selectors.sessionInfo.sourceAria"),
      disabled,
      onClick: handleRepoTriggerClick,
    },
  ];

  if (showBranchRow) {
    segments.push({
      id: "branch",
      icon: <GitBranch size={14} strokeWidth={1.75} className="text-text-1" />,
      label: branchLoading ? t("status.loading") : branchName || "",
      maxLabelWidth: SESSION_INFO_LABEL_MAX_WIDTH,
      active: isBranchSelectorOpen,
      tooltip: disabled ? undefined : (
        <KeyboardShortcutTooltipContent
          label={t("selectors.sessionInfo.switchBranch")}
          shortcut={getShortcutKeys("open_branch_selector")}
        />
      ),
      tooltipFramed: true,
      tooltipPosition: "bottom",
      ariaLabel: t("selectors.sessionInfo.branchAria"),
      disabled: disabled || branchLoading,
      onClick: handleBranchTriggerClick,
    });
  }

  if (worktreeLocation !== undefined) {
    const locationEntry = RUNNING_LOCATIONS.find(
      (location) => location.id === worktreeLocation
    )!;
    segments.push({
      id: "location",
      icon: LOCATION_ICONS[worktreeLocation],
      label: t(`sessions:${locationEntry.i18nKey}`),
      active: isLocationDropdownOpen,
      tooltip: disabled ? undefined : (
        <KeyboardShortcutTooltipContent
          label={t("selectors.sessionInfo.switchLocation")}
          shortcut={getShortcutKeys("open_location_selector")}
        />
      ),
      tooltipFramed: true,
      tooltipPosition: "bottom",
      ariaLabel: t("selectors.sessionInfo.locationAria"),
      disabled,
      buttonRef: locationTriggerRef,
      onClick: handleLocationTriggerClick,
    });
  }

  return segments;
}
