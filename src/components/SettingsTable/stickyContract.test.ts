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
const tableSource = readFileSync(
  resolve(__dirname, "../Table/index.tsx"),
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

  it("lets inline search fill the space between filters and actions", () => {
    expect(settingsTableSource).toContain(
      '<div className="order-1 flex w-full min-w-0 items-center justify-end gap-2 @[640px]:order-2 @[640px]:flex-1">'
    );
    expect(settingsTableSource).toContain('<div className="min-w-0 flex-1">');
    expect(settingsTableSource).toContain('className="w-full min-w-0"');
    expect(settingsTableSource).toContain(
      'className="flex shrink-0 items-center gap-2"'
    );
  });

  it("pins the final table column on surfaces narrower than 1300px", () => {
    expect(tableStyles).toMatch(
      /@media \(max-width: 1300px\)[\s\S]*\.table-settings\.table-settings-pin-last-column[\s\S]*position:\s*sticky;[\s\S]*right:\s*0;/
    );
  });

  it("centers an empty-state component through the full table body height", () => {
    expect(tableSource).toContain(
      'tableRows.length === 0 && "table-has-empty-state"'
    );
    expect(tableStyles).toMatch(
      /\.table-settings\.table-settings-fill-height[\s\S]*&\.table-has-empty-state[\s\S]*\.table-empty[\s\S]*height:\s*100%;/
    );
  });
});
