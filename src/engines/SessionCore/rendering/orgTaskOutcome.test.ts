import { describe, expect, it } from "vitest";

import type { RustExtractedOrgTaskData } from "@src/engines/SessionCore/core/types";

import {
  isPersistedOrgTaskEvent,
  resolveOrgTaskOperationOutcome,
} from "./orgTaskOutcome";

function legacyTask(
  overrides: Partial<RustExtractedOrgTaskData> = {}
): RustExtractedOrgTaskData {
  return {
    action: "create",
    outcome: "unknown",
    tasks: [],
    ...overrides,
  };
}

describe("resolveOrgTaskOperationOutcome", () => {
  it("preserves a new explicit outcome", () => {
    expect(
      resolveOrgTaskOperationOutcome({
        ...legacyTask(),
        outcome: "rejected",
      })
    ).toBe("rejected");
  });

  it.each([
    { rejected: true, rejection_code: "lifecycle_owner_only" },
    { created: false },
    { requires_dependency_confirmation: true },
    { authorization_denied: true },
    { already_exists: true },
    { status_ignored: true },
    { deleted: false },
  ])("treats a legacy structured non-mutation as rejected: %o", (result) => {
    expect(resolveOrgTaskOperationOutcome(legacyTask(), result)).toBe(
      "rejected"
    );
  });

  it("recovers an omitted legacy outcome from a wrapped result", () => {
    const extracted = { ...legacyTask(), outcome: undefined };

    expect(
      resolveOrgTaskOperationOutcome(extracted, {
        content: JSON.stringify({ authorization_denied: true }),
      })
    ).toBe("rejected");
  });

  it("downgrades legacy task validation failures to a correction state", () => {
    const result = {
      content:
        "Error executing task_update: Invalid parameters: parameter validation failed: missing field `summary`",
    };

    expect(
      resolveOrgTaskOperationOutcome(
        { ...legacyTask(), outcome: "failed" },
        result,
        "failed"
      )
    ).toBe("rejected");
  });

  it("keeps infrastructure-shaped task failures red", () => {
    const result = {
      content: "Error executing task_update: database connection closed",
    };

    expect(
      resolveOrgTaskOperationOutcome(
        { ...legacyTask(), outcome: "failed" },
        result,
        "failed"
      )
    ).toBe("failed");
  });

  it("does not treat an args-only completed event as persisted", () => {
    const extracted = legacyTask({
      task: {
        id: "",
        subject: "Attempted task",
        status: "pending",
        blocks: [],
        blockedBy: [],
      },
    });

    expect(resolveOrgTaskOperationOutcome(extracted, {}, "completed")).toBe(
      "failed"
    );
    expect(isPersistedOrgTaskEvent(extracted, {}, "completed")).toBe(false);
  });

  it("recognizes a legacy persisted task result", () => {
    const extracted = legacyTask({
      task: {
        id: "task-1",
        subject: "Persisted task",
        status: "pending",
        blocks: [],
        blockedBy: [],
      },
    });

    expect(isPersistedOrgTaskEvent(extracted, {}, "completed")).toBe(true);
  });
});
