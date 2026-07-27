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
});
