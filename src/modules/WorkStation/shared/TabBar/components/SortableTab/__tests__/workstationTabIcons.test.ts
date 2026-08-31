/**
 * Every icon NAME the workstation tab store can emit must resolve in
 * WORKSTATION_TAB_ICONS. The contract is stringly typed across files, so a
 * missing entry fails silently at runtime — the tab renders no glyph at all.
 * This happened once: the hugeicons migration left "ChartNoAxesGantt"
 * (STORY_WORK_ITEMS_TAB_ICON) out of the map and work-items tabs lost their
 * icon. The store side is scanned as source, so a new factory literal is
 * covered without having to instantiate stores.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  STORY_MANAGER_PROJECT_TAB_ICON,
  STORY_WORK_ITEMS_TAB_ICON,
  WORK_ITEM_DETAIL_TAB_ICON,
} from "@src/store/workstation/tabs/factories/project";

import { WORKSTATION_TAB_ICONS } from "../index";

const TABS_STORE_DIR = path.join(process.cwd(), "src/store/workstation/tabs");

/** PascalCase icon-name literals assigned to an `icon:` field. */
const ICON_LITERAL = /\bicon:\s*"([A-Z][A-Za-z0-9]*)"/g;

function collectLiteralIconNames(dir: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__")
        found.push(...collectLiteralIconNames(full));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts"))
      continue;
    const source = fs.readFileSync(full, "utf8");
    for (const match of source.matchAll(ICON_LITERAL)) {
      found.push([match[1], path.relative(process.cwd(), full)]);
    }
  }
  return found;
}

describe("workstation tab icon names", () => {
  it("resolves every exported *_TAB_ICON constant", () => {
    for (const name of [
      STORY_MANAGER_PROJECT_TAB_ICON,
      STORY_WORK_ITEMS_TAB_ICON,
      WORK_ITEM_DETAIL_TAB_ICON,
    ]) {
      expect(
        WORKSTATION_TAB_ICONS,
        `"${name}" is missing from WORKSTATION_TAB_ICONS`
      ).toHaveProperty(name);
    }
  });

  it("resolves every icon-name literal in the tabs store", () => {
    const names = collectLiteralIconNames(TABS_STORE_DIR);
    expect(names.length).toBeGreaterThan(0);
    const missing = names
      .filter(([name]) => !(name in WORKSTATION_TAB_ICONS))
      .map(([name, file]) => `${name} (${file})`);
    expect(missing).toEqual([]);
  });
});
