import { describe, expect, it } from "vitest";

import { Search01Icon } from "@src/icons";

import {
  AGENT_SESSION_ACTIONS,
  ALL_SESSIONS_SEARCH_ICON,
} from "../spotlightActionDefinitions.navigation";

describe("Spotlight session search action icons", () => {
  it("distinguishes metadata search from full-text session search", () => {
    const metadataSearch = AGENT_SESSION_ACTIONS.find(
      (action) => action.id === "search-agent-sessions"
    );
    const fullTextSearch = AGENT_SESSION_ACTIONS.find(
      (action) => action.id === "search-all-sessions"
    );

    expect(metadataSearch?.icon).toBe(Search01Icon);
    // Under lucide this asserted `displayName === "DatabaseSearch"`. Hugeicons
    // icons are data, not components, so identity is asserted on the glyph's
    // actual shape: the custom database-search mark is five elements, the last
    // two being the search lens and its handle.
    expect(ALL_SESSIONS_SEARCH_ICON).toHaveLength(5);
    expect(ALL_SESSIONS_SEARCH_ICON.map(([tag]) => tag)).toEqual([
      "path",
      "path",
      "path",
      "circle",
      "path",
    ]);
    expect(fullTextSearch?.icon).toBe(ALL_SESSIONS_SEARCH_ICON);
    expect(fullTextSearch?.icon).not.toBe(metadataSearch?.icon);
  });
});
