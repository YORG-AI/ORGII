import type { TFunction } from "i18next";
import { Code } from "lucide-react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { buildSessionInfoSegments } from "../SessionInfoLine/buildSessionInfoSegments";

const t = ((key: string) => key) as TFunction;

describe("buildSessionInfoSegments", () => {
  it("keeps worktree switching out of the session info row", () => {
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
      "branch",
      "location",
    ]);
  });
});
