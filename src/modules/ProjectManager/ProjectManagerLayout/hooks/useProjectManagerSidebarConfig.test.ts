import { describe, expect, it } from "vitest";

import { shouldDisableProjectManagerSidebar } from "./useProjectManagerSidebarConfig";

describe("shouldDisableProjectManagerSidebar", () => {
  it.each(["project-dashboard", "project-work-items"] as const)(
    "disables the sidebar for the %s surface",
    (type) => {
      expect(shouldDisableProjectManagerSidebar({ id: type, type }, {})).toBe(
        true
      );
    }
  );

  it("keeps the sidebar available on project detail surfaces", () => {
    expect(
      shouldDisableProjectManagerSidebar(
        { id: "project-workitems:project-1", type: "project-workitems" },
        {}
      )
    ).toBe(false);
  });
});
