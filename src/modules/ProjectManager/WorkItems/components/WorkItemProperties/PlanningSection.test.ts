import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

import { PlanningSection } from "./PlanningSection";
import type {
  WorkItemPropertyFieldKey,
  WorkItemPropertyHandlers,
} from "./types";

vi.mock("@src/components/IntegrationIcon", () => ({
  default: ({ type }: { type: string }) =>
    createElement("span", { "data-integration-icon": type }),
}));

vi.mock("@src/components/PropertyField/PropertyDropdownField", () => ({
  PropertyDropdownField: ({
    icon,
    label,
    readonly,
  }: {
    icon: ReactNode;
    label: string;
    readonly?: boolean;
  }) =>
    createElement(
      "div",
      {
        "data-testid": "project-property",
        "data-readonly": readonly ? "true" : "false",
      },
      icon,
      createElement("span", null, label)
    ),
}));

vi.mock("@src/components/PropertyField/PropertyFieldEditable", () => ({
  FieldRow: () => null,
  Option: () => null,
  SearchableDropdown: () => null,
}));

const workItem: WorkItem = {
  session_id: "work-item-1",
  user_id: "user-1",
  name: "Imported issue",
  status: "open",
  spec: "",
  star: false,
  target_date: null,
  created_time: "2026-07-21T00:00:00.000Z",
  updated_time: "2026-07-21T00:00:00.000Z",
  project: { id: "project-1", name: "ORGII issues" },
};

const handlers = {
  handleProjectChange: vi.fn(),
} as unknown as WorkItemPropertyHandlers;

describe("PlanningSection project icon", () => {
  it("renders the GitHub integration icon for a GitHub-imported project", () => {
    const markup = renderToStaticMarkup(
      createElement(PlanningSection, {
        workItem,
        openPicker: null,
        togglePicker: () => undefined,
        availableProjects: [workItem.project!],
        availableMilestones: [],
        handlers,
        t: (key) => key,
        projectIconType: "github",
        projectReadonly: true,
        visibleFields: new Set<WorkItemPropertyFieldKey>(["project"]),
      })
    );

    expect(markup).toContain('data-integration-icon="github"');
    expect(markup).toContain('data-readonly="true"');
    expect(markup).toContain("ORGII issues");
  });
});
