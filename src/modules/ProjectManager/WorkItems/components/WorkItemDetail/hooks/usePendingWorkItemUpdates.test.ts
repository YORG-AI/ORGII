import { describe, expect, it, vi } from "vitest";

import {
  needsImmediateWorkItemUpdate,
  routeWorkItemUpdate,
} from "./usePendingWorkItemUpdates";

describe("routeWorkItemUpdate", () => {
  it("sends status changes through the immediate handler because pending updates strip them", () => {
    const local = vi.fn();
    const immediate = vi.fn();
    routeWorkItemUpdate(
      { workItemStatus: "code-review" as never },
      { local, immediate }
    );
    expect(immediate).toHaveBeenCalledWith({ workItemStatus: "code-review" });
    expect(local).not.toHaveBeenCalled();
  });

  it("keeps non-status edits on the pending path", () => {
    const local = vi.fn();
    const immediate = vi.fn();
    routeWorkItemUpdate({ priority: "high" }, { local, immediate });
    expect(local).toHaveBeenCalledWith({ priority: "high" });
    expect(immediate).not.toHaveBeenCalled();
  });

  it("falls back to the local handler when no immediate handler exists", () => {
    const local = vi.fn();
    routeWorkItemUpdate({ workItemStatus: "in_progress" }, { local });
    expect(local).toHaveBeenCalledWith({ workItemStatus: "in_progress" });
  });

  it("flags both status spellings", () => {
    expect(needsImmediateWorkItemUpdate({ status: "open" as never })).toBe(
      true
    );
    expect(needsImmediateWorkItemUpdate({ name: "x" })).toBe(false);
  });
});
