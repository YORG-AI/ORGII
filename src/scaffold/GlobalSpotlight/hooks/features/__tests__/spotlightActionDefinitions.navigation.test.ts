import { describe, expect, it } from "vitest";

import { FolderGitTwoIcon, MessageAdd02Icon, Search01Icon } from "@src/icons";

import {
  AGENT_SESSION_ACTIONS,
  ALL_SESSIONS_SEARCH_ICON,
  WORKSPACE_ACTIONS,
} from "../spotlightActionDefinitions.navigation";

describe("Spotlight action icons", () => {
  it("matches the sidebar icon for the new-session action", () => {
    const newSession = AGENT_SESSION_ACTIONS.find(
      (action) => action.id === "open-session-creator"
    );

    expect(newSession?.icon).toBe(MessageAdd02Icon);
  });

  it("uses the repository glyph when switching workspaces", () => {
    const switchWorkspace = WORKSPACE_ACTIONS.find(
      (action) => action.id === "switch-workspace"
    );

    expect(switchWorkspace?.icon).toBe(FolderGitTwoIcon);
  });

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
