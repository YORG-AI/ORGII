import { describe, expect, it } from "vitest";

import {
  createCanvasInteractionState,
  reconcileCanvasInteractionState,
  selectCanvasEvent,
  setCanvasViewTab,
  toggleCanvasComparison,
} from "./canvasInteractionState";

describe("canvas interaction state", () => {
  it("selects the latest event initially and lets a valid preview win", () => {
    expect(createCanvasInteractionState(["a", "b"], null)).toMatchObject({
      selectedEventId: "b",
      activeTab: "canvas",
      reloadKey: 1,
      observedEventCount: 2,
    });

    expect(createCanvasInteractionState(["a", "b"], "a")).toMatchObject({
      selectedEventId: "a",
      reloadKey: 1,
    });
  });

  it("honors a pending preview when its event hydrates without double reloading", () => {
    const pending = createCanvasInteractionState([], "a");
    const hydrated = reconcileCanvasInteractionState(pending, ["a", "b"], "a");

    expect(hydrated).toMatchObject({
      selectedEventId: "a",
      activeTab: "canvas",
      reloadKey: 1,
      observedEventCount: 2,
    });
    expect(reconcileCanvasInteractionState(hydrated, ["a", "b"], "a")).toBe(
      hydrated
    );
  });

  it("retains selection across a partial shrink and follows events after a full clear", () => {
    const initial = createCanvasInteractionState(["a", "b", "c"], null);
    const selected = selectCanvasEvent(initial, "a");
    expect(selectCanvasEvent(selected, "a")).toBe(selected);
    const shrunk = reconcileCanvasInteractionState(selected, ["a"], null);

    expect(shrunk).toMatchObject({
      selectedEventId: "a",
      observedEventCount: 3,
      reloadKey: 2,
    });

    const cleared = reconcileCanvasInteractionState(shrunk, [], null);
    const repopulated = reconcileCanvasInteractionState(cleared, ["d"], null);
    expect(repopulated).toMatchObject({
      selectedEventId: "d",
      observedEventCount: 1,
      reloadKey: 4,
    });
  });

  it("moves into and out of compare in the compare-toggle transition", () => {
    const initial = setCanvasViewTab(
      createCanvasInteractionState(["a", "b"], null),
      "source"
    );
    const one = toggleCanvasComparison(initial, "a");
    const two = toggleCanvasComparison(one, "b");
    const backToOne = toggleCanvasComparison(two, "b");

    expect(one.activeTab).toBe("source");
    expect(two).toMatchObject({
      compareEventIds: ["a", "b"],
      activeTab: "compare",
    });
    expect(backToOne).toMatchObject({
      compareEventIds: ["a"],
      activeTab: "canvas",
    });
  });

  it("follows a same-slot Canvas revision and removes stale comparisons", () => {
    const initial = toggleCanvasComparison(
      toggleCanvasComparison(
        createCanvasInteractionState(["original", "other"], null),
        "original"
      ),
      "other"
    );
    const selectedOriginal = selectCanvasEvent(initial, "original");
    const revised = reconcileCanvasInteractionState(
      selectedOriginal,
      ["revision", "other"],
      "revision"
    );

    expect(revised).toMatchObject({
      selectedEventId: "revision",
      compareEventIds: ["other"],
      activeTab: "canvas",
      reloadKey: selectedOriginal.reloadKey + 1,
    });
  });

  it("suppresses the preview override while design mode locks the selection", () => {
    const designLocked = selectCanvasEvent(
      createCanvasInteractionState(["a", "b"], null),
      "a"
    );

    // Chat preview pointing at another canvas must not steal the selection
    // while design mode is active on it.
    const afterPreview = reconcileCanvasInteractionState(
      designLocked,
      ["a", "b"],
      "b",
      "a"
    );
    expect(afterPreview.selectedEventId).toBe("a");
    expect(afterPreview.reloadKey).toBe(designLocked.reloadKey);

    // Without the design lock the preview override still wins.
    const withoutLock = reconcileCanvasInteractionState(
      designLocked,
      ["a", "b"],
      "b",
      null
    );
    expect(withoutLock.selectedEventId).toBe("b");

    // A design event that no longer exists cannot hold the lock.
    const staleLock = reconcileCanvasInteractionState(
      designLocked,
      ["b"],
      "b",
      "a"
    );
    expect(staleLock.selectedEventId).toBe("b");
  });
});
