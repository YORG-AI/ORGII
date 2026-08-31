import type React from "react";

import type { AddWorkspaceModalStage } from "../../hooks";
import type { BasePaletteProps } from "../../shared";
import type { RepoItem } from "../../types";

export type AddMenuKind = "add" | null;

export const WORKSPACE_PALETTE_SECTION_KEY = {
  CURRENT: "current",
  RECENT: "recent",
  SYSTEM_PATH: "systemPath",
  EXTERNAL_RECENT: "externalRecent",
  REPO: "repo",
  FOLDER_WORKSPACE: "folderWorkspace",
  MULTI_REPO_WORKSPACE: "multiRepoWorkspace",
  THIS_ORG: "thisOrg",
  OUTSIDE_ORG: "outsideOrg",
} as const;

export type WorkspacePaletteSectionKey =
  (typeof WORKSPACE_PALETTE_SECTION_KEY)[keyof typeof WORKSPACE_PALETTE_SECTION_KEY];

export interface WorkspacePaletteProps extends BasePaletteProps {
  onSelect: (repoId: string, repo: RepoItem) => void;
  currentRepoId?: string;
  initialAddStage?: AddWorkspaceModalStage;
  initialAddMenu?: boolean;
  initialManageMode?: boolean;
  topSlot?: React.ReactNode;
  asBody?: boolean;
  switchPathLabel?: string;
  hideActionClose?: boolean;
  leadingRepos?: readonly RepoItem[];
  /**
   * Org-scope membership predicate (e.g. active cloud org repo scope).
   * Rows are never hidden by it: matching rows group under "This org",
   * the rest under "Outside this org".
   */
  repoFilter?: (repo: {
    repo_url?: string | null;
    fs_uri?: string | null;
  }) => boolean;
}

export interface WorkspacePaletteText {
  switchPathLabel: string;
  switchPathTemplate: string;
  switchPlaceholder: string;
  invalidPathTitle: string;
  invalidPathMessage: (path: string) => string;
  addPathLabel: string;
  addPathTemplate: string;
  addPlaceholder: string;
  addEntryLabel: string;
  openFolderLabel: string;
  addFolderLabel: string;
  sectionCurrentLabel: string;
  sectionRecentLabel: string;
  sectionSystemPathsLabel: string;
  sectionExternalRecentLabel: string;
  sectionRepoLabel: string;
  sectionFolderWorkspaceLabel: string;
  sectionMultiRepoWorkspaceLabel: string;
  sectionThisOrgLabel: string;
  sectionOutsideOrgLabel: string;
}
