import { describe, expect, it } from "vitest";

import type { BranchItem } from "../../../types";
import { buildBranchSpotlightItem } from "../branchAdapter";

describe("buildBranchSpotlightItem", () => {
  it("exposes the branch name as its context-menu copy target", () => {
    const branch: BranchItem = {
      name: "feature/context-menu",
      isCurrent: false,
      isRemote: false,
    };

    const item = buildBranchSpotlightItem(branch, { onAction: () => {} });

    expect(item.data?.contextMenuCopy).toEqual({
      name: "feature/context-menu",
    });
  });
});
