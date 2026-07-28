import { describe, expect, it } from "vitest";

import type { TabDragEventDetail } from "@src/modules/WorkStation/shared/TabBar/tabDragTypes";

import { buildCloudSessionReference } from "./cloudSessionReference";
import { draggedSession, insertAtCaret } from "./useSessionReferenceDropTarget";

const TEAM_REFERENCE = buildCloudSessionReference({
  orgId: "0aefaa1f-de59-4fbe-a4e5-57cbe6c2bbdd",
  ownerUserId: "6c6a39b1-4ca5-4c48-89b4-74d1565c258d",
  sourceSessionId: "codexapp-rollout-2026-07-27T13-57-08",
});

function detail(pill: TabDragEventDetail["pill"]): TabDragEventDetail {
  return { tabId: "row-1", pill };
}

describe("draggedSession", () => {
  it("takes a teammate row's reference verbatim", () => {
    // Someone else's session has no local push marker, so there is no org
    // to resolve — the row must carry the whole reference itself.
    expect(
      draggedSession(
        detail({ path: TEAM_REFERENCE, name: "x", iconType: "session" })
      )
    ).toEqual({ kind: "reference", reference: TEAM_REFERENCE });
  });

  it("reads the id from a local session pill", () => {
    expect(
      draggedSession(
        detail({ path: "session://sdeagent-1", name: "x", iconType: "session" })
      )
    ).toEqual({ kind: "local", sessionId: "sdeagent-1" });
  });

  it("drops the legacy timestamp suffix", () => {
    expect(
      draggedSession(
        detail({
          path: "session://sdeagent-1/1784838502631",
          name: "x",
          iconType: "session",
        })
      )
    ).toEqual({ kind: "local", sessionId: "sdeagent-1" });
  });

  it("ignores drags that are not sessions", () => {
    expect(
      draggedSession(
        detail({ path: "/src/index.ts", name: "index", iconType: "file" })
      )
    ).toBeNull();
    expect(draggedSession(detail(undefined))).toBeNull();
  });

  it("ignores a session pill with an empty id", () => {
    expect(
      draggedSession(
        detail({ path: "session://", name: "x", iconType: "session" })
      )
    ).toBeNull();
  });

  it("does not mistake a malformed reference for one", () => {
    expect(
      draggedSession(
        detail({
          path: "orgii://cloud/session/ref?v=9&org=a",
          name: "x",
          iconType: "session",
        })
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
