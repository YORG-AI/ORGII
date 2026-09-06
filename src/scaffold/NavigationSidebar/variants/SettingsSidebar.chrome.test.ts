import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("SettingsSidebar chrome", () => {
  it("keeps Settings search without exposing a duplicate Spotlight button", () => {
    const source = readFileSync(
      resolve(__dirname, "SettingsSidebar.tsx"),
      "utf8"
    );

    expect(source).toContain('variant="search-input"');
    expect(source).not.toContain("onAddNew=");
    expect(source).not.toContain("SidebarSearchShortcutTooltip");
  });
});
