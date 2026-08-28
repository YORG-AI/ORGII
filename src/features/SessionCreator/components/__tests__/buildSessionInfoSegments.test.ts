import type { TFunction } from "i18next";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { RUNNING_LOCATIONS } from "@src/config/sessionCreatorConfig";
import {
  CodeIcon,
  FolderClosedIcon,
  FolderLibraryIcon,
  SplitIcon,
} from "@src/icons";
import { REPO_KIND } from "@src/store/repo";

import {
  buildSessionInfoSegments,
  getSessionInfoDisplayState,
} from "../SessionInfoLine/buildSessionInfoSegments";
import { LOCATION_ICONS } from "../SessionInfoLine/locationConfig";

const t = ((key: string) => key) as TFunction;

describe("buildSessionInfoSegments", () => {
  it("uses folder icons that distinguish Git repos, folders, and workspaces", () => {
    const baseParams = {
      repoName: "ORGII",
      hideBranch: false,
      t,
    };

    expect(
      getSessionInfoDisplayState({ ...baseParams, isMultiRoot: false })
        .SourceIcon
    ).toBe(CodeIcon);
    expect(
      getSessionInfoDisplayState({
        ...baseParams,
        isMultiRoot: false,
        repoKind: REPO_KIND.FOLDER,
      }).SourceIcon
    ).toBe(FolderClosedIcon);
    expect(
      getSessionInfoDisplayState({
        ...baseParams,
        isMultiRoot: true,
        repoKind: REPO_KIND.FOLDER,
      }).SourceIcon
    ).toBe(FolderLibraryIcon);
  });

  it("uses a clockwise split icon for New Worktree", () => {
    const icon = LOCATION_ICONS.worktree as React.ReactElement<{
      icon?: unknown;
      className?: string;
    }>;

    // Icons render through HugeiconsIcon now, so the glyph is a prop
    // rather than the element type.
    expect(icon.props.icon).toBe(SplitIcon);
    expect(icon.props.className).toContain("rotate-90");

    const dropdownEntry = RUNNING_LOCATIONS.find(
      (entry) => entry.id === "worktree"
    );
    expect(dropdownEntry?.icon).toBe(SplitIcon);
    expect(dropdownEntry?.iconClassName).toBe("rotate-90");
  });

  it("orders setup as repository, running location, then branch", () => {
    const segments = buildSessionInfoSegments({
      SourceIcon: CodeIcon,
      hasSource: true,
      sourceDisplayName: "ORGII",
      showBranchRow: true,
      isRepoSelectorOpen: false,
      isBranchSelectorOpen: false,
      branchName: "develop",
      worktreeLocation: "local",
      isLocationDropdownOpen: false,
      locationTriggerRef: React.createRef<HTMLButtonElement>(),
      disabled: false,
      t,
      handleRepoTriggerClick: vi.fn(),
      handleBranchTriggerClick: vi.fn(),
      handleLocationTriggerClick: vi.fn(),
    });

    expect(segments.map((segment) => segment.id)).toEqual([
      "repo",
      "location",
      "branch",
    ]);
    expect(segments.map((segment) => segment.tooltipMouseEnterDelay)).toEqual([
      2000, 2000, 2000,
    ]);
  });

  it("shows the worktree source on the branch segment", () => {
    const segments = buildSessionInfoSegments({
      SourceIcon: CodeIcon,
      hasSource: true,
      sourceDisplayName: "ORGII",
      showBranchRow: true,
      isRepoSelectorOpen: false,
      isBranchSelectorOpen: false,
      branchName: "develop",
      worktreeLocation: "worktree",
      worktreeLocationLabel: "New Worktree",
      worktreeSourceLabel: "#42 Fix launch flow",
      isLocationDropdownOpen: false,
      locationTriggerRef: React.createRef<HTMLButtonElement>(),
      disabled: false,
      t,
      handleRepoTriggerClick: vi.fn(),
      handleBranchTriggerClick: vi.fn(),
      handleLocationTriggerClick: vi.fn(),
    });

    expect(segments.map((segment) => segment.label)).toEqual([
      "ORGII",
      "New Worktree",
      "#42 Fix launch flow",
    ]);
  });
});
