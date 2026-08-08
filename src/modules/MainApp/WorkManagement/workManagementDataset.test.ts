import { describe, expect, it } from "vitest";

import {
  WORK_MANAGEMENT_PROJECTS_VIEW,
  WORK_MANAGEMENT_SECTION,
} from "@src/store/workstation";

import {
  WORK_MANAGEMENT_DATASET,
  resolveWorkManagementDataset,
} from "./workManagementDataset";

describe("resolveWorkManagementDataset", () => {
  it("projects each list surface into the Work dataset switch", () => {
    expect(
      resolveWorkManagementDataset({
        section: WORK_MANAGEMENT_SECTION.PROJECTS,
        projectsView: WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS,
      })
    ).toBe(WORK_MANAGEMENT_DATASET.PROJECTS);
    expect(
      resolveWorkManagementDataset({
        section: WORK_MANAGEMENT_SECTION.PROJECTS,
        projectsView: WORK_MANAGEMENT_PROJECTS_VIEW.WORK_ITEMS,
      })
    ).toBe(WORK_MANAGEMENT_DATASET.WORK_ITEMS);
    expect(
      resolveWorkManagementDataset({
        section: WORK_MANAGEMENT_SECTION.GITHUB_ISSUES,
        projectsView: WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS,
      })
    ).toBe(WORK_MANAGEMENT_DATASET.GITHUB_ISSUES);
    expect(
      resolveWorkManagementDataset({
        section: WORK_MANAGEMENT_SECTION.GITHUB_PRS,
        projectsView: WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS,
      })
    ).toBe(WORK_MANAGEMENT_DATASET.REVIEWS);
  });
});
