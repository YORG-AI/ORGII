import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  WORK_MANAGEMENT_DATASET_MENU_ORDER,
  WorkManagementDatasetSwitch,
} from "./WorkManagementDatasetSwitch";
import { WORK_MANAGEMENT_DATASET } from "./workManagementDataset";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "navigation:labels.inbox" ? "Localized Inbox" : key,
  }),
}));

describe("WorkManagementDatasetSwitch", () => {
  it.each([
    [WORK_MANAGEMENT_DATASET.INBOX, 'data-icon="inbox"'],
    [WORK_MANAGEMENT_DATASET.PROJECTS, 'data-icon="box"'],
    [WORK_MANAGEMENT_DATASET.WORK_ITEMS, 'data-icon="list-todo"'],
    [WORK_MANAGEMENT_DATASET.GITHUB_ISSUES, 'data-icon="circle-dot"'],
    [WORK_MANAGEMENT_DATASET.REVIEWS, 'data-icon="git-pull-request"'],
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
    expect(markup).toContain('data-icon="chevron-down"');
    expect(markup).not.toContain("rounded-[100px]");
  });

  it("uses the shared Inbox label and keeps Inbox first in the menu", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkManagementDatasetSwitch, {
        activeDataset: WORK_MANAGEMENT_DATASET.INBOX,
        onChange: vi.fn(),
      })
    );

    expect(markup).toContain("Localized Inbox");
    expect(WORK_MANAGEMENT_DATASET_MENU_ORDER).toEqual([
      WORK_MANAGEMENT_DATASET.INBOX,
      WORK_MANAGEMENT_DATASET.PROJECTS,
      WORK_MANAGEMENT_DATASET.WORK_ITEMS,
      WORK_MANAGEMENT_DATASET.GITHUB_ISSUES,
      WORK_MANAGEMENT_DATASET.REVIEWS,
    ]);
  });
});
