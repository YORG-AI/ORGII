import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settingsTableSource = readFileSync(
  resolve(__dirname, "index.tsx"),
  "utf8"
);
const tableStyles = readFileSync(
  resolve(__dirname, "../Table/index.scss"),
  "utf8"
);

describe("SettingsTable sticky toolbar contract", () => {
  it("uses one explicit sticky class for every page-scrolled toolbar", () => {
    expect(settingsTableSource).toContain(
      'containedScroll ? "shrink-0" : "settings-table-sticky-toolbar"'
    );
    expect(tableStyles).toMatch(
      /\.settings-table-sticky-toolbar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*21;/s
    );
  });

  it("does not let the rounded-border mask override sticky positioning", () => {
    const maskRule = tableStyles.match(
      /\.settings-table-sticky-mask\s*\{([\s\S]*?)&::before/
    )?.[1];

    expect(maskRule).toBeDefined();
    expect(maskRule).not.toMatch(/\bposition\s*:/);
  });

  it("sizes inline search on a flex wrapper so actions stay inside the table", () => {
    expect(settingsTableSource).toContain(
      '<div className="min-w-0 flex-1 @[640px]:w-52 @[640px]:flex-none">'
    );
    expect(settingsTableSource).toContain('className="w-full min-w-0"');
    expect(settingsTableSource).toContain(
      'className="flex shrink-0 items-center gap-2"'
    );
  });
});
