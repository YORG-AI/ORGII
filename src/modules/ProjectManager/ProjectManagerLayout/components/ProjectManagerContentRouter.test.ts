// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/modules/WorkStation/TabContent/UnifiedTabContent", () => ({
  UnifiedTabContent: ({
    tab,
    isActive,
  }: {
    tab: { id: string };
    isActive: boolean;
  }) =>
    createElement("div", {
      "data-testid": "trio-pane",
      "data-tab-id": tab.id,
      "data-active": String(isActive),
    }),
}));
vi.mock("@src/modules/WorkStation/shared", () => ({
  NoTabsPlaceholder: () => createElement("div", { "data-testid": "no-tabs" }),
}));
vi.mock("@src/components/Placeholder", () => ({
  Placeholder: () => null,
}));

const { PROJECT_TRIO_KEEP_ALIVE, ProjectManagerContentRouter } =
  await import("./ProjectManagerContentRouter");

type RouterProps = Parameters<typeof ProjectManagerContentRouter>[0];
type Tab = RouterProps["tabs"][number];

function trioTab(id: string, type: Tab["type"]): Tab {
  return { id, type, title: id, data: {} } as unknown as Tab;
}

describe("ProjectManagerContentRouter trio keep-alive", () => {
  let container: HTMLDivElement;
  let root: Root;
  const tabs = [
    trioTab("wi", "project-workitems"),
    trioTab("lp", "project-linear-projects"),
    trioTab("lw", "project-linear-work-items"),
  ];

  const mountedIds = () =>
    [...container.querySelectorAll('[data-testid="trio-pane"]')]
      .map((node) => node.getAttribute("data-tab-id"))
      .sort();

  const render = (activeIndex: number) =>
    act(() => {
      root.render(
        createElement(ProjectManagerContentRouter, {
          repoPath: "/repo",
          tabs,
          activeTab: tabs[activeIndex],
          projectQuickActions: [],
        } as unknown as RouterProps)
      );
    });

  beforeEach(() => {
    vi.useFakeTimers();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("mounts only the active trio tab first, keeps the previous one hidden for the grace window, then unmounts it", () => {
    render(0);
    expect(mountedIds()).toEqual(["wi"]);

    render(1);
    expect(mountedIds()).toEqual(["lp", "wi"]);
    const hidden = container.querySelector('[data-tab-id="wi"]');
    expect(hidden?.getAttribute("data-active")).toBe("false");
    expect(hidden?.closest("div[style]")?.getAttribute("style")).toContain(
      "display: none"
    );

    act(() => {
      vi.advanceTimersByTime(PROJECT_TRIO_KEEP_ALIVE.graceMs);
    });
    expect(mountedIds()).toEqual(["lp"]);
  });

  it("never keeps more than maxWarm trio tabs mounted", () => {
    render(0);
    render(1);
    render(2);
    expect(mountedIds()).toEqual(["lp", "lw"]);
    expect(mountedIds().length).toBe(PROJECT_TRIO_KEEP_ALIVE.maxWarm);
  });
});
