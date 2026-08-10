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
              title: "没有工作项的会话",
              sessionId: "session-1",
              projectSlug: "project-p",
              children: [
                {
                  id: "task:session-1:task-1",
                  kind: "task",
                  title: "Exact task",
                  sessionId: "session-1",
                  taskId: "task-1",
                  children: [
                    {
                      id: "checkpoint:session-1:checkpoint-1",
                      kind: "checkpoint",
                      title: "Durable checkpoint",
                      sessionId: "session-1",
                      taskId: "task-1",
                      checkpointId: "checkpoint-1",
                      anchorMessageId: "message-8",
                      children: [],
                    },
                  ],
                },
                {
                  id: "fork:session-1:fork-1",
                  kind: "fork",
                  title: "fork-1",
                  sessionId: "session-1",
                  forkId: "fork-1",
                  anchorMessageId: "message-7",
                  anchorSequence: 7,
                  children: [],
                },
              ],
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
  streamSessionJourneys: vi.fn().mockResolvedValue(undefined),
  loadSessionJourney: vi.fn(),
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

  it("keeps project and session journeys visible while preserving chat opening", async () => {
    const onOpenJourney = vi.fn();
    const onOpenSession = vi.fn();
    const onOpenSessionJourney = vi.fn();
    await act(async () => {
      root.render(
        <ProjectTreePage
          onOpenJourney={onOpenJourney}
          onOpenSession={onOpenSession}
          onOpenSessionJourney={onOpenSessionJourney}
        />
      );
    });

    expect(container.textContent).toContain("工作区 → 项目 → 会话 → 旅程");
    expect(
      container.querySelector('[data-testid="project-tree-row-work_item"]')
    ).toBeNull();

    const projectJourneyButton = container.querySelector(
      '[data-testid="project-tree-open-project-journey-p"]'
    ) as HTMLButtonElement;
    expect(projectJourneyButton).not.toBeNull();
    expect(projectJourneyButton.className).not.toContain("hidden");
    await act(async () => projectJourneyButton.click());
    expect(onOpenJourney).toHaveBeenCalledWith("p", "project-p", "项目 P");

    const chatButton = container.querySelector(
      '[data-testid="project-tree-open-session-session-1"]'
    ) as HTMLButtonElement;
    expect(chatButton).not.toBeNull();
    expect(chatButton.textContent).toBe("打开会话");
    await act(async () => chatButton.click());
    expect(onOpenSession).toHaveBeenCalledWith(
      "session-1",
      "没有工作项的会话",
      undefined,
      "project-p"
    );

    const sessionJourneyButton = container.querySelector(
      '[data-testid="project-tree-open-session-journey-session-1"]'
    ) as HTMLButtonElement;
    expect(sessionJourneyButton).not.toBeNull();
    expect(sessionJourneyButton.className).not.toContain("hidden");
    await act(async () => sessionJourneyButton.click());
    expect(onOpenSessionJourney).toHaveBeenCalledWith(
      "session-1",
      "没有工作项的会话"
    );

    const checkpointButton = container.querySelector(
      '[data-testid="project-tree-open-checkpoint-history-checkpoint-1"]'
    ) as HTMLButtonElement;
    await act(async () => checkpointButton.click());
    expect(onOpenSession).toHaveBeenCalledWith(
      "session-1",
      "Durable checkpoint",
      undefined,
      undefined,
      "message-8"
    );

    const taskJourneyButton = container.querySelector(
      '[data-testid="project-tree-open-task-journey-task-1"]'
    ) as HTMLButtonElement;
    await act(async () => taskJourneyButton.click());
    expect(onOpenSessionJourney).toHaveBeenCalledWith(
      "session-1",
      "Exact task",
      { taskId: "task-1" }
    );

    const forkJourneyButton = container.querySelector(
      '[data-testid="project-tree-open-fork-journey-fork-1"]'
    ) as HTMLButtonElement;
    await act(async () => forkJourneyButton.click());
    expect(onOpenSession).toHaveBeenCalledWith(
      "session-1",
      "fork-1",
      undefined,
      undefined,
      "message-7"
    );
  });
});
