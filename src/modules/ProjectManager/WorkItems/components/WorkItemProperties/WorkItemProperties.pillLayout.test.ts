// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

import WorkItemProperties from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("./PlanningSection", () => ({
  PlanningSection: () => createElement("span", null, "Planning"),
}));
vi.mock("./StatusPrioritySection", () => ({
  StatusPrioritySection: () => createElement("span", null, "Status"),
}));
vi.mock("./PeopleSection", () => ({
  PeopleSection: () => createElement("span", null, "People"),
}));
vi.mock("./DatesScheduleSection", () => ({
  DatesScheduleSection: () => createElement("span", null, "Dates"),
}));
vi.mock("./LabelsSection", () => ({
  LabelsSection: () => createElement("span", null, "Labels"),
}));
vi.mock("./DelegationsSection", () => ({
  DelegationsSection: () => createElement("span", null, "Delegations"),
}));
vi.mock("../ScheduleEditor", () => ({
  default: ({ compact }: { compact?: boolean }) =>
    createElement("span", { "data-compact": String(compact) }, "Schedule"),
}));
vi.mock("./useWorkItemPropertyHandlers", () => ({
  useWorkItemPropertyHandlers: () => ({}),
}));

const workItem = {
  session_id: "work-item-1",
  labels: [],
} as unknown as WorkItem;

describe("WorkItemProperties pill layout", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("wraps pills when the host opts into a responsive layout", () => {
    act(() => {
      root.render(
        createElement(WorkItemProperties, {
          workItem,
          onUpdate: vi.fn(),
          fieldVariant: "pill",
          pillLayout: "wrap",
        })
      );
    });

    const pills = container.querySelector(
      "[data-testid='work-item-property-pills']"
    );
    expect(pills?.getAttribute("data-layout")).toBe("wrap");
    expect(pills?.classList.contains("flex-wrap")).toBe(true);
    expect(pills?.classList.contains("flex-nowrap")).toBe(false);
  });

  it("preserves the compact single-row default for existing hosts", () => {
    act(() => {
      root.render(
        createElement(WorkItemProperties, {
          workItem,
          onUpdate: vi.fn(),
          fieldVariant: "pill",
        })
      );
    });

    const pills = container.querySelector(
      "[data-testid='work-item-property-pills']"
    );
    expect(pills?.getAttribute("data-layout")).toBe("nowrap");
    expect(pills?.classList.contains("flex-nowrap")).toBe(true);
  });

  it("uses the expand-properties icon for the More properties trigger", () => {
    act(() => {
      root.render(
        createElement(WorkItemProperties, {
          workItem,
          onUpdate: vi.fn(),
          fieldVariant: "pill",
          visibleFields: ["status"],
          showMoreMenu: true,
        })
      );
    });

    const moreProperties = container.querySelector(
      '[aria-label="workItems.contextMenu.moreProperties"]'
    );
    expect(moreProperties).not.toBeNull();
    expect(
      moreProperties?.querySelector(".lucide-list-chevrons-up-down")
    ).not.toBeNull();
    expect(moreProperties?.querySelector(".lucide-ellipsis")).toBeNull();
    expect(moreProperties?.classList.contains("!bg-bg-2")).toBe(true);
    expect(
      moreProperties?.classList.contains("enabled:hover:!bg-surface-hover")
    ).toBe(true);
  });

  it("flattens row properties into the shared Workstation trail layout", () => {
    act(() => {
      root.render(
        createElement(WorkItemProperties, {
          workItem,
          onUpdate: vi.fn(),
          panelVariant: "workstation-trail",
        })
      );
    });

    const panel = container.querySelector("section");
    expect(panel?.className).toContain("min-w-0 overflow-visible");
    expect(panel?.className).not.toContain("p-2");
    expect(container.textContent).toContain("workItems.properties.assignment");
    expect(container.querySelector('[data-compact="true"]')).not.toBeNull();
    expect(container.querySelector(".rounded-lg.border-border-2")).toBeNull();
  });
});
