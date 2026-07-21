import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProjectData } from "@src/modules/ProjectManager/shared";

import WorkItemsOverview from ".";

vi.mock("@src/modules/ProjectManager/shared", () => ({
  PROJECT_PROPERTY_CONCISE_FIELDS: [],
  ProjectContentEditor: ({ metaContent }: { metaContent?: React.ReactNode }) =>
    createElement("div", null, metaContent),
  ProjectPropertyFields: () =>
    createElement("div", { "data-testid": "project-properties-row" }),
}));

const projectProperties = {
  id: "project-1",
  name: "Project",
  status: "backlog",
  priority: "none",
  health: "no_updates",
} as ProjectData;

function renderOverview(hideProjectPropertiesRow: boolean) {
  return renderToStaticMarkup(
    createElement(WorkItemsOverview, {
      workItems: [],
      projectName: "Project",
      projectProperties,
      hideProjectPropertiesRow,
    })
  );
}

describe("WorkItemsOverview", () => {
  it("hides the project properties row when requested", () => {
    expect(renderOverview(true)).not.toContain("project-properties-row");
  });

  it("keeps the project properties row for regular projects", () => {
    expect(renderOverview(false)).toContain("project-properties-row");
  });
});
