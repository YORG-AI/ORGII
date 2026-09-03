import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _getActiveContextCount,
  _resetForTests,
  acquireWebglSlot,
  onWebglSlotReleased,
  releaseWebglSlot,
} from "../webglContextManager";

const MAX_WEBGL_CONTEXTS = 8;

afterEach(() => {
  _resetForTests();
});

function fillBudget(): void {
  for (let i = 0; i < MAX_WEBGL_CONTEXTS; i++) {
    expect(acquireWebglSlot()).toBe(true);
  }
}

describe("webgl context budget", () => {
  it("refuses a slot once the budget is full", () => {
    fillBudget();

    expect(acquireWebglSlot()).toBe(false);
    expect(_getActiveContextCount()).toBe(MAX_WEBGL_CONTEXTS);
  });

  it("tells a waiting pane when a slot frees", () => {
    fillBudget();
    const waiter = vi.fn();
    onWebglSlotReleased(waiter);

    releaseWebglSlot();

    expect(waiter).toHaveBeenCalledTimes(1);
    expect(acquireWebglSlot()).toBe(true);
  });

  it("keeps notifying later waiters when an earlier one unsubscribes", () => {
    fillBudget();
    const claimed: string[] = [];
    let unsubscribeFirst = () => {};
    unsubscribeFirst = onWebglSlotReleased(() => {
      claimed.push("first");
      unsubscribeFirst();
    });
    onWebglSlotReleased(() => {
      claimed.push("second");
    });

    releaseWebglSlot();

    // The first waiter mutating the set mid-notify must not skip the second.
    expect(claimed).toEqual(["first", "second"]);
  });

  it("stops notifying a pane that unsubscribed", () => {
    fillBudget();
    const waiter = vi.fn();
    const unsubscribe = onWebglSlotReleased(waiter);

    unsubscribe();
    releaseWebglSlot();

    expect(waiter).not.toHaveBeenCalled();
  });

  it("never drives the live count below zero", () => {
    releaseWebglSlot();
    releaseWebglSlot();

    expect(_getActiveContextCount()).toBe(0);
  });
});
