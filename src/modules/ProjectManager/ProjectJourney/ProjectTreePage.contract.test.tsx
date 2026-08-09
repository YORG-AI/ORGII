// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ProjectTreePage from "./ProjectTreePage";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./loadProjectTree", () => ({
  loadProjectTreeBundle: vi.fn().mockResolvedValue({
    tree: {
      id: "workspace:root",
      kind: "workspace",
      title: "Workspace",
      children: [
        {
          id: "project:p",
          kind: "project",
          title: "项目 P",
          projectId: "p",
          projectSlug: "project-p",
          children: [
            {
              id: "session:s",
              kind: "session",
              title: "实现会话",
              sessionId: "session-1",
              workItemId: "work-1",
              projectSlug: "project-p",
              children: [],
              meta: { workItemName: "仅元数据工作项" },
            },
          ],
        },
      ],
    },
    projects: [],
    workItemsByProject: {},
    standaloneWorkItems: [],
    usedDemo: false,
  }),
}));

describe("ProjectTreePage production session route", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders Project -> Session directly and opens the live Journey session", async () => {
    const onOpenSession = vi.fn();
    await act(async () => {
      root.render(<ProjectTreePage onOpenSession={onOpenSession} />);
    });

    expect(container.textContent).toContain("工作区 → 项目 → 会话 → 旅程");
    expect(
      container.querySelector('[data-testid="project-tree-row-work_item"]')
    ).toBeNull();

    const button = container.querySelector(
      '[data-testid="project-tree-open-session-session-1"]'
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    await act(async () => button.click());
    expect(onOpenSession).toHaveBeenCalledWith(
      "session-1",
      "实现会话",
      "work-1",
      "project-p"
    );
  });
});
