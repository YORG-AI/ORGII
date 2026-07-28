import { describe, expect, it } from "vitest";

import type { TabDragEventDetail } from "@src/modules/WorkStation/shared/TabBar/tabDragTypes";

import {
  draggedSessionId,
  insertAtCaret,
} from "./useSessionReferenceDropTarget";

function detail(pill: TabDragEventDetail["pill"]): TabDragEventDetail {
  return { tabId: "row-1", pill };
}

describe("draggedSessionId", () => {
  it("reads the id from a session pill", () => {
    expect(
      draggedSessionId(
        detail({ path: "session://sdeagent-1", name: "x", iconType: "session" })
      )
    ).toBe("sdeagent-1");
  });

  it("drops the legacy timestamp suffix", () => {
    expect(
      draggedSessionId(
        detail({
          path: "session://sdeagent-1/1784838502631",
          name: "x",
          iconType: "session",
        })
      )
    ).toBe("sdeagent-1");
  });

  it("ignores drags that are not sessions", () => {
    expect(
      draggedSessionId(
        detail({ path: "/src/index.ts", name: "index", iconType: "file" })
      )
    ).toBeNull();
    expect(draggedSessionId(detail(undefined))).toBeNull();
  });

  it("ignores a session pill with an empty id", () => {
    expect(
      draggedSessionId(
        detail({ path: "session://", name: "x", iconType: "session" })
      )
    ).toBeNull();
  });
});

describe("insertAtCaret", () => {
  it("inserts into an empty field without padding it", () => {
    expect(insertAtCaret("", 0, 0, "REF")).toEqual({ value: "REF", caret: 3 });
  });

  it("spaces the reference off from adjacent words", () => {
    expect(insertAtCaret("see", 3, 3, "REF")).toEqual({
      value: "see REF",
      caret: 7,
    });
    // Caret lands right after the reference, before the existing space.
    expect(insertAtCaret("see now", 3, 3, "REF")).toEqual({
      value: "see REF now",
      caret: 7,
    });
  });

  it("does not double a space that is already there", () => {
    expect(insertAtCaret("see ", 4, 4, "REF")).toEqual({
      value: "see REF",
      caret: 7,
    });
    expect(insertAtCaret("see  now", 4, 4, "REF")).toEqual({
      value: "see REF now",
      caret: 7,
    });
  });

  it("replaces the selection when the drop lands on one", () => {
    expect(insertAtCaret("keep DROPME end", 5, 11, "REF")).toEqual({
      value: "keep REF end",
      caret: 8,
    });
  });
});
