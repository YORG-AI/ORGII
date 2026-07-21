import { describe, expect, it } from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

import { isDeletedWorkItem } from "./workItemsViewModel";

function workItem(deletedAt?: string): WorkItem {
  return {
    session_id: "CUT-0001",
    name: "Remote tombstone",
    ...(deletedAt ? { deletedAt } : {}),
  } as WorkItem;
}

describe("isDeletedWorkItem", () => {
  it("treats a retained remote tombstone as unavailable", () => {
    expect(isDeletedWorkItem(workItem("2026-07-21T08:52:03.453Z"))).toBe(true);
  });

  it("keeps a live work item available", () => {
    expect(isDeletedWorkItem(workItem())).toBe(false);
  });
});
