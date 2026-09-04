import {
  WORK_MANAGEMENT_PROJECTS_VIEW,
  WORK_MANAGEMENT_SECTION,
  type WorkManagementProjectsView,
  type WorkManagementSection,
} from "@src/store/workstation";

export const WORK_MANAGEMENT_DATASET = {
  PROJECTS: "projects",
  WORK_ITEMS: "work-items",
  INBOX: "inbox",
  GITHUB_ISSUES: "github-issues",
  REVIEWS: "reviews",
} as const;

export type WorkManagementDataset =
  (typeof WORK_MANAGEMENT_DATASET)[keyof typeof WORK_MANAGEMENT_DATASET];

/**
 * Kanban is a separate product surface. Project records, work items, issues,
 * and reviews are dataset views inside the single Work destination.
 */
export function resolveWorkManagementDataset({
  section,
  projectsView,
}: {
  section: WorkManagementSection;
  projectsView: WorkManagementProjectsView;
}): WorkManagementDataset | null {
  if (section === WORK_MANAGEMENT_SECTION.INBOX) {
    return WORK_MANAGEMENT_DATASET.INBOX;
  }
  if (section === WORK_MANAGEMENT_SECTION.GITHUB_ISSUES) {
    return WORK_MANAGEMENT_DATASET.GITHUB_ISSUES;
  }
  if (section === WORK_MANAGEMENT_SECTION.GITHUB_PRS) {
    return WORK_MANAGEMENT_DATASET.REVIEWS;
  }
  if (
    section === WORK_MANAGEMENT_SECTION.PROJECTS &&
    projectsView === WORK_MANAGEMENT_PROJECTS_VIEW.WORK_ITEMS
  ) {
    return WORK_MANAGEMENT_DATASET.WORK_ITEMS;
  }
  if (section === WORK_MANAGEMENT_SECTION.PROJECTS) {
    return WORK_MANAGEMENT_DATASET.PROJECTS;
  }
  return null;
}
