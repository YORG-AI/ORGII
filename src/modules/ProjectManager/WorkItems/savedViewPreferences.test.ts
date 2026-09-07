import { describe, expect, it } from "vitest";

import {
  MAX_SAVED_VIEW_DISPLAY_PREFERENCES,
  SAVED_VIEW_DISPLAY_PREFERENCES_STORAGE_KEY,
  type SavedViewPreferenceStorage,
  getActiveSavedViewId,
  normalizeSavedViewDisplay,
  readSavedViewDisplayPreference,
  resolveSavedViewDisplay,
  setActiveSavedViewId,
  writeSavedViewDisplayPreference,
} from "./savedViewPreferences";

function memoryStorage(): SavedViewPreferenceStorage & {
  value: (key: string) => string | null;
} {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: (key) => values.get(key) ?? null,
  };
}

const scope = {
  ownerId: "member-1",
  orgId: "org-1",
  projectSlug: "desktop",
};

describe("saved view display preferences", () => {
  it("uses shared display once, then keeps the personal override", () => {
    const storage = memoryStorage();
    const seeded = resolveSavedViewDisplay(
      { viewTab: "Kanban", kanbanGroupBy: "assigned_to" },
      readSavedViewDisplayPreference(scope, "wiv_1", storage)
    );
    expect(seeded).toEqual({
      viewTab: "Kanban",
      kanbanGroupBy: "assigned_to",
    });

    writeSavedViewDisplayPreference(
      scope,
      "wiv_1",
      {
        ...seeded,
        viewTab: "Table",
        tableColumns: ["status", "priority"],
        sortBy: "priority",
        sortDirection: "desc",
      },
      storage,
      1
    );
    const reopened = resolveSavedViewDisplay(
      { viewTab: "Gantt" },
      readSavedViewDisplayPreference(scope, "wiv_1", storage)
    );
    expect(reopened).toEqual({
      viewTab: "Table",
      kanbanGroupBy: "assigned_to",
      tableColumns: ["status", "priority"],
      sortBy: "priority",
      sortDirection: "desc",
    });
  });

  it("does not inherit layout from the previously active view", () => {
    expect(resolveSavedViewDisplay({}, null)).toEqual({});
    expect(resolveSavedViewDisplay({ viewTab: "Table" }, null)).toEqual({
      viewTab: "Table",
    });
  });

  it("keeps a bounded table sort pair and drops orphan directions", () => {
    expect(
      normalizeSavedViewDisplay({
        sortBy: `  property:${"x".repeat(200)}  `,
        sortDirection: "asc",
      })
    ).toEqual({
      sortBy: `property:${"x".repeat(119)}`,
      sortDirection: "asc",
    });
    expect(normalizeSavedViewDisplay({ sortDirection: "desc" })).toEqual({});
  });

  it("isolates preferences by user and bounds retained entries", () => {
    const storage = memoryStorage();
    for (
      let index = 0;
      index < MAX_SAVED_VIEW_DISPLAY_PREFERENCES + 2;
      index++
    ) {
      writeSavedViewDisplayPreference(
        scope,
        `wiv_${index}`,
        { viewTab: "List" },
        storage,
        index
      );
    }
    const stored = JSON.parse(
      storage.value(SAVED_VIEW_DISPLAY_PREFERENCES_STORAGE_KEY) ?? "{}"
    ) as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(
      MAX_SAVED_VIEW_DISPLAY_PREFERENCES
    );
    expect(readSavedViewDisplayPreference(scope, "wiv_0", storage)).toBeNull();
    expect(
      readSavedViewDisplayPreference(
        { ...scope, ownerId: "member-2" },
        "wiv_129",
        storage
      )
    ).toBeNull();
  });

  it("keeps the active view in URL query state without dropping peers", () => {
    const search = setActiveSavedViewId("?debug=true", "wiv_1");
    expect(getActiveSavedViewId(search)).toBe("wiv_1");
    expect(new URLSearchParams(search).get("debug")).toBe("true");
    expect(setActiveSavedViewId(search, null)).toBe("?debug=true");
  });
});
