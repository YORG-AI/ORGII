import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentOrgRunView } from "@src/api/tauri/agent";
import { AgentOrgTaskProjectionProvider } from "@src/engines/ChatPanel/ChatHistory/AgentOrgTaskProjectionContext";
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

function projectionView(
  tasks: AgentOrgRunView["taskStateWindow"]["tasks"]
): AgentOrgRunView {
  return {
    context: { runId: "run-current" },
    taskStateWindow: { tasks, truncated: false },
  } as AgentOrgRunView;
}

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

  it("renders background finality as a deferred warning without failing the task", () => {
    const markup = renderToStaticMarkup(
      createElement(OrgTaskAdapter, {
        ...baseProps,
        args: {
          operation: "complete",
          id: "task-background",
        },
        result: {
          rejected: true,
          completion_deferred: true,
          task_status_unchanged: true,
          guidance:
            "Stop the background server, consume its result, then retry.",
        },
        rustExtracted: {
          kind: "orgTask",
          action: "update",
          outcome: "rejected",
          completionDeferred: true,
          guidance:
            "Stop the background server, consume its result, then retry.",
          task: {
            id: "task-background",
            subject: "Verify avatar UI",
            owner: "implementer",
            status: "in_progress",
            blocks: [],
            blockedBy: [],
          },
        },
      })
    );

    expect(markup).toContain('data-operation-outcome="deferred"');
    expect(markup).toContain("Completion deferred · waiting for cleanup");
    expect(markup).toContain("in_progress");
    expect(markup).toContain("Stop the background server");
    expect(markup).not.toContain('data-operation-outcome="failed"');
  });

  it("keeps the event status immutable while showing the current cancelled Task", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AgentOrgTaskProjectionProvider,
        {
          view: projectionView([
            {
              taskId: "task-history",
              status: "cancelled",
              ownerMemberId: "member-new-owner",
              activationGeneration: 3,
              replacementTaskId: "task-replacement",
              updatedAt: "2026-09-06T00:00:00Z",
            },
          ]),
        },
        createElement(OrgTaskAdapter, {
          ...baseProps,
          rustExtracted: {
            kind: "orgTask",
            action: "update",
            outcome: "succeeded",
            orgRunId: "run-current",
            task: {
              id: "task-history",
              subject: "Historical task",
              status: "in_progress",
            },
          },
        })
      )
    );

    expect(markup).toContain('data-event-status="in_progress"');
    expect(markup).toContain('data-current-status="cancelled"');
    expect(markup).toContain('data-current-generation="3"');
    expect(markup).toContain(
      'data-current-replacement-task-id="task-replacement"'
    );
    expect(markup).toContain("Current status");
    expect(markup).toContain("cancelled");
    expect(markup).toContain("Current owner");
    expect(markup).toContain("Member new owner");
    expect(markup).toContain("task-replacement");
  });

  it("does not present stale in-progress history as current when the Task is absent", () => {
    const markup = renderToStaticMarkup(
      createElement(
        AgentOrgTaskProjectionProvider,
        { view: projectionView([]) },
        createElement(OrgTaskAdapter, {
          ...baseProps,
          rustExtracted: {
            kind: "orgTask",
            action: "update",
            outcome: "succeeded",
            orgRunId: "run-current",
            task: {
              id: "task-missing",
              subject: "Historical task",
              status: "in_progress",
            },
          },
        })
      )
    );

    expect(markup).toContain('data-event-status="in_progress"');
    expect(markup).toContain('data-current-record-unavailable="true"');
    expect(markup).toContain("Current state unavailable");
  });
});
