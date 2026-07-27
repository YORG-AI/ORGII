import { describe, expect, it } from "vitest";

import { workstationLayoutAtom } from "@src/store/workstation/tabs";
import type { WorkStationTab } from "@src/store/workstation/tabs";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { closeProjectOrgWorkStationTabsAtom } from "./atoms";

function tab(id: string, orgId?: string): WorkStationTab {
  return {
    id,
    type: "project-org",
    title: id,
    data: orgId ? { orgId } : {},
  };
}

describe("closeProjectOrgWorkStationTabsAtom", () => {
  it("closes every surface for the deleted org and keeps other tabs", () => {
    const store = createInstrumentedStore();
    store.set(workstationLayoutAtom, {
      mainPane: {
        tabs: [
          tab("deleted-org", "org-deleted"),
          tab("deleted-project", "org-deleted"),
          tab("live-org", "org-live"),
          tab("unscoped"),
        ],
        activeTabId: "deleted-project",
      },
    });

    store.set(closeProjectOrgWorkStationTabsAtom, "org-deleted");

    expect(
      store.get(workstationLayoutAtom).mainPane.tabs.map((item) => item.id)
    ).toEqual(["live-org", "unscoped"]);
    expect(store.get(workstationLayoutAtom).mainPane.activeTabId).toBe(
      "live-org"
    );
  });
});
