import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  buildTaskListCard,
  isOrgTaskEvent,
  resolveOrgTaskTitle,
  resolveRecipientLabel,
} from "../AgentEventBubbles/model";

const event = (functionName: string): SessionEvent =>
  ({ functionName }) as SessionEvent;

describe("AgentEventBubbles model", () => {
  it("recognizes the complete task tool family", () => {
    expect(isOrgTaskEvent(event("task_create"))).toBe(true);
    expect(isOrgTaskEvent(event("task_graph_create"))).toBe(true);
    expect(isOrgTaskEvent(event("task_update"))).toBe(true);
    expect(isOrgTaskEvent(event("task_list"))).toBe(true);
    expect(isOrgTaskEvent(event("task_get"))).toBe(true);
    expect(isOrgTaskEvent(event("read_file"))).toBe(false);
  });

  it("resolves recipients from the roster before prettifying ids", () => {
    const members = [{ memberId: "planner", name: "Planning Agent" }] as never;
    expect(resolveRecipientLabel("planner", members)).toBe("Planning Agent");
    expect(resolveRecipientLabel("code_reviewer", undefined)).toBe(
      "Code reviewer"
    );
    expect(resolveRecipientLabel("  ", undefined)).toBe("");
  });

  it("returns no list card for missing or unrelated payloads", () => {
    expect(buildTaskListCard(event("task_list"))).toBeNull();
    expect(buildTaskListCard(event("read_file"))).toBeNull();
  });

  it("builds an empty get card when the payload has no task", () => {
    const taskGetEvent = {
      functionName: "task_get",
      extracted: { kind: "orgTask", action: "get", tasks: [] },
    } as unknown as SessionEvent;
    expect(buildTaskListCard(taskGetEvent)).toMatchObject({
      kind: "get",
      tasks: [],
    });
  });

  it("preserves the unknown action fallback", () => {
    const t = vi.fn((key: string) => key);
    expect(resolveOrgTaskTitle(event("unknown"), "Planner", t, true)).toBe(
      "Planner"
    );
    expect(t).not.toHaveBeenCalled();
  });

  it("uses outcome-aware titles before ordinary-session todo fallback", () => {
    const t = vi.fn((key: string) => key);
    const pending = {
      functionName: "task_create",
      displayStatus: "pending",
      extracted: { kind: "orgTask", action: "create" },
    } as unknown as SessionEvent;

    expect(resolveOrgTaskTitle(pending, "Planner", t, false)).toContain(
      "taskCreateRunning"
    );
  });
});
