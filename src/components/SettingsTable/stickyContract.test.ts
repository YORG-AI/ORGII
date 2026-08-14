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
  it("keeps the body on the raised table surface by default", () => {
    expect(tableStyles).toMatch(
      /\.table-settings\s*\{[\s\S]*--settings-table-surface:\s*var\(--color-primary-container\);[\s\S]*--settings-table-body-surface:\s*var\(--settings-table-surface\);/
    );
    expect(tableStyles).toMatch(
      /\.table,\s*\.table-tbody\s*\{\s*background:\s*var\(--settings-table-body-surface\);/
    );
    expect(tableStyles).toMatch(
      /\.table-scroll\s*\{[\s\S]*background:\s*var\(--settings-table-body-surface\);/
    );
  });

  it("blends the body into the chat pane only for pane-body tables", () => {
    expect(tableStyles).toMatch(
      /&\.table-settings-pane-body\s*\{\s*--settings-table-body-surface:\s*var\(--color-chat-pane\);\s*\}/
    );
    expect(settingsTableSource).toContain(
      'bodySurface === "pane" && "table-settings-pane-body"'
    );
  });

  it("keeps title rows, frozen columns, and covering shades on the body surface", () => {
    expect(tableStyles).toMatch(
      /\.table-fixed-header\s*\{[\s\S]*background:\s*var\(--settings-table-body-surface\);/
    );
    expect(tableStyles).toMatch(
      /&\.table-settings-sticky-first-col\s*\{[\s\S]*background:\s*var\(--settings-table-body-surface\);/
    );
    expect(tableStyles).toMatch(
      /&\.table-settings-pin-last-column\s*\{[\s\S]*var\(--settings-table-body-surface\) 100%/
    );
  });

  it("uses the wider chat-event fade treatment for covering shades", () => {
    expect(tableStyles).toContain("--settings-table-cover-fade-size: 56px;");
    expect(tableStyles).toMatch(
      /width:\s*var\(--settings-table-cover-fade-size\);/
    );
    expect(tableStyles).toMatch(
      /color-mix\(\s*in srgb,\s*var\(--settings-table-body-surface\) 90%,\s*transparent\s*\)\s*50%/
    );
  });

  it("keeps pinned body cells above the covering shade", () => {
    expect(tableStyles).toMatch(/\.table-scroll\s*\{[^}]*z-index:\s*auto;/);
    expect(tableStyles).toMatch(/\.table-tbody\s*\{[^}]*z-index:\s*auto;/);
    expect(tableStyles).toMatch(
      /\.table-scroll \.table-row > \.table-td:first-child\s*\{[^}]*z-index:\s*3;/
    );
    expect(tableStyles).toMatch(
      /\.table-row > \.table-td:last-child\s*\{[^}]*z-index:\s*3;/
    );
  });

  it("keeps pagination on raised chrome", () => {
    expect(tableStyles).toMatch(
      /\.table-pagination-wrapper,[\s\S]*background:\s*var\(--settings-table-surface\);/
    );
  });

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
