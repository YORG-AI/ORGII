// @vitest-environment jsdom
import type { VirtualItem } from "@tanstack/react-virtual";
import React, { act, createElement, createRef } from "react";
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

import GanttChart from ".";
import GanttSidebar from "./components/Sidebar";
import GanttTimeline from "./components/Timeline";
import { generateViewScopePeriods } from "./config";
import type { GanttMarkerRow, GanttTask } from "./types";
import { DEFAULT_GANTT_CONFIG } from "./types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function virtualItem(index: number, start: number, size: number): VirtualItem {
  return {
    key: index,
    index,
    start,
    end: start + size,
    size,
    lane: 0,
  };
}

function buildTasks(count: number): GanttTask[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    endDate: new Date("2026-07-02T00:00:00.000Z"),
  }));
}

describe("GanttChart virtualization", () => {
  let container: HTMLDivElement;
  let root: Root;
  let unobserveCount = 0;
  let disconnectCount = 0;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe() {}
        unobserve() {
          unobserveCount += 1;
        }
        disconnect() {
          disconnectCount += 1;
        }
      }
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 800,
      height: 400,
      top: 0,
      right: 800,
      bottom: 400,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
  });

  beforeEach(() => {
    unobserveCount = 0;
    disconnectCount = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the same bounded row window in the sidebar and timeline", async () => {
    const tasks = buildTasks(100);
    const markerRows: GanttMarkerRow[] = [
      { id: "events", title: "Events", markers: [] },
    ];
    const periods = generateViewScopePeriods(
      new Date("2026-07-01T00:00:00.000Z"),
      "1m",
      1
    );
    const virtualRows = [
      virtualItem(0, 0, 40),
      virtualItem(51, 2040, 40),
      virtualItem(100, 4000, 40),
    ];
    const virtualPeriods = [
      virtualItem(0, 0, 40),
      virtualItem(30, 1200, 40),
      virtualItem(periods.length - 1, (periods.length - 1) * 40, 40),
    ];

    await act(async () => {
      root.render(
        createElement(
          React.Fragment,
          null,
          createElement(GanttSidebar, {
            tasks,
            markerRows,
            config: DEFAULT_GANTT_CONFIG,
            sidebarContentRef: createRef<HTMLDivElement>(),
            virtualRows,
            totalSize: 4040,
            onScroll: vi.fn(),
          }),
          createElement(GanttTimeline, {
            tasks,
            markerRows,
            config: DEFAULT_GANTT_CONFIG,
            viewScope: "1m",
            viewStart: periods[0].date,
            timelineStart: periods[0].date,
            periods,
            columnWidth: 40,
            totalWidth: periods.length * 40,
            timelineBodyRef: createRef<HTMLDivElement>(),
            onTimelineScroll: vi.fn(),
            virtualRows,
            totalRowSize: 4040,
            virtualPeriods,
          })
        )
      );
    });

    expect(container.querySelectorAll("[data-gantt-row-index]")).toHaveLength(
      virtualRows.length
    );
    expect(
      container.querySelectorAll(".gantt-timeline__grid-row")
    ).toHaveLength(virtualRows.length);
    expect(
      container.querySelectorAll(".gantt-timeline__header-cell")
    ).toHaveLength(virtualPeriods.length);
    expect(
      container.querySelectorAll(".gantt-timeline__grid-cell")
    ).toHaveLength(virtualRows.length * virtualPeriods.length);
    expect(container.textContent).toContain("Task 50");
    expect(container.textContent).not.toContain("Task 49");
  });

  it("releases virtualizer observers when the chart closes", async () => {
    await act(async () => {
      root.render(
        createElement(GanttChart, {
          tasks: buildTasks(100),
          hideToolbar: true,
        })
      );
    });

    const renderedSidebarRows = container.querySelectorAll(
      "[data-gantt-row-index]"
    ).length;
    expect(renderedSidebarRows).toBeGreaterThan(0);
    expect(renderedSidebarRows).toBeLessThan(100);
    expect(
      container.querySelectorAll(".gantt-timeline__grid-row")
    ).toHaveLength(renderedSidebarRows);
    expect(
      container.querySelectorAll(".gantt-timeline__header-cell").length
    ).toBeLessThan(generateViewScopePeriods(new Date(), "7d").length);

    act(() => root.unmount());
    root = createRoot(container);

    expect(unobserveCount).toBeGreaterThanOrEqual(2);
    expect(disconnectCount).toBeGreaterThanOrEqual(1);
    expect(container.childElementCount).toBe(0);
  });

  it("does not reapply the initial horizontal target after data refreshes", async () => {
    const initialDate = new Date("2026-07-29T00:00:00");
    const initialTarget = new Date("2026-07-29T12:00:00");
    const renderChart = (target: Date) =>
      createElement(GanttChart, {
        tasks: [],
        defaultViewScope: "1d" as const,
        initialDate,
        initialScrollTargetDate: target,
        initialScrollTargetAlignment: "center" as const,
        periodScrollMultiplier: 0,
        minColumnWidth: 72,
        hideToolbar: true,
      });

    await act(async () => {
      root.render(renderChart(initialTarget));
    });

    const timelineBody = container.querySelector<HTMLElement>(
      ".gantt-timeline__body"
    );
    expect(timelineBody).not.toBeNull();
    timelineBody!.scrollLeft = 100;

    await act(async () => {
      root.render(renderChart(new Date(initialTarget.getTime() + 30_000)));
    });

    expect(timelineBody!.scrollLeft).toBe(100);
  });
});
