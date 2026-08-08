import { Search } from "lucide-react";
import { describe, expect, it } from "vitest";

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

    expect(metadataSearch?.icon).toBe(Search);
    expect(ALL_SESSIONS_SEARCH_ICON.displayName).toBe("DatabaseSearch");
    expect(fullTextSearch?.icon).toBe(ALL_SESSIONS_SEARCH_ICON);
    expect(fullTextSearch?.icon).not.toBe(metadataSearch?.icon);
  });
});
