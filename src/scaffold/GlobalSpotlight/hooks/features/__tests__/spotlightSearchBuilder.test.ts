/**
 * Spotlight search builder — "Detect update" command coverage.
 *
 * Verifies the wiring that makes the manual app-update check searchable from
 * the global palette (mirroring the Settings → General "Detect Update" button):
 *   - typing "Detect Update", "Update", or "Check for update" surfaces the item
 *   - selecting it dispatches the corresponding static action definition
 *   - unrelated queries do not surface it
 */
import { describe, expect, it, vi } from "vitest";

import { APP_ACTIONS } from "../spotlightActionDefinitions";
import { buildSearchModeItems } from "../spotlightSearchBuilder";

const DETECT_UPDATE_ID = "detect-update";
const BUILT_IN_TOOLS_DESTINATION_ID = "nav-integrations-nav-int-tools";

// Translator stub: echo the key so label-based matching is deterministic and
// independent of the loaded i18n bundle.
const echoTranslate = (key: string) => key;

function runSearch(searchQuery: string, devModeEnabled = false) {
  const onSelectStaticAction = vi.fn();
  const items = buildSearchModeItems({
    searchQuery,
    isEditorRoute: false,
    staticCommandActions: [...APP_ACTIONS],
    onSelectAction: vi.fn(),
    onSelectStaticAction,
    onSelectEditorAction: vi.fn(),
    onSelectPath: vi.fn(),
    translate: echoTranslate,
    devModeEnabled,
  });
  return { items, onSelectStaticAction };
}

describe("buildSearchModeItems — detect update command", () => {
  it("exposes a single detect-update static action definition", () => {
    expect(APP_ACTIONS).toHaveLength(1);
    expect(APP_ACTIONS[0].id).toBe(DETECT_UPDATE_ID);
    expect(APP_ACTIONS[0].closeOnSuccess).toBe(true);
  });

  it.each(["Detect Update", "update", "check for update", "upgrade"])(
    "surfaces the command for query %j",
    (query) => {
      const { items } = runSearch(query);
      expect(items.some((item) => item.id === DETECT_UPDATE_ID)).toBe(true);
    }
  );

  it("dispatches the detect-update action definition on select", () => {
    const { items, onSelectStaticAction } = runSearch("detect update");
    const item = items.find((entry) => entry.id === DETECT_UPDATE_ID);
    expect(item).toBeDefined();

    item?.action?.();
    expect(onSelectStaticAction).toHaveBeenCalledTimes(1);
    expect(onSelectStaticAction).toHaveBeenCalledWith(APP_ACTIONS[0]);
  });

  it("does not surface the command for unrelated queries", () => {
    const { items } = runSearch("zzz-no-such-command");
    expect(items.some((item) => item.id === DETECT_UPDATE_ID)).toBe(false);
  });

  it("hides the Built-in Tools destination outside dev mode", () => {
    expect(
      runSearch("tools", false).items.some(
        (item) => item.id === BUILT_IN_TOOLS_DESTINATION_ID
      )
    ).toBe(false);
    expect(
      runSearch("tools", true).items.some(
        (item) => item.id === BUILT_IN_TOOLS_DESTINATION_ID
      )
    ).toBe(true);
  });
});
