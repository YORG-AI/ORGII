import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorkManagementDatasetSwitch } from "./WorkManagementDatasetSwitch";
import { WORK_MANAGEMENT_DATASET } from "./workManagementDataset";

describe("WorkManagementDatasetSwitch", () => {
  it.each([
    [WORK_MANAGEMENT_DATASET.PROJECTS, "lucide-boxes"],
    [WORK_MANAGEMENT_DATASET.WORK_ITEMS, "lucide-list-todo"],
    [WORK_MANAGEMENT_DATASET.GITHUB_ISSUES, "lucide-circle-dot"],
    [WORK_MANAGEMENT_DATASET.REVIEWS, "lucide-git-pull-request"],
  ])("renders one simple select for %s", (activeDataset, activeIcon) => {
    const markup = renderToStaticMarkup(
      createElement(WorkManagementDatasetSwitch, {
        activeDataset,
        onChange: vi.fn(),
      })
    );

    expect(markup).toContain('data-testid="work-dataset-select"');
    expect(markup).toContain("select-ghost");
    expect(markup).toContain(activeIcon);
    expect(markup).toContain("lucide-chevron-down");
    expect(markup).not.toContain("rounded-[100px]");
  });
});
