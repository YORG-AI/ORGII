import type { TFunction } from "i18next";
import { Code, Split } from "lucide-react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { RUNNING_LOCATIONS } from "@src/config/sessionCreatorConfig";

import { buildSessionInfoSegments } from "../SessionInfoLine/buildSessionInfoSegments";
import { LOCATION_ICONS } from "../SessionInfoLine/locationConfig";

const t = ((key: string) => key) as TFunction;

describe("buildSessionInfoSegments", () => {
  it("uses a clockwise split icon for New Worktree", () => {
    const icon = LOCATION_ICONS.worktree as React.ReactElement<{
      className?: string;
    }>;

    expect(icon.type).toBe(Split);
    expect(icon.props.className).toContain("rotate-90");

    const dropdownEntry = RUNNING_LOCATIONS.find(
      (entry) => entry.id === "worktree"
    );
    expect(dropdownEntry?.icon).toBe(Split);
    expect(dropdownEntry?.iconClassName).toBe("rotate-90");
  });

  it("orders setup as repository, running location, then branch", () => {
    const segments = buildSessionInfoSegments({
      SourceIcon: Code,
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
      SourceIcon: Code,
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
