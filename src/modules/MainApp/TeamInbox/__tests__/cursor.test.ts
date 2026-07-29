import { describe, expect, it } from "vitest";

import { toWireCursorItemId } from "../domain/cursor";

describe("toWireCursorItemId", () => {
  it("preserves the backend source prefix so the cursor round-trips", () => {
    // The backend returns this as the cursor item id and strips the
    // `work_item_assigned:` prefix itself; dropping it here would break paging.
    expect(toWireCursorItemId("work_item_assigned:work-1")).toBe(
      "work_item_assigned:work-1"
    );
  });

  it("strips only the UI kind prefix when a UI item key is passed", () => {
    expect(
      toWireCursorItemId("assigned_work_item:work_item_assigned:work-1")
    ).toBe("work_item_assigned:work-1");
  });

  it("leaves an unprefixed id untouched", () => {
    expect(toWireCursorItemId("work-1")).toBe("work-1");
  });
});
