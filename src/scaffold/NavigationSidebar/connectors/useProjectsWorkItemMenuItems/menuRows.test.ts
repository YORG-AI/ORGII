import { describe, expect, it } from "vitest";

import { DeliveryBox01Icon } from "@src/icons";

import { buildProjectOverviewRow, buildProjectRow } from "./menuRows";

const t = ((key: string) => key) as Parameters<typeof buildProjectRow>[0];

describe("project rows", () => {
  it("uses the same box icon for imported projects and their overviews", () => {
    const row = buildProjectRow(
      t,
      "orgii-issues",
      "ORGII issues",
      false,
      "github"
    );
    const overviewRow = buildProjectOverviewRow(
      t,
      "orgii-issues",
      "ORGII issues",
      "github"
    );

    for (const projectRow of [row, overviewRow]) {
      expect(projectRow.icon).toBe(DeliveryBox01Icon);
      expect(projectRow.iconName).toBe("box");
      expect(projectRow.iconElement).toBeUndefined();
      expect(projectRow.visualTone).toBeUndefined();
    }
  });

  it("keeps the default project icon for local projects", () => {
    const row = buildProjectRow(t, "local-project", "Local project");

    expect(row.icon).toBeDefined();
    expect(row.iconName).toBe("box");
    expect(row.iconElement).toBeUndefined();
    expect(row.visualTone).toBeUndefined();
  });
});
