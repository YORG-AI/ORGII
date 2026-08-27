import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";

import { OrgTaskAdapter } from "./OrgTaskAdapter";

vi.mock("@src/engines/ChatPanel/hooks/useChatEventReplay", () => ({
  useChatEventReplay: () => ({
    replayEventById: vi.fn(),
    canReplay: false,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (
        key ===
        "planner.agentOrgOverview.coordinatorWorkState.waiting_for_org_event"
      )
        return "Coordinator waiting for an event";
      if (key === "planner.agentOrgOverview.coordinatorWorkState.active")
        return "Coordinator active";
      if (key === "orgTask.list.count")
        return `${String(values?.taskCount ?? 0)} tasks`;
      return String(values?.defaultValue ?? key);
    },
  }),
}));

const baseProps: UniversalEventProps = {
  eventId: "event-task-update-test",
  eventType: "task_update",
  functionName: "task_update",
  args: { summary: "raw task input" },
  result: { guidance: "raw task output" },
  status: "success",
  variant: "chat",
  context: "chat",
};

describe("OrgTaskAdapter raw fallback rendering", () => {
  it("collapses raw task events when extracted task data is unavailable", () => {
    const markup = renderToStaticMarkup(
      createElement(OrgTaskAdapter, baseProps)
    );

    expect(markup).toContain('data-tool-call-name="task_update"');
    expect(markup).not.toContain("raw task input");
    expect(markup).not.toContain("raw task output");
  });

  it("collapses raw task events when extraction has no renderable task", () => {
    const markup = renderToStaticMarkup(
      createElement(OrgTaskAdapter, {
        ...baseProps,
        rustExtracted: {
          kind: "orgTask",
          action: "update",
          outcome: "succeeded",
        },
      })
    );

    expect(markup).not.toContain("raw task input");
    expect(markup).not.toContain("raw task output");
  });

  it("renders a no-progress task_list as waiting, not as an empty task board", () => {
    const markup = renderToStaticMarkup(
      createElement(OrgTaskAdapter, {
        ...baseProps,
        eventType: "task_list",
        functionName: "task_list",
        rustExtracted: {
          kind: "orgTask",
          action: "list",
          outcome: "succeeded",
          taskListObservation: "no_new_work_facts",
          tasks: [],
        },
      })
    );

    expect(markup).toContain('data-task-list-observation="no_new_work_facts"');
    expect(markup).toContain("Coordinator waiting for an event");
    expect(markup).not.toContain("0 tasks");
    expect(markup).not.toContain("No tasks");
  });

  it("continues to render a real empty task_list as zero results", () => {
    const markup = renderToStaticMarkup(
      createElement(OrgTaskAdapter, {
        ...baseProps,
        eventType: "task_list",
        functionName: "task_list",
        rustExtracted: {
          kind: "orgTask",
          action: "list",
          outcome: "succeeded",
          taskListObservation: "results",
          tasks: [],
          total: 0,
        },
      })
    );

    expect(markup).toContain('data-task-list-observation="results"');
    expect(markup).toContain("0 tasks");
    expect(markup).not.toContain("Coordinator waiting for an event");
  });

  it("renders a pending durable trigger without inventing an empty board", () => {
    const markup = renderToStaticMarkup(
      createElement(OrgTaskAdapter, {
        ...baseProps,
        eventType: "task_list",
        functionName: "task_list",
        rustExtracted: {
          kind: "orgTask",
          action: "list",
          outcome: "succeeded",
          taskListObservation: "new_trigger_pending",
          tasks: [],
        },
      })
    );

    expect(markup).toContain(
      'data-task-list-observation="new_trigger_pending"'
    );
    expect(markup).toContain("Coordinator active");
    expect(markup).not.toContain("0 tasks");
  });

  it("fails an unknown task_list control result closed to the generic card", () => {
    const markup = renderToStaticMarkup(
      createElement(OrgTaskAdapter, {
        ...baseProps,
        eventType: "task_list",
        functionName: "task_list",
        rustExtracted: {
          kind: "orgTask",
          action: "list",
          outcome: "succeeded",
          taskListObservation: "unknown",
          tasks: [],
        },
      })
    );

    expect(markup).toContain('data-tool-call-name="task_list"');
    expect(markup).not.toContain("data-task-list-observation");
  });
});
